import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { listReportDefinitions } from '../../src/modules/pharma/reporting/export-policy.js';
import * as reportRepo from '../../src/modules/pharma/reporting/report.repo.js';

/**
 * Governed pharma reporting / export.
 *
 * An export leaves the system and is rarely re-checked, so these tests attack
 * it: unauthorized principals, out-of-territory rows, forbidden columns,
 * uncapped requests, and the audit receipt a caller might hope to avoid.
 */

let app: FastifyInstance;
let clinicId: string;
let manager: TestUser;
let steward: TestUser;
let rep: TestUser;
let repOther: TestUser;
let north: { id: string };
let south: { id: string };
let hcpNorth: { id: string };
let hcpSouth: { id: string };

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'eg_moh_register', jurisdiction: 'EG' };

async function territory(code: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/territories',
    headers: auth(manager),
    payload: { code, name, country: 'EG' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function createHcp(fullName: string, territoryId: string) {
  const hcp = (
    await app.inject({
      method: 'POST',
      url: '/hcps',
      headers: auth(steward),
      payload: { fullName, professionalCategory: 'physician', provenance: PROV },
    })
  ).json();
  await app.inject({
    method: 'POST',
    url: `/territories/${territoryId}/targets`,
    headers: auth(manager),
    payload: { hcpId: hcp.id },
  });
  return hcp;
}

function runReport(user: TestUser, key: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/pharma/reports/${key}`,
    headers: auth(user),
    payload,
  });
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  manager = await makeUser(clinicId, 'mgr', RoleKey.PHARMA_MANAGER);
  steward = await makeUser(clinicId, 'stw', RoleKey.PHARMA_DATA_STEWARD);
  rep = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
  repOther = await makeUser(clinicId, 'rep2', RoleKey.PHARMA_REP);

  north = await territory('CAI-N', 'Cairo North');
  south = await territory('CAI-S', 'Cairo South');
  hcpNorth = await createHcp('Dr North Exporter', north.id);
  hcpSouth = await createHcp('Dr South Exporter', south.id);
  await app.inject({
    method: 'POST',
    url: `/territories/${north.id}/assignments`,
    headers: auth(manager),
    payload: { userId: rep.userId },
  });
  await app.inject({
    method: 'POST',
    url: `/territories/${south.id}/assignments`,
    headers: auth(manager),
    payload: { userId: repOther.userId },
  });
});

afterAll(async () => {
  if (app) await app.close();
});

describe('reporting — the catalogue', () => {
  it('lists every registered report with its governance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pharma/reports',
      headers: auth(manager),
    });
    expect(res.statusCode).toBe(200);
    const reports = res.json().reports;
    expect(reports).toHaveLength(listReportDefinitions().length);
    for (const report of reports) {
      expect(report.permission).toBeTruthy();
      expect(report.maxRows).toBeGreaterThan(0);
      expect(report.columns.length).toBeGreaterThan(0);
    }
  });

  it('every registered report has a working implementation', async () => {
    // Guards against a definition being added to the registry without a query.
    for (const definition of listReportDefinitions()) {
      const res = await runReport(manager, definition.key);
      expect(res.statusCode, definition.key).toBe(200);
    }
  });

  it('an unknown report is not found, never improvised', async () => {
    expect((await runReport(manager, 'everything')).statusCode).toBe(404);
  });
});

describe('reporting — authorization', () => {
  it('a field representative cannot export at all (no pharma:export)', async () => {
    // A rep may READ an HCP on screen but may not extract the directory.
    const read = await app.inject({ method: 'GET', url: '/hcps', headers: auth(rep) });
    expect(read.statusCode).toBe(200);

    const exported = await runReport(rep, 'hcp_directory');
    expect(exported.statusCode).toBe(403);
    expect(exported.json().error.message).toMatch(/pharma:export/);
  });

  it('a rep cannot even see the report catalogue', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pharma/reports',
      headers: auth(rep),
    });
    expect(res.statusCode).toBe(403);
  });

  it('a clinical role cannot reach any reporting endpoint', async () => {
    const doctor = await makeUser(clinicId, 'doc', RoleKey.DOCTOR);
    expect((await app.inject({ method: 'GET', url: '/pharma/reports', headers: auth(doctor) })).statusCode).toBe(403);
    expect((await runReport(doctor, 'hcp_directory')).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/pharma/reports/export-log', headers: auth(doctor) }))
        .statusCode,
    ).toBe(403);
  });

  it('requires the report’s own permission, not just pharma:export', async () => {
    // MEDICAL_AFFAIRS holds no visit:read, so field activity is refused even
    // though the principal is otherwise a legitimate pharma user.
    const affairs = await makeUser(clinicId, 'ma', RoleKey.MEDICAL_AFFAIRS);
    const res = await runReport(affairs, 'field_activity');
    expect(res.statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: '/pharma/reports/hcp_directory' });
    expect(res.statusCode).toBe(401);
  });
});

describe('reporting — territory scope', () => {
  it('a clinic-wide principal sees every territory', async () => {
    const res = await runReport(manager, 'hcp_directory');
    const names = res.json().rows.map((r: { fullName: string }) => r.fullName);
    expect(names).toContain('Dr North Exporter');
    expect(names).toContain('Dr South Exporter');
  });

  it('tenant isolation: another clinic’s data never appears', async () => {
    const other = await makeClinic('Other Clinic');
    const otherManager = await makeUser(other.clinicId, 'mgr2', RoleKey.PHARMA_MANAGER);
    const res = await runReport(otherManager, 'hcp_directory');
    expect(res.json().rows).toEqual([]);
  });

  it('an EMPTY territory scope exports nothing, not everything', async () => {
    // The dangerous failure mode is an empty scope being read as "no filter".
    // No role today is both territory-scoped and export-capable, so this is
    // asserted directly against the query layer rather than through a role that
    // cannot reach it — the guard has to hold for whoever acquires that
    // combination next.
    for (const query of [
      reportRepo.hcpDirectory(clinicId, [], 100),
      reportRepo.hcoDirectory(clinicId, [], 100),
      reportRepo.fieldActivity(clinicId, [], {}, 100),
      reportRepo.contentUsage(clinicId, [], {}, 100),
      reportRepo.intelligenceSignals(clinicId, [], {}, 100),
    ]) {
      expect(await query).toEqual([]);
    }

    // …and a non-empty scope for a territory with data does return rows, so the
    // empty case above is a real guard rather than a query that never works.
    expect(await reportRepo.hcpDirectory(clinicId, [north.id], 100)).toHaveLength(1);
  });
});

describe('reporting — HCO directory', () => {
  async function makeHcoWithSite(name: string, territoryId: string | null) {
    const hco = (
      await app.inject({
        method: 'POST',
        url: '/hcos',
        headers: auth(steward),
        payload: { name, country: 'EG', provenance: PROV },
      })
    ).json();
    if (territoryId) {
      await app.inject({
        method: 'POST',
        url: `/hcos/${hco.id}/locations`,
        headers: auth(steward),
        payload: { label: 'Main', country: 'EG', territoryId, provenance: PROV },
      });
    }
    return hco;
  }

  it('a clinic-wide principal sees every organisation, with derived verification', async () => {
    await makeHcoWithSite('North Hospital', north.id);
    await makeHcoWithSite('South Hospital', south.id);
    const res = await runReport(manager, 'hco_directory');
    expect(res.statusCode).toBe(200);
    const names = res.json().rows.map((r: { name: string }) => r.name).sort();
    expect(names).toEqual(['North Hospital', 'South Hospital']);
    for (const row of res.json().rows) expect(row.verificationStatus).toBe('unverified');
  });

  it('scopes to organisations with a site in the caller’s territory', async () => {
    await makeHcoWithSite('North Hospital', north.id);
    await makeHcoWithSite('South Hospital', south.id);
    // Directly at the query layer, because no role is both territory-scoped and
    // export-capable (same reason the HCP directory scope is tested this way).
    const northOnly = await reportRepo.hcoDirectory(clinicId, [north.id], 100);
    expect(northOnly.map((r) => r.name)).toEqual(['North Hospital']);
  });

  it('an organisation with no sited location is clinic-wide-only, never in a scoped view', async () => {
    await makeHcoWithSite('Unsited Hospital', null);
    expect(await reportRepo.hcoDirectory(clinicId, [north.id], 100)).toEqual([]);
    expect((await reportRepo.hcoDirectory(clinicId, null, 100)).map((r) => r.name)).toContain(
      'Unsited Hospital',
    );
  });

  it('excludes a merged organisation, as the HCP directory excludes merged HCPs', async () => {
    const survivor = await makeHcoWithSite('Survivor Hospital', north.id);
    const loser = await makeHcoWithSite('Duplicate Hospital', north.id);
    await app.inject({
      method: 'POST',
      url: `/hcos/${loser.id}/merge`,
      headers: auth(steward),
      payload: { survivorHcoId: survivor.id, reason: 'duplicate facility licence' },
    });
    const names = (await runReport(steward, 'hco_directory')).json().rows.map(
      (r: { name: string }) => r.name,
    );
    expect(names).toContain('Survivor Hospital');
    expect(names).not.toContain('Duplicate Hospital');
  });

  it('requires HCO read AND export permission', async () => {
    // A rep has hco:read but not pharma:export.
    expect((await runReport(rep, 'hco_directory')).statusCode).toBe(403);
    // A steward has both.
    expect((await runReport(steward, 'hco_directory')).statusCode).toBe(200);
  });

  it('tenant isolation: another clinic’s organisations never appear', async () => {
    await makeHcoWithSite('Home Hospital', north.id);
    const other = await makeClinic('Other HCO Clinic');
    const otherManager = await makeUser(other.clinicId, 'mgr3', RoleKey.PHARMA_MANAGER);
    expect((await runReport(otherManager, 'hco_directory')).json().rows).toEqual([]);
  });

  it('writes an export receipt, and the receipt carries no organisation names', async () => {
    await makeHcoWithSite('Receipt Hospital', north.id);
    await runReport(steward, 'hco_directory');
    const log = await app.inject({
      method: 'GET',
      url: '/pharma/reports/export-log',
      headers: auth(steward),
    });
    const entry = log.json().exports.find((e: { reportKey: string }) => e.reportKey === 'hco_directory');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain('Receipt Hospital');
  });
});

describe('reporting — column allow-list', () => {
  it('emits exactly the declared columns and nothing else', async () => {
    const res = await runReport(manager, 'hcp_directory');
    const definition = listReportDefinitions().find((d) => d.key === 'hcp_directory')!;
    for (const row of res.json().rows) {
      expect(Object.keys(row).sort()).toEqual([...definition.columns].sort());
    }
  });

  it('no report response contains a patient-shaped field name', async () => {
    for (const definition of listReportDefinitions()) {
      const body = (await runReport(manager, definition.key)).body;
      for (const forbidden of ['patientId', 'patient_name', '"mrn"', 'encounterId', 'diagnosis']) {
        expect(body, `${definition.key} leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('an aggregate export never carries an exact cohort size', async () => {
    const res = await runReport(manager, 'intelligence_signals');
    expect(res.body).not.toContain('cohortSize');
    const definition = listReportDefinitions().find((d) => d.key === 'intelligence_signals')!;
    expect(definition.columns).toContain('cohortBand');
    expect(definition.columns).not.toContain('cohortSize');
  });
});

describe('reporting — row caps and truncation', () => {
  it('clamps a request above the cap rather than honouring it', async () => {
    const res = await runReport(manager, 'hcp_directory', { limit: 999_999 });
    expect(res.statusCode).toBe(400); // schema bounds reject an absurd limit
  });

  it('honours a smaller limit and reports truncation honestly', async () => {
    const res = await runReport(manager, 'hcp_directory', { limit: 1 });
    expect(res.json().rowCount).toBe(1);
    expect(res.json().truncated).toBe(true);
    expect(res.json().rowLimit).toBe(1);
  });

  it('does not claim truncation when the result fits', async () => {
    const res = await runReport(manager, 'hcp_directory', { limit: 50 });
    expect(res.json().truncated).toBe(false);
  });
});

describe('reporting — CSV output', () => {
  it('returns CSV with a header and an attachment disposition', async () => {
    const res = await runReport(manager, 'hcp_directory', { format: 'csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="hcp_directory\.csv"/);
    const [header] = res.body.split('\r\n');
    expect(header).toContain('hcpId');
    expect(header).not.toContain('patient');
  });
});

describe('reporting — the audit receipt', () => {
  it('records every export before the rows are returned', async () => {
    await runReport(manager, 'hcp_directory', { limit: 5 });
    const { rows } = await getPool().query<{
      report_key: string;
      data_class: string;
      format: string;
      row_count: number;
      truncated: boolean;
      actor_id: string;
    }>('SELECT * FROM pharma_export_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      report_key: 'hcp_directory',
      data_class: 'hcp_professional',
      format: 'json',
      actor_id: manager.userId,
    });
  });

  it('the receipt carries filter shape and counts, never row content', async () => {
    await runReport(manager, 'hcp_directory');
    const { rows } = await getPool().query<Record<string, unknown>>(
      'SELECT * FROM pharma_export_log LIMIT 1',
    );
    const entry = JSON.stringify(rows[0]);
    expect(entry).not.toContain('Dr North Exporter');
    expect(entry).not.toContain('Dr South Exporter');
  });

  it('the receipt cannot be erased by the principal who created it', async () => {
    await runReport(manager, 'hcp_directory');
    await expect(getPool().query('DELETE FROM pharma_export_log')).rejects.toThrow(/append-only/);
    await expect(
      getPool().query(`UPDATE pharma_export_log SET row_count = 0`),
    ).rejects.toThrow(/append-only/);
  });

  it('a refused export writes no receipt', async () => {
    await runReport(rep, 'hcp_directory');
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM pharma_export_log');
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('exposes the receipt trail to an operator', async () => {
    await runReport(manager, 'hcp_directory');
    const res = await app.inject({
      method: 'GET',
      url: '/pharma/reports/export-log',
      headers: auth(manager),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().exports[0]).toMatchObject({ reportKey: 'hcp_directory', format: 'json' });
  });
});

describe('reporting — input validation', () => {
  it('refuses an inverted date range', async () => {
    const res = await runReport(manager, 'field_activity', { from: '2026-12-31', to: '2026-01-01' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a malformed jurisdiction', async () => {
    const res = await runReport(manager, 'intelligence_signals', { jurisdiction: 'Egypt' });
    expect(res.statusCode).toBe(400);
  });
});
