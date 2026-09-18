import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * HCO 360 — the authorized single view of an organisation.
 *
 * Two properties matter more than the shape of the response:
 *  1. it is TERRITORY-SCOPED on its people, so an organisation cannot be used as
 *     a side door onto HCPs a representative's territory does not cover;
 *  2. it contains NOTHING clinical, by construction (§45).
 */

let app: FastifyInstance;
let clinicId: string;
let steward: TestUser;
let manager: TestUser;
let repNorth: TestUser;
let repNowhere: TestUser;

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'eg_moh_facility_register', jurisdiction: 'EG' };

let hcoId: string;
let departmentId: string;
let northTerritoryId: string;
let northHcpId: string;
let southHcpId: string;

async function post(url: string, user: TestUser, payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url, headers: auth(user), payload });
  if (res.statusCode >= 400) {
    throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
  }
  return res.json();
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  steward = await makeUser(clinicId, '360-steward', RoleKey.PHARMA_DATA_STEWARD);
  manager = await makeUser(clinicId, '360-manager', RoleKey.PHARMA_MANAGER);
  repNorth = await makeUser(clinicId, '360-rep-north', RoleKey.PHARMA_REP);
  repNowhere = await makeUser(clinicId, '360-rep-none', RoleKey.PHARMA_REP);

  const hco = await post('/hcos', steward, {
    name: 'Nile Teaching Hospital',
    country: 'EG',
    ownershipType: 'university',
    provenance: PROV,
  });
  hcoId = hco.id;

  const location = await post(`/hcos/${hcoId}/locations`, steward, {
    label: 'Main campus',
    country: 'EG',
    isPrimary: true,
    provenance: PROV,
  });
  const department = await post(`/hcos/${hcoId}/departments`, steward, {
    name: 'Cardiology',
    hcoLocationId: location.id,
    provenance: PROV,
  });
  departmentId = department.id;

  const north = await post('/territories', manager, { code: 'N', name: 'North', country: 'EG' });
  northTerritoryId = north.id;
  await post(`/territories/${northTerritoryId}/assignments`, manager, { userId: repNorth.userId });

  const northHcp = await post('/hcps', steward, {
    fullName: 'Dr North Cardiologist',
    professionalCategory: 'physician',
    provenance: PROV,
  });
  northHcpId = northHcp.id;
  const southHcp = await post('/hcps', steward, {
    fullName: 'Dr South Cardiologist',
    professionalCategory: 'physician',
    provenance: PROV,
  });
  southHcpId = southHcp.id;

  await post(`/territories/${northTerritoryId}/targets`, manager, { hcpId: northHcpId });

  for (const hcpId of [northHcpId, southHcpId]) {
    await post(`/hcps/${hcpId}/affiliations`, steward, {
      hcoId,
      hcoDepartmentId: departmentId,
      affiliationType: 'primary',
      source: 'field_rep',
    });
  }
});

afterAll(async () => {
  if (app) await app.close();
});

describe('HCO 360 — composition', () => {
  it('assembles the organisational picture in one authorized read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/hcos/${hcoId}/360`,
      headers: auth(steward),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hco.name).toBe('Nile Teaching Hospital');
    expect(body.locations).toHaveLength(1);
    expect(body.departments).toHaveLength(1);
    expect(body.affiliatedHcps).toHaveLength(2);
    expect(body.masterDataHistory.length).toBeGreaterThan(0);
    expect(body.dataBoundary).toContain('No patient-level data');
  });

  it('resolves the GOVERNED department name on each affiliation', async () => {
    const body = (
      await app.inject({ method: 'GET', url: `/hcos/${hcoId}/360`, headers: auth(steward) })
    ).json();
    expect(body.affiliatedHcps[0].departmentId).toBe(departmentId);
    expect(body.affiliatedHcps[0].departmentName).toBe('Cardiology');
  });

  it('is not found for another clinic’s organisation', async () => {
    const other = await makeClinic('Other 360 Clinic');
    const otherSteward = await makeUser(other.clinicId, 'o360', RoleKey.PHARMA_DATA_STEWARD);
    const res = await app.inject({
      method: 'GET',
      url: `/hcos/${hcoId}/360`,
      headers: auth(otherSteward),
    });
    expect(res.statusCode).toBe(404);
  });

  it('audits the read', async () => {
    await app.inject({ method: 'GET', url: `/hcos/${hcoId}/360`, headers: auth(steward) });
    const { rows } = await getPool().query(
      `SELECT 1 FROM audit_log WHERE action = 'hco.360.read' AND target_id = $1`,
      [hcoId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('HCO 360 — territory scope is a second authorization dimension', () => {
  it('a clinic-wide steward sees every affiliated professional', async () => {
    const body = (
      await app.inject({ method: 'GET', url: `/hcos/${hcoId}/360`, headers: auth(steward) })
    ).json();
    expect(body.scopedToTerritories).toBeNull();
    expect(body.affiliatedHcps.map((h: { hcpId: string }) => h.hcpId).sort()).toEqual(
      [northHcpId, southHcpId].sort(),
    );
  });

  it('a representative sees only the professionals their territory targets', async () => {
    const body = (
      await app.inject({ method: 'GET', url: `/hcos/${hcoId}/360`, headers: auth(repNorth) })
    ).json();
    expect(body.scopedToTerritories).toEqual([northTerritoryId]);
    expect(body.affiliatedHcps).toHaveLength(1);
    expect(body.affiliatedHcps[0].hcpId).toBe(northHcpId);
  });

  it('a representative with NO territory sees no professionals, not all of them', async () => {
    const body = (
      await app.inject({ method: 'GET', url: `/hcos/${hcoId}/360`, headers: auth(repNowhere) })
    ).json();
    expect(body.scopedToTerritories).toEqual([]);
    expect(body.affiliatedHcps).toEqual([]);
    expect(body.specialtyCoverage).toEqual([]);
  });

  it('says whether the view was scoped, so a short list is not mistaken for a small hospital', async () => {
    const wide = (
      await app.inject({ method: 'GET', url: `/hcos/${hcoId}/360`, headers: auth(steward) })
    ).json();
    const scoped = (
      await app.inject({ method: 'GET', url: `/hcos/${hcoId}/360`, headers: auth(repNorth) })
    ).json();
    expect(wide.scopedToTerritories).toBeNull();
    expect(scoped.scopedToTerritories).not.toBeNull();
  });

  it('an expired territory assignment stops granting access', async () => {
    await getPool().query(
      `UPDATE territory_assignment
          SET valid_from = current_date - 10, valid_to = current_date - 1
        WHERE user_id = $1`,
      [repNorth.userId],
    );
    const body = (
      await app.inject({ method: 'GET', url: `/hcos/${hcoId}/360`, headers: auth(repNorth) })
    ).json();
    expect(body.affiliatedHcps).toEqual([]);
  });
});

describe('HCO 360 — the clinical firewall', () => {
  it('no response field is patient-shaped', async () => {
    const body = (
      await app.inject({ method: 'GET', url: `/hcos/${hcoId}/360`, headers: auth(steward) })
    ).json();
    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['patientid', 'patient_id', 'encounterid', 'encounter_id', 'mrn', 'diagnosis']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('no HCO statement reads, writes or joins a clinical table', async () => {
    const files = [
      'src/modules/hcp/hco.repo.ts',
      'src/modules/hcp/hco.service.ts',
      'src/http/routes/hco.routes.ts',
      'src/db/migrations/0307_hco_master.sql',
      'src/db/migrations/0308_hco_locations.sql',
    ];
    // Prose may DISCUSS the boundary ("no patient-level data participates");
    // what must not exist is a statement that actually touches a clinical
    // table. Matching on the SQL keyword that precedes a table name is what
    // makes this test about behaviour rather than about vocabulary.
    const clinicalAccess =
      /\b(from|join|into|update|delete\s+from|references)\s+"?(patient|encounter|observation|prescription|allergy|allergy_intolerance|vital_sign|diagnosis|clinical_document)\b/i;
    for (const file of files) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      expect(clinicalAccess.test(source), `${file} touches a clinical table`).toBe(false);
    }
  });

  it('a clinical role cannot reach any organisation endpoint', async () => {
    const doctor = await makeUser(clinicId, '360-doctor', RoleKey.DOCTOR);
    for (const url of [`/hcos`, `/hcos/${hcoId}`, `/hcos/${hcoId}/360`]) {
      const res = await app.inject({ method: 'GET', url, headers: auth(doctor) });
      expect(res.statusCode, url).toBe(403);
    }
  });
});
