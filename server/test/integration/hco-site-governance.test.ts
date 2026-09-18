import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * HCO SITE AND DEPARTMENT GOVERNANCE (migration 0313).
 *
 * 0308 gave sites and departments provenance, the eight-state verification
 * vocabulary and an operating status, then made them write-once: no update, no
 * verification decision, no history. These tests pin the capability that closes
 * that gap, and the rules it has to obey — the SAME rules the organisation and
 * the HCP master already obey, not a second set.
 */

let app: FastifyInstance;
let clinicId: string;
let steward: TestUser;
let rep: TestUser;
let manager: TestUser;

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'eg_moh_facility_register', jurisdiction: 'EG' };

let hcoId: string;
let locationId: string;
let departmentId: string;

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

function decideLocation(payload: Record<string, unknown>, as: TestUser = steward) {
  return call('POST', `/hco-locations/${locationId}/verification`, as, {
    evidenceSource: 'Site visit, EG MOH facility register',
    ...payload,
  });
}

function decideDepartment(payload: Record<string, unknown>, as: TestUser = steward) {
  return call('POST', `/hco-departments/${departmentId}/verification`, as, {
    evidenceSource: 'Hospital organogram',
    ...payload,
  });
}

async function verifyLocationThroughReview(validForDays?: number) {
  await decideLocation({ verificationStatus: 'pending_review' });
  return decideLocation({
    verificationStatus: 'verified',
    ...(validForDays !== undefined ? { validForDays } : {}),
  });
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  steward = await makeUser(clinicId, 'site-steward', RoleKey.PHARMA_DATA_STEWARD);
  rep = await makeUser(clinicId, 'site-rep', RoleKey.PHARMA_REP);
  manager = await makeUser(clinicId, 'site-manager', RoleKey.PHARMA_MANAGER);

  const hco = await ok('POST', '/hcos', steward, {
    name: 'Nile Teaching Hospital',
    country: 'EG',
    provenance: PROV,
  });
  hcoId = hco.id;
  const location = await ok('POST', `/hcos/${hcoId}/locations`, steward, {
    label: 'Main campus',
    country: 'EG',
    city: 'Cairo',
    isPrimary: true,
    provenance: PROV,
  });
  locationId = location.id;
  const department = await ok('POST', `/hcos/${hcoId}/departments`, steward, {
    name: 'Cardiology',
    hcoLocationId: locationId,
    provenance: PROV,
  });
  departmentId = department.id;
});

afterAll(async () => {
  if (app) await app.close();
});

describe('sites are correctable records, not write-once rows', () => {
  it('a site that moved can be corrected, and the change is versioned', async () => {
    const updated = await ok('PATCH', `/hco-locations/${locationId}`, steward, {
      addressLine: '12 Corniche el Nil',
      city: 'Giza',
      provenance: PROV,
    });
    expect(updated.city).toBe('Giza');
    expect(updated.recordVersion).toBe(2);
  });

  it('a site that closed can say so', async () => {
    const updated = await ok('PATCH', `/hco-locations/${locationId}`, steward, {
      operatingStatus: 'closed',
      provenance: PROV,
    });
    expect(updated.operatingStatus).toBe('closed');
  });

  it('a site cannot be declared merged — it has no survivor to point at', async () => {
    const res = await call('PATCH', `/hco-locations/${locationId}`, steward, {
      operatingStatus: 'merged',
      provenance: PROV,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an update that would change nothing', async () => {
    const res = await call('PATCH', `/hco-locations/${locationId}`, steward, {
      label: 'Main campus',
      provenance: PROV,
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a territory from another clinic', async () => {
    const other = await makeClinic('Other Site Clinic');
    const otherManager = await makeUser(other.clinicId, 'o-mgr', RoleKey.PHARMA_MANAGER);
    const foreign = await ok('POST', '/territories', otherManager, {
      code: 'X',
      name: 'Foreign',
      country: 'EG',
    });
    const res = await call('PATCH', `/hco-locations/${locationId}`, steward, {
      territoryId: foreign.id,
      provenance: PROV,
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a label carrying a patient identifier', async () => {
    const res = await call('PATCH', `/hco-locations/${locationId}`, steward, {
      label: 'Ward for MRN-000123',
      provenance: PROV,
    });
    expect(res.statusCode).toBe(400);
  });

  it('records the edit in an append-only history', async () => {
    await ok('PATCH', `/hco-locations/${locationId}`, steward, {
      city: 'Giza',
      provenance: PROV,
    });
    const history = await ok('GET', `/hco-locations/${locationId}/history`, steward);
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0].changedFields).toContain('city');
    await expect(
      getPool().query(`DELETE FROM hco_location_revision WHERE hco_location_id = $1`, [locationId]),
    ).rejects.toThrow();
    await expect(
      getPool().query(
        `UPDATE hco_location_revision SET change_type = 'verify' WHERE hco_location_id = $1`,
        [locationId],
      ),
    ).rejects.toThrow();
  });
});

describe('departments are correctable too', () => {
  it('a renamed department keeps its identity and gains a version', async () => {
    const updated = await ok('PATCH', `/hco-departments/${departmentId}`, steward, {
      name: 'Cardiology and Vascular Medicine',
      provenance: PROV,
    });
    expect(updated.id).toBe(departmentId);
    expect(updated.recordVersion).toBe(2);
  });

  it('refuses a rename that collides with another department at the same site', async () => {
    await ok('POST', `/hcos/${hcoId}/departments`, steward, {
      name: 'Neurology',
      hcoLocationId: locationId,
      provenance: PROV,
    });
    const res = await call('PATCH', `/hco-departments/${departmentId}`, steward, {
      name: 'neurology',
      provenance: PROV,
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a move to another organisation’s site', async () => {
    const otherHco = await ok('POST', '/hcos', steward, {
      name: 'Other Hospital',
      country: 'EG',
      provenance: PROV,
    });
    const foreignSite = await ok('POST', `/hcos/${otherHco.id}/locations`, steward, {
      label: 'Other campus',
      country: 'EG',
      provenance: PROV,
    });
    const res = await call('PATCH', `/hco-departments/${departmentId}`, steward, {
      hcoLocationId: foreignSite.id,
      provenance: PROV,
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a specialty from another clinic', async () => {
    const other = await makeClinic('Other Specialty Clinic');
    const otherSteward = await makeUser(other.clinicId, 'o-stw', RoleKey.PHARMA_DATA_STEWARD);
    const foreign = await ok('POST', '/specialties', otherSteward, {
      taxonomy: 'internal',
      code: 'CARD',
      displayName: 'Cardiology',
      source: 'internal',
    });
    const res = await call('PATCH', `/hco-departments/${departmentId}`, steward, {
      specialtyId: foreign.id,
      provenance: PROV,
    });
    expect(res.statusCode).toBe(404);
  });

  it('records the edit in an append-only history', async () => {
    await ok('PATCH', `/hco-departments/${departmentId}`, steward, {
      operatingStatus: 'suspended',
      provenance: PROV,
    });
    const history = await ok('GET', `/hco-departments/${departmentId}/history`, steward);
    expect(history.revisions[0].changedFields).toContain('operatingStatus');
    await expect(
      getPool().query(`DELETE FROM hco_department_revision WHERE hco_department_id = $1`, [
        departmentId,
      ]),
    ).rejects.toThrow();
  });
});

describe('site and department verification', () => {
  it('nothing reaches verified without passing through review', async () => {
    const res = await decideLocation({ verificationStatus: 'verified' });
    expect(res.statusCode).toBe(409);
  });

  it('review then verify records the evidence and an expiry', async () => {
    const res = await verifyLocationThroughReview();
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance.verificationStatus).toBe('verified');
    expect(res.json().provenance.lastVerifiedAt).not.toBeNull();
    expect(res.json().verificationExpiresAt).not.toBeNull();
  });

  it('a department can be verified through the same path', async () => {
    await decideDepartment({ verificationStatus: 'pending_review' });
    const res = await decideDepartment({ verificationStatus: 'verified' });
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance.verificationStatus).toBe('verified');
  });

  it('a refusal without a reason is rejected', async () => {
    await decideLocation({ verificationStatus: 'pending_review' });
    const bare = await decideLocation({ verificationStatus: 'rejected' });
    expect(bare.statusCode).toBe(400);
    const withReason = await decideLocation({
      verificationStatus: 'rejected',
      note: 'Address does not match the facility register',
    });
    expect(withReason.statusCode).toBe(200);
    expect(withReason.json().verificationNote).toContain('facility register');
  });

  it('a caller cannot simply declare a site expired', async () => {
    const res = await decideLocation({ verificationStatus: 'expired' });
    expect(res.statusCode).toBe(400);
  });

  it('a material change sends a verified site back to review', async () => {
    await verifyLocationThroughReview();
    const updated = await ok('PATCH', `/hco-locations/${locationId}`, steward, {
      city: 'Giza',
      provenance: PROV,
    });
    expect(updated.provenance.verificationStatus).toBe('pending_review');
  });

  it('a material change sends a verified department back to review', async () => {
    await decideDepartment({ verificationStatus: 'pending_review' });
    await decideDepartment({ verificationStatus: 'verified' });
    const updated = await ok('PATCH', `/hco-departments/${departmentId}`, steward, {
      name: 'Cardiothoracic Surgery',
      provenance: PROV,
    });
    expect(updated.provenance.verificationStatus).toBe('pending_review');
  });

  it('expiry is DERIVED: a lapsed site reads as expired before any sweep', async () => {
    await verifyLocationThroughReview();
    await getPool().query(
      `UPDATE hco_location SET verification_expires_at = now() - interval '1 day' WHERE id = $1`,
      [locationId],
    );
    const site = await ok('GET', `/hcos/${hcoId}/locations`, steward);
    expect(site.locations[0].provenance.verificationStatus).toBe('expired');
  });

  it('the sweep covers organisations, sites and departments, and is idempotent', async () => {
    await verifyLocationThroughReview();
    await decideDepartment({ verificationStatus: 'pending_review' });
    await decideDepartment({ verificationStatus: 'verified' });
    await getPool().query(
      `UPDATE hco_location SET verification_expires_at = now() - interval '1 day' WHERE id = $1`,
      [locationId],
    );
    await getPool().query(
      `UPDATE hco_department SET verification_expires_at = now() - interval '1 day' WHERE id = $1`,
      [departmentId],
    );

    const first = await ok('POST', '/hcos/verification/sweep', steward, {});
    expect(first.locations).toBe(1);
    expect(first.departments).toBe(1);
    expect(first.expired).toBe(2);

    const second = await ok('POST', '/hcos/verification/sweep', steward, {});
    expect(second.expired).toBe(0);

    const history = await ok('GET', `/hco-locations/${locationId}/history`, steward);
    const lapse = history.revisions.find(
      (r: { changeType: string }) => r.changeType === 'verification_expired',
    );
    expect(lapse).toBeDefined();
    // The system observed a lapse; no human decided it.
    expect(lapse.changedBy).toBeNull();
  });

  it('the database refuses an unexplained refusal written directly', async () => {
    await expect(
      getPool().query(
        `UPDATE hco_location SET verification_status = 'rejected', verification_note = NULL
          WHERE id = $1`,
        [locationId],
      ),
    ).rejects.toThrow();
  });
});

describe('site and department governance — authorization', () => {
  it('a representative can read but cannot correct or verify', async () => {
    const read = await call('GET', `/hco-locations/${locationId}/history`, rep);
    expect(read.statusCode).toBe(200);
    const patch = await call('PATCH', `/hco-locations/${locationId}`, rep, {
      city: 'Giza',
      provenance: PROV,
    });
    expect(patch.statusCode).toBe(403);
    const verify = await decideLocation({ verificationStatus: 'pending_review' }, rep);
    expect(verify.statusCode).toBe(403);
  });

  it('a pharma manager may not verify master data either', async () => {
    const res = await decideDepartment({ verificationStatus: 'pending_review' }, manager);
    expect(res.statusCode).toBe(403);
  });

  it('a clinical role cannot reach any of it', async () => {
    const doctor = await makeUser(clinicId, 'site-doctor', RoleKey.DOCTOR);
    for (const url of [
      `/hco-locations/${locationId}/history`,
      `/hco-departments/${departmentId}/history`,
    ]) {
      const res = await call('GET', url, doctor);
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('tenant isolation: another clinic’s site is not found', async () => {
    const other = await makeClinic('Isolated Site Clinic');
    const outsider = await makeUser(other.clinicId, 'iso-stw', RoleKey.PHARMA_DATA_STEWARD);
    // Each payload is valid FOR ITS OWN endpoint, so a 404 here is the tenant
    // check refusing and not a schema rejecting a mis-shaped body.
    for (const [method, url, payload] of [
      ['GET', `/hco-locations/${locationId}/history`, {}],
      ['PATCH', `/hco-locations/${locationId}`, { city: 'Giza', provenance: PROV }],
      ['GET', `/hco-departments/${departmentId}/history`, {}],
      ['PATCH', `/hco-departments/${departmentId}`, { name: 'Renamed', provenance: PROV }],
    ] as const) {
      const res = await call(method, url, outsider, payload);
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('every site and department endpoint requires authentication', async () => {
    for (const [method, url] of [
      ['PATCH', `/hco-locations/${locationId}`],
      ['POST', `/hco-locations/${locationId}/verification`],
      ['GET', `/hco-locations/${locationId}/history`],
      ['PATCH', `/hco-departments/${departmentId}`],
      ['POST', `/hco-departments/${departmentId}/verification`],
      ['GET', `/hco-departments/${departmentId}/history`],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
