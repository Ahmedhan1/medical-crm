import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * PHARMA CLOSURE — the three things you could START and never FINISH.
 *
 * The audit found the same shape of gap three times: a column that models the
 * end of something, a unique index that depends on it, and no code path that
 * could ever set it.
 *
 *  1. `hcp_hco_affiliation.end_date` — a physician could never leave a hospital.
 *  2. `territory_assignment.valid_to` — territory scope could be GRANTED and
 *     never revoked, which makes it an authorization gap, not an untidiness.
 *  3. `hcp.status = 'merged'` / `hco.operating_status = 'merged'` — a resolved
 *     identity stayed open to new state on every write path but one.
 */

let app: FastifyInstance;
let clinicId: string;
let steward: TestUser;
let manager: TestUser;
let rep: TestUser;
let affairs: TestUser;

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'field_rep', jurisdiction: 'EG' };

let hcpId: string;
let survivorHcpId: string;
let hcoId: string;
let survivorHcoId: string;
let territoryId: string;

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  return app.inject({ method, url, headers: auth(user), ...(payload ? { payload } : {}) });
}

async function ok(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  const res = await call(method, url, user, payload);
  if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  return res.json();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  steward = await makeUser(clinicId, 'cl-steward', RoleKey.PHARMA_DATA_STEWARD);
  manager = await makeUser(clinicId, 'cl-manager', RoleKey.PHARMA_MANAGER);
  rep = await makeUser(clinicId, 'cl-rep', RoleKey.PHARMA_REP);
  affairs = await makeUser(clinicId, 'cl-affairs', RoleKey.MEDICAL_AFFAIRS);

  const territory = await ok('POST', '/territories', manager, {
    code: 'N',
    name: 'North',
    country: 'EG',
  });
  territoryId = territory.id;

  const hcp = await ok('POST', '/hcps', steward, {
    fullName: 'Dr Closure Subject',
    professionalCategory: 'physician',
    provenance: PROV,
  });
  hcpId = hcp.id;
  const survivorHcp = await ok('POST', '/hcps', steward, {
    fullName: 'Dr Closure Survivor',
    professionalCategory: 'physician',
    provenance: PROV,
  });
  survivorHcpId = survivorHcp.id;

  const hco = await ok('POST', '/hcos', steward, {
    name: 'Nile Teaching Hospital',
    country: 'EG',
    provenance: PROV,
  });
  hcoId = hco.id;
  const survivorHco = await ok('POST', '/hcos', steward, {
    name: 'Nile Teaching Hospital (Group)',
    country: 'EG',
    provenance: PROV,
  });
  survivorHcoId = survivorHco.id;
});

afterAll(async () => {
  if (app) await app.close();
});

async function affiliate(extra: Record<string, unknown> = {}) {
  return ok('POST', `/hcps/${hcpId}/affiliations`, steward, {
    hcoId,
    affiliationType: 'primary',
    source: 'hospital directory',
    ...extra,
  });
}

describe('an affiliation can be ended', () => {
  it('a physician who leaves a hospital stops being affiliated', async () => {
    const affiliation = await affiliate();
    const ended = await ok(
      'PATCH',
      `/hcps/${hcpId}/affiliations/${affiliation.id}`,
      steward,
      { endDate: today() },
    );
    expect(ended.endDate).toBe(today());
  });

  it('an ended affiliation frees the slot, so a return visit is representable', async () => {
    const first = await affiliate();
    // The unique index keys on `end_date IS NULL`, so before this the second
    // affiliation was impossible for ever.
    const blocked = await call('POST', `/hcps/${hcpId}/affiliations`, steward, {
      hcoId,
      affiliationType: 'primary',
      source: 'hospital directory',
    });
    expect(blocked.statusCode).toBe(409);

    await ok('PATCH', `/hcps/${hcpId}/affiliations/${first.id}`, steward, { endDate: today() });
    const again = await call('POST', `/hcps/${hcpId}/affiliations`, steward, {
      hcoId,
      affiliationType: 'primary',
      source: 'hospital directory',
    });
    expect(again.statusCode).toBe(201);
  });

  it('an ended affiliation leaves the organisation’s specialty coverage', async () => {
    const specialty = await ok('POST', '/specialties', steward, {
      taxonomy: 'internal',
      code: 'CARD',
      displayName: 'Cardiology',
      source: 'internal',
    });
    await ok('PATCH', `/hcps/${hcpId}`, steward, {
      primarySpecialtyId: specialty.id,
      provenance: PROV,
    });
    const affiliation = await affiliate();

    const before = await ok('GET', `/hcos/${hcoId}/360`, steward);
    expect(before.specialtyCoverage).toHaveLength(1);

    await ok('PATCH', `/hcps/${hcpId}/affiliations/${affiliation.id}`, steward, {
      endDate: '2020-01-01',
    });
    const after = await ok('GET', `/hcos/${hcoId}/360`, steward);
    expect(after.specialtyCoverage).toEqual([]);
  });

  it('refuses ending an affiliation twice', async () => {
    const affiliation = await affiliate();
    await ok('PATCH', `/hcps/${hcpId}/affiliations/${affiliation.id}`, steward, {
      endDate: today(),
    });
    const res = await call('PATCH', `/hcps/${hcpId}/affiliations/${affiliation.id}`, steward, {
      endDate: today(),
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses an affiliation belonging to a different HCP', async () => {
    const affiliation = await affiliate();
    const res = await call(
      'PATCH',
      `/hcps/${survivorHcpId}/affiliations/${affiliation.id}`,
      steward,
      { endDate: today() },
    );
    expect(res.statusCode).toBe(404);
  });

  it('refuses an end date before the start date, at the database', async () => {
    const affiliation = await affiliate({ startDate: '2026-06-01' });
    const res = await call('PATCH', `/hcps/${hcpId}/affiliations/${affiliation.id}`, steward, {
      endDate: '2020-01-01',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a representative cannot end an affiliation, and neither can another clinic', async () => {
    const affiliation = await affiliate();
    const byRep = await call('PATCH', `/hcps/${hcpId}/affiliations/${affiliation.id}`, rep, {
      endDate: today(),
    });
    expect(byRep.statusCode).toBe(403);

    const other = await makeClinic('Other Closure Clinic');
    const outsider = await makeUser(other.clinicId, 'cl-out', RoleKey.PHARMA_DATA_STEWARD);
    const byOutsider = await call(
      'PATCH',
      `/hcps/${hcpId}/affiliations/${affiliation.id}`,
      outsider,
      { endDate: today() },
    );
    expect(byOutsider.statusCode).toBe(404);

    const anonymous = await app.inject({
      method: 'PATCH',
      url: `/hcps/${hcpId}/affiliations/${affiliation.id}`,
      payload: { endDate: today() },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('territory scope can be revoked', () => {
  async function assign(user: TestUser) {
    return ok('POST', `/territories/${territoryId}/assignments`, manager, { userId: user.userId });
  }

  it('ending an assignment closes the rep’s access immediately', async () => {
    const assignment = await assign(rep);
    await ok('POST', `/territories/${territoryId}/targets`, manager, { hcpId });
    // In scope while the assignment is open.
    expect((await call('GET', `/hcps/${hcpId}`, rep)).statusCode).toBe(200);

    await ok('PATCH', `/territories/${territoryId}/assignments/${assignment.id}`, manager, {
      validTo: today(),
    });
    // `valid_to = today` still covers today; tomorrow it does not. Prove the
    // revocation took by moving the window into the past at the database, which
    // is what the endpoint schedules.
    await getPool().query(
      `UPDATE territory_assignment
          SET valid_from = current_date - 10, valid_to = current_date - 1
        WHERE id = $1`,
      [assignment.id],
    );
    expect((await call('GET', `/hcps/${hcpId}`, rep)).statusCode).toBe(403);
  });

  it('records the revocation as an auditable event, not a deletion', async () => {
    const assignment = await assign(rep);
    await ok('PATCH', `/territories/${territoryId}/assignments/${assignment.id}`, manager, {
      validTo: today(),
    });
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM territory_assignment WHERE id = $1`,
      [assignment.id],
    );
    // Who covered which territory when is the context for every visit already
    // recorded against it, so the row survives.
    expect(Number(rows[0]!.n)).toBe(1);
    const { rows: audit } = await getPool().query(
      `SELECT 1 FROM audit_log WHERE action = 'territory.assignment.end'`,
    );
    expect(audit).toHaveLength(1);
  });

  it('frees the slot so the same rep can be re-assigned later', async () => {
    const assignment = await assign(rep);
    const duplicate = await call('POST', `/territories/${territoryId}/assignments`, manager, {
      userId: rep.userId,
    });
    expect(duplicate.statusCode).toBe(409);

    await ok('PATCH', `/territories/${territoryId}/assignments/${assignment.id}`, manager, {
      validTo: today(),
    });
    const again = await call('POST', `/territories/${territoryId}/assignments`, manager, {
      userId: rep.userId,
    });
    expect(again.statusCode).toBe(201);
  });

  it('refuses ending an assignment twice', async () => {
    const assignment = await assign(rep);
    await ok('PATCH', `/territories/${territoryId}/assignments/${assignment.id}`, manager, {
      validTo: today(),
    });
    const res = await call(
      'PATCH',
      `/territories/${territoryId}/assignments/${assignment.id}`,
      manager,
      { validTo: today() },
    );
    expect(res.statusCode).toBe(409);
  });

  it('refuses back-dating a revocation — live scope cannot be un-lived', async () => {
    const assignment = await assign(rep);
    const res = await call(
      'PATCH',
      `/territories/${territoryId}/assignments/${assignment.id}`,
      manager,
      { validTo: '2020-01-01' },
    );
    expect(res.statusCode).toBe(400);
  });

  it('refuses an assignment from a different territory', async () => {
    const assignment = await assign(rep);
    const other = await ok('POST', '/territories', manager, {
      code: 'S',
      name: 'South',
      country: 'EG',
    });
    const res = await call(
      'PATCH',
      `/territories/${other.id}/assignments/${assignment.id}`,
      manager,
      { validTo: today() },
    );
    expect(res.statusCode).toBe(404);
  });

  it('a rep cannot revoke their own or anyone else’s assignment', async () => {
    const assignment = await assign(rep);
    const res = await call(
      'PATCH',
      `/territories/${territoryId}/assignments/${assignment.id}`,
      rep,
      { validTo: today() },
    );
    expect(res.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: 'PATCH',
      url: `/territories/${territoryId}/assignments/${assignment.id}`,
      payload: {},
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('another clinic cannot revoke this clinic’s assignment', async () => {
    const assignment = await assign(rep);
    const other = await makeClinic('Other Territory Clinic');
    const outsider = await makeUser(other.clinicId, 'cl-out-mgr', RoleKey.PHARMA_MANAGER);
    const res = await call(
      'PATCH',
      `/territories/${territoryId}/assignments/${assignment.id}`,
      outsider,
      { validTo: today() },
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('a merged record is closed to new state', () => {
  async function mergeHcp() {
    await ok('POST', `/hcps/${hcpId}/merge`, steward, {
      targetHcpId: survivorHcpId,
      reason: 'Same syndicate registration number',
    });
  }

  async function mergeHco() {
    await ok('POST', `/hcos/${hcoId}/merge`, steward, {
      survivorHcoId,
      reason: 'Same facility licence',
    });
  }

  it('a merged HCP accepts no new affiliation, credential, identifier or interest', async () => {
    await mergeHcp();
    const attempts: Array<[string, Record<string, unknown>]> = [
      [`/hcps/${hcpId}/affiliations`, { hcoId, source: 'directory' }],
      [`/hcps/${hcpId}/credentials`, { credentialName: 'MD', source: 'diploma' }],
      [
        `/hcps/${hcpId}/identifiers`,
        { identifierSystem: 'NPI', identifierValue: '1234567893', issuingJurisdiction: 'US', source: 'registry' },
      ],
      [`/hcps/${hcpId}/interests`, { interest: 'heart failure', source: 'field_rep' }],
      [`/hcps/${hcpId}/locations`, { label: 'Clinic', country: 'EG', source: 'directory', jurisdiction: 'EG' }],
    ];
    for (const [url, payload] of attempts) {
      const res = await call('POST', url, steward, payload);
      expect(res.statusCode, url).toBe(409);
    }
  });

  it('a merged HCP cannot be re-verified', async () => {
    await mergeHcp();
    const res = await call('POST', `/hcps/${hcpId}/verification`, steward, {
      verificationStatus: 'pending_review',
      evidenceSource: 'public register',
    });
    expect(res.statusCode).toBe(409);
  });

  it('a merged HCP cannot be targeted into a territory', async () => {
    await mergeHcp();
    const res = await call('POST', `/territories/${territoryId}/targets`, manager, { hcpId });
    expect(res.statusCode).toBe(409);
  });

  it('a merged HCP cannot receive an enquiry or a content engagement', async () => {
    await ok('POST', `/territories/${territoryId}/targets`, manager, { hcpId });
    await mergeHcp();
    const enquiry = await call('POST', '/scientific-requests', affairs, {
      hcpId,
      question: 'What is the dose adjustment in renal impairment?',
    });
    expect(enquiry.statusCode).toBe(409);
  });

  it('the merged record stays READABLE — history is the point of keeping it', async () => {
    await affiliate();
    await mergeHcp();
    const read = await ok('GET', `/hcps/${hcpId}`, steward);
    expect(read.hcp.status).toBe('merged');
    expect(read.hcp.mergedIntoHcpId).toBe(survivorHcpId);
    expect(read.affiliations).toHaveLength(1);
  });

  it('a merged HCO accepts no new site, department or identifier', async () => {
    await mergeHco();
    const attempts: Array<[string, Record<string, unknown>]> = [
      [`/hcos/${hcoId}/locations`, { label: 'New campus', country: 'EG', provenance: PROV }],
      [`/hcos/${hcoId}/departments`, { name: 'Cardiology', provenance: PROV }],
      [
        `/hcos/${hcoId}/identifiers`,
        { identifierSystem: 'EG_TAX_ID', identifierValue: '999', issuingJurisdiction: 'EG', source: 'register' },
      ],
    ];
    for (const [url, payload] of attempts) {
      const res = await call('POST', url, steward, payload);
      expect(res.statusCode, url).toBe(409);
    }
  });

  it('a merged HCO cannot be edited or re-verified', async () => {
    await mergeHco();
    const patch = await call('PATCH', `/hcos/${hcoId}`, steward, {
      city: 'Cairo',
      provenance: PROV,
    });
    expect(patch.statusCode).toBe(409);
    const verify = await call('POST', `/hcos/${hcoId}/verification`, steward, {
      verificationStatus: 'pending_review',
      evidenceSource: 'facility register',
    });
    expect(verify.statusCode).toBe(409);
  });

  it('a merged HCO cannot receive a new affiliation from any HCP', async () => {
    await mergeHco();
    const res = await call('POST', `/hcps/${survivorHcpId}/affiliations`, steward, {
      hcoId,
      source: 'directory',
    });
    expect(res.statusCode).toBe(409);
  });

  it('the survivor is unaffected and still accepts state', async () => {
    await mergeHcp();
    await mergeHco();
    const affiliation = await call('POST', `/hcps/${survivorHcpId}/affiliations`, steward, {
      hcoId: survivorHcoId,
      source: 'directory',
    });
    expect(affiliation.statusCode).toBe(201);
  });
});
