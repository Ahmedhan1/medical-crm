import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * HCO MASTER + LOCATIONS/DEPARTMENTS + HCO 360 (migrations 0307 / 0308).
 *
 * The organisation side of the master must obey the same rules as the HCP side:
 * mandatory provenance, nothing born verified, every change versioned, refusals
 * evidenced, and a 360 view that never touches a clinical table.
 */

let app: FastifyInstance;
let clinicId: string;
let steward: TestUser;
let rep: TestUser;
let affairs: TestUser;

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'eg_moh_facility_register', jurisdiction: 'EG', sourceDate: '2026-01-15' };

async function createHco(overrides: Record<string, unknown> = {}, as: TestUser = steward) {
  return app.inject({
    method: 'POST',
    url: '/hcos',
    headers: auth(as),
    payload: { name: 'Nile Teaching Hospital', country: 'EG', provenance: PROV, ...overrides },
  });
}

function decide(hcoId: string, payload: Record<string, unknown>, as: TestUser = steward) {
  return app.inject({
    method: 'POST',
    url: `/hcos/${hcoId}/verification`,
    headers: auth(as),
    payload: { evidenceSource: 'EG MOH facility register', ...payload },
  });
}

async function verifyThroughReview(hcoId: string, validForDays?: number) {
  await decide(hcoId, { verificationStatus: 'pending_review' });
  return decide(hcoId, {
    verificationStatus: 'verified',
    ...(validForDays !== undefined ? { validForDays } : {}),
  });
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  steward = await makeUser(clinicId, 'hco-steward', RoleKey.PHARMA_DATA_STEWARD);
  rep = await makeUser(clinicId, 'hco-rep', RoleKey.PHARMA_REP);
  affairs = await makeUser(clinicId, 'hco-affairs', RoleKey.MEDICAL_AFFAIRS);
});

afterAll(async () => {
  if (app) await app.close();
});

describe('HCO master — identity and provenance', () => {
  it('creates an organisation with mandatory provenance', async () => {
    const res = await createHco();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.provenance.source).toBe('eg_moh_facility_register');
    expect(body.provenance.jurisdiction).toBe('EG');
    expect(body.provenance.sourceDate).toBe('2026-01-15');
  });

  it('refuses an organisation with no provenance', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hcos',
      headers: auth(steward),
      payload: { name: 'Anonymous Clinic', country: 'EG' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not invent an ownership type — an unasked question reads "unknown"', async () => {
    const res = await createHco();
    expect(res.json().ownershipType).toBe('unknown');
  });

  it('records ownership and operating status when they are stated', async () => {
    const res = await createHco({ ownershipType: 'university' });
    expect(res.json().ownershipType).toBe('university');
    expect(res.json().operatingStatus).toBe('active');
  });

  it('nothing is born verified', async () => {
    const res = await createHco();
    expect(res.json().provenance.verificationStatus).toBe('unverified');
  });

  it('writes a create revision so the record has a history from birth', async () => {
    const hco = (await createHco()).json();
    const history = await app.inject({
      method: 'GET',
      url: `/hcos/${hco.id}/history`,
      headers: auth(steward),
    });
    expect(history.json().revisions).toHaveLength(1);
    expect(history.json().revisions[0].changeType).toBe('create');
  });

  it('refuses a parent organisation from another clinic', async () => {
    const other = await makeClinic('Other Clinic');
    const otherSteward = await makeUser(other.clinicId, 'other', RoleKey.PHARMA_DATA_STEWARD);
    const foreign = (await createHco({ name: 'Foreign Hospital' }, otherSteward)).json();
    const res = await createHco({ name: 'Child', parentHcoId: foreign.id });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a name carrying a patient identifier', async () => {
    const res = await createHco({ name: 'Clinic for MRN-000123' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.details?.detected ?? res.json().details?.detected).toBe('mrn');
  });
});

describe('HCO master — authorization', () => {
  it('a field representative cannot create an organisation', async () => {
    const res = await createHco({}, rep);
    expect(res.statusCode).toBe(403);
  });

  it('a field representative can read the organisation master', async () => {
    await createHco();
    const res = await app.inject({ method: 'GET', url: '/hcos', headers: auth(rep) });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(1);
  });

  it('a representative cannot verify an organisation', async () => {
    const hco = (await createHco()).json();
    const res = await decide(hco.id, { verificationStatus: 'pending_review' }, rep);
    expect(res.statusCode).toBe(403);
  });

  it('medical affairs may read but not write the organisation master', async () => {
    const hco = (await createHco()).json();
    const read = await app.inject({
      method: 'GET',
      url: `/hcos/${hco.id}`,
      headers: auth(affairs),
    });
    expect(read.statusCode).toBe(200);
    const write = await createHco({ name: 'Affairs Hospital' }, affairs);
    expect(write.statusCode).toBe(403);
  });

  it('every organisation endpoint requires authentication', async () => {
    const hco = (await createHco()).json();
    for (const [method, url] of [
      ['GET', '/hcos'],
      ['POST', '/hcos'],
      ['GET', `/hcos/${hco.id}`],
      ['PATCH', `/hcos/${hco.id}`],
      ['GET', `/hcos/${hco.id}/360`],
      ['GET', `/hcos/${hco.id}/history`],
      ['POST', `/hcos/${hco.id}/verification`],
      ['POST', `/hcos/${hco.id}/merge`],
      ['GET', `/hcos/${hco.id}/identifiers`],
      ['POST', `/hcos/${hco.id}/identifiers`],
      ['GET', `/hcos/${hco.id}/locations`],
      ['POST', `/hcos/${hco.id}/locations`],
      ['GET', `/hcos/${hco.id}/departments`],
      ['POST', `/hcos/${hco.id}/departments`],
      ['POST', '/hcos/verification/sweep'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('tenant isolation: another clinic’s organisation is not found', async () => {
    const other = await makeClinic('Isolated Clinic');
    const otherSteward = await makeUser(other.clinicId, 'iso', RoleKey.PHARMA_DATA_STEWARD);
    const foreign = (await createHco({ name: 'Hidden Hospital' }, otherSteward)).json();
    const res = await app.inject({
      method: 'GET',
      url: `/hcos/${foreign.id}`,
      headers: auth(steward),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('HCO master — verification lifecycle', () => {
  it('nothing reaches verified without passing through review', async () => {
    const hco = (await createHco()).json();
    const res = await decide(hco.id, { verificationStatus: 'verified' });
    expect(res.statusCode).toBe(409);
  });

  it('review then verify is the only path, and records evidence', async () => {
    const hco = (await createHco()).json();
    const res = await verifyThroughReview(hco.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance.verificationStatus).toBe('verified');
    expect(res.json().provenance.lastVerifiedAt).not.toBeNull();
    expect(res.json().verificationExpiresAt).not.toBeNull();
  });

  it('a rejection without a reason is refused', async () => {
    const hco = (await createHco()).json();
    await decide(hco.id, { verificationStatus: 'pending_review' });
    const res = await decide(hco.id, { verificationStatus: 'rejected' });
    expect(res.statusCode).toBe(400);
  });

  it('a rejection with a reason is accepted and kept', async () => {
    const hco = (await createHco()).json();
    await decide(hco.id, { verificationStatus: 'pending_review' });
    const res = await decide(hco.id, {
      verificationStatus: 'rejected',
      note: 'Licence number does not match the public register',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verificationNote).toContain('public register');
  });

  it('refuses a transition that the lifecycle does not allow', async () => {
    const hco = (await createHco()).json();
    const res = await decide(hco.id, { verificationStatus: 'suspended', note: 'x y' });
    expect(res.statusCode).toBe(409);
    const details = res.json().error?.details ?? res.json().details;
    expect(details.allowed).not.toContain('suspended');
  });

  it('refuses re-asserting the state the record is already in', async () => {
    const hco = (await createHco()).json();
    await decide(hco.id, { verificationStatus: 'pending_review' });
    const res = await decide(hco.id, { verificationStatus: 'pending_review' });
    expect(res.statusCode).toBe(409);
  });

  it('a caller cannot simply declare a record expired', async () => {
    const hco = (await createHco()).json();
    const res = await decide(hco.id, { verificationStatus: 'expired' });
    expect(res.statusCode).toBe(400);
  });

  it('expiry is DERIVED: a lapsed verification reads as expired before any sweep', async () => {
    const hco = (await createHco()).json();
    await verifyThroughReview(hco.id);
    await getPool().query(
      `UPDATE hco SET verification_expires_at = now() - interval '1 day' WHERE id = $1`,
      [hco.id],
    );
    const res = await app.inject({
      method: 'GET',
      url: `/hcos/${hco.id}`,
      headers: auth(steward),
    });
    expect(res.json().provenance.verificationStatus).toBe('expired');
  });

  it('the sweep persists the lapse, attributes it to no human, and is idempotent', async () => {
    const hco = (await createHco()).json();
    await verifyThroughReview(hco.id);
    await getPool().query(
      `UPDATE hco SET verification_expires_at = now() - interval '1 day' WHERE id = $1`,
      [hco.id],
    );
    const first = await app.inject({
      method: 'POST',
      url: '/hcos/verification/sweep',
      headers: auth(steward),
      payload: {},
    });
    expect(first.json().expired).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: '/hcos/verification/sweep',
      headers: auth(steward),
      payload: {},
    });
    expect(second.json().expired).toBe(0);

    const history = await app.inject({
      method: 'GET',
      url: `/hcos/${hco.id}/history`,
      headers: auth(steward),
    });
    const lapse = history.json().revisions.find(
      (r: { changeType: string }) => r.changeType === 'verification_expired',
    );
    expect(lapse).toBeDefined();
    expect(lapse.changedBy).toBeNull();
  });

  it('filtering by verification status agrees with what a read returns', async () => {
    const verified = (await createHco({ name: 'Verified Hospital' })).json();
    await verifyThroughReview(verified.id);
    await createHco({ name: 'Unverified Hospital' });

    const res = await app.inject({
      method: 'GET',
      url: '/hcos?verificationStatus=verified',
      headers: auth(steward),
    });
    expect(res.json().results).toHaveLength(1);
    expect(res.json().results[0].name).toBe('Verified Hospital');
  });

  it('the database itself refuses an unexplained refusal', async () => {
    const hco = (await createHco()).json();
    await expect(
      getPool().query(
        `UPDATE hco SET verification_status = 'rejected', verification_note = NULL WHERE id = $1`,
        [hco.id],
      ),
    ).rejects.toThrow();
  });

  it('the revision history cannot be rewritten', async () => {
    const hco = (await createHco()).json();
    await expect(
      getPool().query(`UPDATE hco_revision SET change_type = 'verify' WHERE hco_id = $1`, [hco.id]),
    ).rejects.toThrow();
    await expect(
      getPool().query(`DELETE FROM hco_revision WHERE hco_id = $1`, [hco.id]),
    ).rejects.toThrow();
  });
});

describe('HCO master — updates and material change', () => {
  it('a material change sends a verified record back to review', async () => {
    const hco = (await createHco()).json();
    await verifyThroughReview(hco.id);
    const res = await app.inject({
      method: 'PATCH',
      url: `/hcos/${hco.id}`,
      headers: auth(steward),
      payload: { name: 'Nile Teaching Hospital (Maadi)', provenance: PROV },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance.verificationStatus).toBe('pending_review');
  });

  it('a non-material change leaves the verification intact', async () => {
    const hco = (await createHco()).json();
    await verifyThroughReview(hco.id);
    const res = await app.inject({
      method: 'PATCH',
      url: `/hcos/${hco.id}`,
      headers: auth(steward),
      payload: { isActive: false, provenance: PROV },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance.verificationStatus).toBe('verified');
  });

  it('refuses an update that would change nothing', async () => {
    const hco = (await createHco()).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/hcos/${hco.id}`,
      headers: auth(steward),
      payload: { name: 'Nile Teaching Hospital', provenance: PROV },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses an organisation becoming its own parent', async () => {
    const hco = (await createHco()).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/hcos/${hco.id}`,
      headers: auth(steward),
      payload: { parentHcoId: hco.id, provenance: PROV },
    });
    expect(res.statusCode).toBe(400);
  });

  it('an update bumps the record version and appends to history', async () => {
    const hco = (await createHco()).json();
    const updated = (
      await app.inject({
        method: 'PATCH',
        url: `/hcos/${hco.id}`,
        headers: auth(steward),
        payload: { city: 'Cairo', provenance: PROV },
      })
    ).json();
    expect(updated.recordVersion).toBe(hco.recordVersion + 1);
    const history = await app.inject({
      method: 'GET',
      url: `/hcos/${hco.id}/history`,
      headers: auth(steward),
    });
    expect(history.json().revisions[0].changedFields).toContain('city');
  });
});

describe('HCO master — merge', () => {
  it('merges a duplicate into a survivor and records why', async () => {
    const survivor = (await createHco({ name: 'Nile Teaching Hospital' })).json();
    const duplicate = (await createHco({ name: 'Nile Teaching Hosp.' })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${duplicate.id}/merge`,
      headers: auth(steward),
      payload: { survivorHcoId: survivor.id, reason: 'Same facility licence number' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().operatingStatus).toBe('merged');
    expect(res.json().mergedIntoHcoId).toBe(survivor.id);
    expect(res.json().isActive).toBe(false);
  });

  it('refuses a self-merge', async () => {
    const hco = (await createHco()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/merge`,
      headers: auth(steward),
      payload: { survivorHcoId: hco.id, reason: 'oops' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a merge chain, which would make identity resolution order-dependent', async () => {
    const a = (await createHco({ name: 'Hospital A' })).json();
    const b = (await createHco({ name: 'Hospital B' })).json();
    const c = (await createHco({ name: 'Hospital C' })).json();
    await app.inject({
      method: 'POST',
      url: `/hcos/${b.id}/merge`,
      headers: auth(steward),
      payload: { survivorHcoId: c.id, reason: 'duplicate' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${a.id}/merge`,
      headers: auth(steward),
      payload: { survivorHcoId: b.id, reason: 'duplicate' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses merging an already-merged organisation again', async () => {
    const survivor = (await createHco({ name: 'Survivor' })).json();
    const duplicate = (await createHco({ name: 'Duplicate' })).json();
    const third = (await createHco({ name: 'Third' })).json();
    await app.inject({
      method: 'POST',
      url: `/hcos/${duplicate.id}/merge`,
      headers: auth(steward),
      payload: { survivorHcoId: survivor.id, reason: 'duplicate' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${duplicate.id}/merge`,
      headers: auth(steward),
      payload: { survivorHcoId: third.id, reason: 'again' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('a steward without hco:merge cannot merge', async () => {
    const survivor = (await createHco({ name: 'Survivor' })).json();
    const duplicate = (await createHco({ name: 'Duplicate' })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${duplicate.id}/merge`,
      headers: auth(rep),
      payload: { survivorHcoId: survivor.id, reason: 'duplicate' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('HCO identifiers', () => {
  it('stores a public business identifier', async () => {
    const hco = (await createHco()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/identifiers`,
      headers: auth(steward),
      payload: {
        identifierSystem: 'EG_MOH_FACILITY',
        identifierValue: 'FAC-4471',
        issuingJurisdiction: 'EG',
        source: 'eg_moh_facility_register',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().identifierSystem).toBe('EG_MOH_FACILITY');
  });

  it('refuses a personal identity document as an organisation identifier', async () => {
    const hco = (await createHco()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/identifiers`,
      headers: auth(steward),
      payload: {
        identifierSystem: 'EG_NATIONAL_ID',
        identifierValue: '29001011234567',
        issuingJurisdiction: 'EG',
        source: 'field_rep',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses the same business identifier on two organisations in one clinic', async () => {
    const a = (await createHco({ name: 'Hospital A' })).json();
    const b = (await createHco({ name: 'Hospital B' })).json();
    const payload = {
      identifierSystem: 'EG_TAX_ID',
      identifierValue: '123-456-789',
      issuingJurisdiction: 'EG',
      source: 'commercial_register',
    };
    await app.inject({
      method: 'POST',
      url: `/hcos/${a.id}/identifiers`,
      headers: auth(steward),
      payload,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${b.id}/identifiers`,
      headers: auth(steward),
      payload,
    });
    expect(res.statusCode).toBe(409);
  });

  it('does not write the identifier value into the audit log', async () => {
    const hco = (await createHco()).json();
    await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/identifiers`,
      headers: auth(steward),
      payload: {
        identifierSystem: 'EG_TAX_ID',
        identifierValue: 'SECRET-TAX-9911',
        issuingJurisdiction: 'EG',
        source: 'commercial_register',
      },
    });
    const { rows } = await getPool().query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_log WHERE action = 'hco.identifier.add'`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain('SECRET-TAX-9911');
  });
});

describe('HCO locations and departments', () => {
  async function hcoWithSite() {
    const hco = (await createHco()).json();
    const location = (
      await app.inject({
        method: 'POST',
        url: `/hcos/${hco.id}/locations`,
        headers: auth(steward),
        payload: { label: 'Main campus', country: 'EG', isPrimary: true, provenance: PROV },
      })
    ).json();
    return { hco, location };
  }

  it('creates a site with provenance and marks it primary', async () => {
    const { location } = await hcoWithSite();
    expect(location.isPrimary).toBe(true);
    expect(location.provenance.verificationStatus).toBe('unverified');
  });

  it('a new primary site demotes the incumbent instead of failing', async () => {
    const { hco } = await hcoWithSite();
    const second = await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/locations`,
      headers: auth(steward),
      payload: { label: 'Maadi branch', country: 'EG', isPrimary: true, provenance: PROV },
    });
    expect(second.statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: `/hcos/${hco.id}/locations`,
      headers: auth(steward),
    });
    const primaries = list.json().locations.filter((l: { isPrimary: boolean }) => l.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].label).toBe('Maadi branch');
  });

  it('refuses two sites with the same label at one organisation', async () => {
    const { hco } = await hcoWithSite();
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/locations`,
      headers: auth(steward),
      payload: { label: 'main CAMPUS', country: 'EG', provenance: PROV },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a site pointed at a territory from another clinic', async () => {
    const { hco } = await hcoWithSite();
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/locations`,
      headers: auth(steward),
      payload: {
        label: 'Ghost branch',
        country: 'EG',
        territoryId: '00000000-0000-0000-0000-0000000000ff',
        provenance: PROV,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates a department under a site of the SAME organisation', async () => {
    const { hco, location } = await hcoWithSite();
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/departments`,
      headers: auth(steward),
      payload: { name: 'Cardiology', hcoLocationId: location.id, provenance: PROV },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().hcoLocationId).toBe(location.id);
  });

  it('refuses a department attached to another organisation’s site', async () => {
    const { location } = await hcoWithSite();
    const otherHco = (await createHco({ name: 'Other Hospital' })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${otherHco.id}/departments`,
      headers: auth(steward),
      payload: { name: 'Cardiology', hcoLocationId: location.id, provenance: PROV },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses duplicate department names at the same site', async () => {
    const { hco, location } = await hcoWithSite();
    const payload = { name: 'Cardiology', hcoLocationId: location.id, provenance: PROV };
    await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/departments`,
      headers: auth(steward),
      payload,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/departments`,
      headers: auth(steward),
      payload: { ...payload, name: 'cardiology' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('a representative cannot create a site or a department', async () => {
    const { hco, location } = await hcoWithSite();
    const site = await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/locations`,
      headers: auth(rep),
      payload: { label: 'Rep branch', country: 'EG', provenance: PROV },
    });
    expect(site.statusCode).toBe(403);
    const dept = await app.inject({
      method: 'POST',
      url: `/hcos/${hco.id}/departments`,
      headers: auth(rep),
      payload: { name: 'Rep dept', hcoLocationId: location.id, provenance: PROV },
    });
    expect(dept.statusCode).toBe(403);
  });
});
