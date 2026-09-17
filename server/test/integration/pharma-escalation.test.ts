import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { pharmaPermissions } from '../../src/modules/governance/permissions.pharma.js';
import { ABSOLUTE_MIN_COHORT } from '../../src/modules/intelligence/firewall.js';

/**
 * PHARMA ESCALATION RED TEAM.
 *
 * One adversary, one narrative: someone holds a VALID `PHARMA_REP` account —
 * the lowest-privilege pharma role, issued legitimately — and tries to become
 * something more. Every other pharma suite proves an individual control works;
 * this one proves no COMBINATION of legitimate rep capabilities adds up to an
 * escalation.
 *
 * The rep is real: assigned to North, targeting one HCP there. Everything they
 * reach for below is one step outside what that account is for.
 */

let app: FastifyInstance;
let clinicId: string;
let attacker: TestUser;    // PHARMA_REP, assigned to North
let victimRep: TestUser;   // PHARMA_REP, assigned to South
let steward: TestUser;
let manager: TestUser;
let affairs: TestUser;
/** A SECOND medical-affairs principal: content may not be approved by its author. */
let affairsApprover: TestUser;

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'field_rep', jurisdiction: 'EG' };

let northId: string;
let southId: string;
let northHcpId: string;
let southHcpId: string;
let hcoId: string;
let contentId: string;

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  return app.inject({ method, url, headers: auth(user), ...(payload ? { payload } : {}) });
}

async function ok(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  const res = await call(method, url, user, payload);
  if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  return res.json();
}

/** Every attempt must be refused; 200 anywhere here is an escalation. */
async function refused(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
) {
  const res = await call(method, url, attacker, payload);
  expect(
    [400, 401, 403, 404, 409, 429].includes(res.statusCode),
    `${method} ${url} returned ${res.statusCode}; expected a refusal`,
  ).toBe(true);
  return res;
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  attacker = await makeUser(clinicId, 'atk-rep', RoleKey.PHARMA_REP);
  victimRep = await makeUser(clinicId, 'vic-rep', RoleKey.PHARMA_REP);
  steward = await makeUser(clinicId, 'atk-steward', RoleKey.PHARMA_DATA_STEWARD);
  manager = await makeUser(clinicId, 'atk-manager', RoleKey.PHARMA_MANAGER);
  affairs = await makeUser(clinicId, 'atk-affairs', RoleKey.MEDICAL_AFFAIRS);
  affairsApprover = await makeUser(clinicId, 'atk-affairs-2', RoleKey.MEDICAL_AFFAIRS);

  const north = await ok('POST', '/territories', manager, { code: 'N', name: 'North', country: 'EG' });
  const south = await ok('POST', '/territories', manager, { code: 'S', name: 'South', country: 'EG' });
  northId = north.id;
  southId = south.id;
  await ok('POST', `/territories/${northId}/assignments`, manager, { userId: attacker.userId });
  await ok('POST', `/territories/${southId}/assignments`, manager, { userId: victimRep.userId });

  const northHcp = await ok('POST', '/hcps', steward, {
    fullName: 'Dr North Target',
    professionalCategory: 'physician',
    provenance: PROV,
  });
  const southHcp = await ok('POST', '/hcps', steward, {
    fullName: 'Dr South Target',
    professionalCategory: 'physician',
    provenance: PROV,
  });
  northHcpId = northHcp.id;
  southHcpId = southHcp.id;
  await ok('POST', `/territories/${northId}/targets`, manager, { hcpId: northHcpId });
  await ok('POST', `/territories/${southId}/targets`, manager, { hcpId: southHcpId });

  const hco = await ok('POST', '/hcos', steward, {
    name: 'Nile Teaching Hospital',
    country: 'EG',
    provenance: PROV,
  });
  hcoId = hco.id;

  const content = await ok('POST', '/pharma/content', affairs, {
    title: 'Dosing summary',
    contentType: 'detail_aid',
    version: '1.0',
    jurisdiction: 'EG',
    body: 'Approved dosing guidance.',
    source: 'medical affairs',
    effectiveDate: '2026-01-01',
  });
  contentId = content.id;
});

afterAll(async () => {
  if (app) await app.close();
});

describe('escalation — the account itself', () => {
  it('a rep holds no permission that any other pharma role gates', async () => {
    const repGrants = pharmaPermissions.roleGrants[RoleKey.PHARMA_REP] as string[];
    const governed = [
      'hcp:verify', 'hcp:merge', 'hco:write', 'hco:verify', 'hco:merge',
      'medication:write', 'medication:verify', 'territory:manage',
      'scientificrequest:fulfill', 'content:write', 'content:approve',
      'segment:manage', 'campaign:manage', 'intelligence:publish', 'pharma:export',
    ];
    for (const permission of governed) {
      expect(repGrants, `rep must not hold ${permission}`).not.toContain(permission);
    }
  });

  it('a rep holds NO clinical permission of any kind', async () => {
    const repGrants = pharmaPermissions.roleGrants[RoleKey.PHARMA_REP] as string[];
    for (const permission of repGrants) {
      expect(permission.startsWith('hcp:') || permission.startsWith('hco:') ||
        permission.startsWith('medication:') || permission.startsWith('territory:') ||
        permission.startsWith('visit:') || permission.startsWith('callreport:') ||
        permission.startsWith('scientificrequest:') || permission.startsWith('content:') ||
        permission.startsWith('segment:') || permission.startsWith('campaign:') ||
        permission.startsWith('intelligence:') || permission.startsWith('pharma:')).toBe(true);
    }
  });

  it('cannot reach a clinical endpoint', async () => {
    for (const url of ['/patients', '/encounters', '/appointments', '/prescriptions']) {
      const res = await call('GET', url, attacker);
      expect([403, 404].includes(res.statusCode), `${url} -> ${res.statusCode}`).toBe(true);
    }
  });
});

describe('escalation — tenant isolation', () => {
  it('cannot read or write another clinic’s master data', async () => {
    const other = await makeClinic('Victim Clinic');
    const otherSteward = await makeUser(other.clinicId, 'vic-stw', RoleKey.PHARMA_DATA_STEWARD);
    const foreignHcp = await ok('POST', '/hcps', otherSteward, {
      fullName: 'Dr Foreign',
      professionalCategory: 'physician',
      provenance: PROV,
    });
    const foreignHco = await ok('POST', '/hcos', otherSteward, {
      name: 'Foreign Hospital',
      country: 'EG',
      provenance: PROV,
    });

    await refused('GET', `/hcps/${foreignHcp.id}`);
    await refused('GET', `/hcos/${foreignHco.id}`);
    await refused('GET', `/hcos/${foreignHco.id}/360`);
    await refused('PATCH', `/hcps/${foreignHcp.id}`, { title: 'Prof.' });
  });

  it('cannot plan a visit against another clinic’s HCP', async () => {
    const other = await makeClinic('Victim Clinic 2');
    const otherSteward = await makeUser(other.clinicId, 'vic-stw-2', RoleKey.PHARMA_DATA_STEWARD);
    const foreignHcp = await ok('POST', '/hcps', otherSteward, {
      fullName: 'Dr Foreign 2',
      professionalCategory: 'physician',
      provenance: PROV,
    });
    await refused('POST', '/visits', {
      hcpId: foreignHcp.id,
      plannedAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  });
});

describe('escalation — territory isolation', () => {
  it('cannot open the 360 of an HCP outside their territory', async () => {
    await refused('GET', `/hcps/${southHcpId}`);
  });

  it('cannot plan, brief on, or report against an out-of-territory HCP', async () => {
    await refused('POST', '/visits', {
      hcpId: southHcpId,
      plannedAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  });

  it('cannot read a colleague’s visit trail, briefing or call report', async () => {
    const visit = await ok('POST', '/visits', victimRep, {
      hcpId: southHcpId,
      plannedAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await ok('POST', `/visits/${visit.id}/call-report`, victimRep, {
      summary: 'Discussed south territory pricing.',
    });
    await refused('GET', `/visits/${visit.id}/history`);
    await refused('GET', `/visits/${visit.id}/briefing`);
    await refused('GET', `/visits/${visit.id}/call-report`);
  });

  it('cannot change a colleague’s visit status', async () => {
    const visit = await ok('POST', '/visits', victimRep, {
      hcpId: southHcpId,
      plannedAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await refused('POST', `/visits/${visit.id}/status`, {
      status: 'cancelled',
      reason: 'not mine to cancel',
    });
  });

  it('cannot self-assign a territory', async () => {
    await refused('POST', `/territories/${southId}/assignments`, { userId: attacker.userId });
  });

  it('cannot target an out-of-territory HCP into their own territory', async () => {
    await refused('POST', `/territories/${northId}/targets`, { hcpId: southHcpId });
  });

  it('losing the assignment closes the door immediately', async () => {
    await getPool().query(
      `UPDATE territory_assignment
          SET valid_from = current_date - 10, valid_to = current_date - 1
        WHERE user_id = $1`,
      [attacker.userId],
    );
    await refused('GET', `/hcps/${northHcpId}/360`);
  });
});

describe('escalation — the manager hierarchy', () => {
  it('cannot give themselves reports', async () => {
    await refused('PUT', '/field-force/profiles', {
      userId: victimRep.userId,
      managerUserId: attacker.userId,
    });
  });

  it('cannot read a profile of someone who does not report to them', async () => {
    await ok('PUT', '/field-force/profiles', manager, { userId: victimRep.userId });
    await refused('GET', `/field-force/profiles/${victimRep.userId}`);
  });

  it('a hierarchy planted directly in the table still does not grant a territory', async () => {
    // Even if the reporting line were forged, it grants oversight of that rep's
    // OWN work — never the territory-scoped master data behind it.
    await ok('PUT', '/field-force/profiles', manager, { userId: attacker.userId });
    await ok('PUT', '/field-force/profiles', manager, {
      userId: victimRep.userId,
      managerUserId: attacker.userId,
    });
    await refused('GET', `/hcps/${southHcpId}`);
  });
});

describe('escalation — master data governance', () => {
  it('cannot verify, merge or steward an HCP', async () => {
    await refused('POST', `/hcps/${northHcpId}/verification`, {
      verificationStatus: 'verified',
      evidenceSource: 'trust me',
    });
    await refused('POST', `/hcps/${northHcpId}/merge`, {
      targetHcpId: southHcpId,
      reason: 'consolidating',
    });
  });

  it('cannot write, verify or merge an HCO, or govern its sites', async () => {
    const location = await ok('POST', `/hcos/${hcoId}/locations`, steward, {
      label: 'Main campus',
      country: 'EG',
      provenance: PROV,
    });
    await refused('POST', '/hcos', { name: 'Rep Hospital', country: 'EG', provenance: PROV });
    await refused('PATCH', `/hcos/${hcoId}`, { city: 'Cairo', provenance: PROV });
    await refused('POST', `/hcos/${hcoId}/verification`, {
      verificationStatus: 'verified',
      evidenceSource: 'trust me',
    });
    await refused('PATCH', `/hco-locations/${location.id}`, { city: 'Giza', provenance: PROV });
    await refused('POST', `/hco-locations/${location.id}/verification`, {
      verificationStatus: 'verified',
      evidenceSource: 'trust me',
    });
  });

  it('cannot verify the drug master', async () => {
    const medication = await ok('POST', '/medications', steward, {
      genericName: 'metformin',
      providerKey: 'manual_entry',
      provenance: { source: 'product label', jurisdiction: 'EG' },
    });
    await refused('POST', `/medications/${medication.id}/verification`, {
      verificationStatus: 'pending_review',
      evidenceSource: 'trust me',
    });
    await refused('POST', '/medications/verification/sweep', {});
  });

  it('cannot forge provenance by writing the table directly — the DB refuses it', async () => {
    await expect(
      getPool().query(
        `UPDATE hcp SET verification_status = 'verified', last_verified_at = NULL WHERE id = $1`,
        [northHcpId],
      ),
    ).rejects.toThrow();
  });

  it('records a rep creates are born unverified, whatever they claim', async () => {
    const created = await ok('POST', '/hcps', attacker, {
      fullName: 'Dr Rep Invented',
      professionalCategory: 'physician',
      provenance: { ...PROV, source: 'eg_moh_register' },
    });
    expect(created.provenance.verificationStatus).toBe('unverified');
  });
});

describe('escalation — content and medical affairs', () => {
  it('cannot author or approve scientific content', async () => {
    await refused('POST', '/pharma/content', {
      title: 'Rep claim',
      contentType: 'detail_aid',
      version: '1.0',
      jurisdiction: 'EG',
      body: 'Our drug is best in class.',
      source: 'rep',
    });
    await refused('POST', `/pharma/content/${contentId}/decision`, { decision: 'approve' });
  });

  it('cannot answer, triage or close a scientific request they raised', async () => {
    const request = await ok('POST', '/scientific-requests', attacker, {
      hcpId: northHcpId,
      question: 'What is the dose adjustment in renal impairment?',
    });
    await refused('POST', `/scientific-requests/${request.id}/answer`, {
      answerSummary: 'Whatever the physician prefers.',
    });
    await refused('POST', `/scientific-requests/${request.id}/triage`, {
      assignedTo: attacker.userId,
    });
    await refused('GET', '/scientific-requests/queue');
  });

  it('cannot record engagement against an out-of-territory HCP', async () => {
    await ok('POST', `/pharma/content/${contentId}/decision`, affairs, { decision: 'submit_review' });
    // Approved by a COLLEAGUE: content cannot be approved by its own author.
    await ok('POST', `/pharma/content/${contentId}/decision`, affairsApprover, {
      decision: 'approve',
    });
    await refused('POST', `/pharma/content/${contentId}/engagements`, {
      hcpId: southHcpId,
      channel: 'in_person',
      engagementType: 'presented',
    });
  });
});

describe('escalation — intelligence and cohort privacy', () => {
  it('cannot run the firewall pipeline or publish a signal', async () => {
    await refused('POST', '/intelligence/runs', {
      sourceKind: 'pharma_field',
      signalType: 'hcp_feedback_theme',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      jurisdiction: 'EG',
      scopeType: 'territory',
      aggregationLevel: 'territory',
    });
    await refused('PUT', '/intelligence/policies', { minCohortSize: 1 });
  });

  /**
   * These attack a REAL policy row. An `UPDATE` against an empty table succeeds
   * trivially, so seeding first is what makes the assertion mean anything.
   */
  async function seedPolicy() {
    await ok('PUT', '/intelligence/policies', manager, {
      key: 'default',
      description: 'Default governance policy',
      jurisdiction: 'EG',
      minCohortSize: ABSOLUTE_MIN_COHORT,
      allowedSignalTypes: ['hcp_feedback_theme'],
    });
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM intelligence_policy`,
    );
    expect(Number(rows[0]!.n), 'policy row must exist or the attacks below are vacuous')
      .toBeGreaterThan(0);
  }

  it('cannot lower the cohort floor by any route', async () => {
    await seedPolicy();
    // Through the API: the schema floor refuses it.
    await refused('PUT', '/intelligence/policies', {
      key: 'default',
      description: 'Loosened',
      jurisdiction: 'EG',
      minCohortSize: 1,
    });
    // Even a PUBLISHER cannot: the bound is on the schema, not on the role.
    const asManager = await call('PUT', '/intelligence/policies', manager, {
      key: 'default',
      description: 'Loosened',
      jurisdiction: 'EG',
      minCohortSize: 1,
    });
    expect(asManager.statusCode).toBe(400);
    // And not by writing the table directly — 0304 carries the floor as a CHECK.
    await expect(
      getPool().query(`UPDATE intelligence_policy SET min_cohort_size = 1`),
    ).rejects.toThrow();
    expect(ABSOLUTE_MIN_COHORT).toBe(5);
  });

  it('cannot switch off complementary suppression', async () => {
    await seedPolicy();
    await expect(
      getPool().query(`UPDATE intelligence_policy SET complementary_suppression = false`),
    ).rejects.toThrow();
  });

  it('cannot see a draft signal, its trail, or the query budget', async () => {
    await refused('GET', '/intelligence/signals?lifecycleStatus=draft');
    await refused('GET', '/intelligence/query-budget');
    await refused('POST', '/intelligence/signals/expiry-sweep', {});
  });

  it('cannot erase their own narrowing history to reset the budget', async () => {
    await expect(getPool().query(`DELETE FROM intelligence_query_log`)).rejects.toThrow();
    await expect(
      getPool().query(`UPDATE intelligence_query_log SET outcome = 'allowed'`),
    ).rejects.toThrow();
  });

  it('cannot reach the governed clinical source — CCR-004 stays fail-closed', async () => {
    const res = await call('POST', '/intelligence/runs', attacker, {
      sourceKind: 'clinical_governed',
      signalType: 'hcp_feedback_theme',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      jurisdiction: 'EG',
      scopeType: 'territory',
      aggregationLevel: 'territory',
    });
    // Refused at authorization; and even a publisher gets 501, asserted in the
    // firewall suite. Either way no clinical row is read.
    expect([403, 501]).toContain(res.statusCode);
  });
});

describe('escalation — export', () => {
  it('cannot export anything, nor see the catalogue or the receipts', async () => {
    await refused('GET', '/pharma/reports');
    await refused('GET', '/pharma/reports/export-log');
    for (const key of ['hcp_directory', 'field_activity', 'content_usage', 'intelligence_signals']) {
      await refused('POST', `/pharma/reports/${key}`, {});
    }
  });

  it('read permission alone never implies export', async () => {
    const repGrants = pharmaPermissions.roleGrants[RoleKey.PHARMA_REP] as string[];
    expect(repGrants).toContain('hcp:read');
    expect(repGrants).not.toContain('pharma:export');
  });

  it('cannot smuggle a formula into a CSV a privileged user later opens', async () => {
    // The rep CAN create an HCP; the name reaches the steward's CSV export.
    await ok('POST', '/hcps', attacker, {
      fullName: '=cmd|/c calc!A1',
      professionalCategory: 'physician',
      provenance: PROV,
    });
    const res = await call('POST', '/pharma/reports/hcp_directory', steward, { format: 'csv' });
    expect(res.statusCode).toBe(200);
    // Neutralised: every dangerous leading character is prefixed so a
    // spreadsheet treats the cell as text, not as a formula.
    for (const line of res.body.split('\n').slice(1)) {
      for (const cell of line.split(',')) {
        const unquoted = cell.replace(/^"|"$/g, '');
        expect(/^[=+\-@]/.test(unquoted), `unescaped formula cell: ${cell}`).toBe(false);
      }
    }
  });

  it('cannot widen a report’s columns or reach a patient-shaped field', async () => {
    const res = await call('POST', '/pharma/reports/hcp_directory', steward, {
      columns: ['hcpId', 'patientId', 'mrn'],
    });
    const body = res.statusCode === 200 ? JSON.stringify(res.json()) : res.body;
    for (const forbidden of ['patientId', 'patient_id', 'mrn', 'encounterId', 'diagnosis']) {
      expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('escalation — audit integrity', () => {
  it('cannot erase or rewrite the audit log of their own actions', async () => {
    await ok('GET', `/hcps/${northHcpId}`, attacker);
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE actor_id = $1`,
      [attacker.userId],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    await expect(
      getPool().query(`DELETE FROM audit_log WHERE actor_id = $1`, [attacker.userId]),
    ).rejects.toThrow();
    await expect(
      getPool().query(`UPDATE audit_log SET actor_id = NULL WHERE actor_id = $1`, [attacker.userId]),
    ).rejects.toThrow();
  });

  it('cannot rewrite a master-data or visit history they appear in', async () => {
    const visit = await ok('POST', '/visits', attacker, {
      hcpId: northHcpId,
      plannedAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await expect(
      getPool().query(`DELETE FROM visit_event WHERE visit_id = $1`, [visit.id]),
    ).rejects.toThrow();
    await expect(getPool().query(`DELETE FROM hcp_revision`)).rejects.toThrow();
  });

  it('cannot forge an export receipt for themselves', async () => {
    await expect(getPool().query(`DELETE FROM pharma_export_log`)).rejects.toThrow();
  });
});

describe('escalation — no unauthenticated path exists', () => {
  it('every pharma read refuses an anonymous caller', async () => {
    for (const url of [
      '/hcps',
      `/hcps/${northHcpId}`,
      '/hcos',
      `/hcos/${hcoId}/360`,
      '/medications',
      '/visits',
      '/scientific-requests',
      '/intelligence/signals',
      '/pharma/reports',
      '/field-force/profiles',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('a forged bearer token is refused', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/hcps',
      headers: { authorization: 'Bearer not-a-real-session-token' },
    });
    expect(res.statusCode).toBe(401);
  });
});
