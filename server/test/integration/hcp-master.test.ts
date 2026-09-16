import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;
let clinicId: string;
let steward: TestUser;
let rep: TestUser;

const PROVENANCE = { source: 'field_rep', jurisdiction: 'EG', sourceVersion: '2026-Q1' };

function auth(user: TestUser) {
  return { authorization: `Bearer ${user.token}` };
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  // ADMIN stands in for the data steward until dedicated pharma roles are
  // approved (CCR-002); PHARMA_REP is the field representative.
  steward = await makeUser(clinicId, 'steward', RoleKey.ADMIN);
  rep = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
});

afterAll(async () => {
  if (app) await app.close();
});

/**
 * Take a record through the governed path to `verified`. There is deliberately
 * no shortcut: Phase 6 forbids reaching `verified` without passing review.
 */
async function verifyThroughReview(hcpId: string, user: TestUser, evidence = 'register lookup') {
  const review = await app.inject({
    method: 'POST',
    url: `/hcps/${hcpId}/verification`,
    headers: auth(user),
    payload: { verificationStatus: 'pending_review', evidenceSource: evidence },
  });
  expect(review.statusCode).toBe(200);
  return app.inject({
    method: 'POST',
    url: `/hcps/${hcpId}/verification`,
    headers: auth(user),
    payload: { verificationStatus: 'verified', evidenceSource: evidence },
  });
}

async function createHcp(user: TestUser, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/hcps',
    headers: auth(user),
    payload: { fullName: 'Dr Mona Farouk', professionalCategory: 'physician', provenance: PROVENANCE, ...overrides },
  });
}

describe('HCP master — provenance is mandatory (§8, §23)', () => {
  it('creates an HCP carrying its full provenance envelope', async () => {
    const res = await createHcp(steward);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.provenance).toMatchObject({
      source: 'field_rep',
      sourceVersion: '2026-Q1',
      jurisdiction: 'EG',
      verificationStatus: 'unverified',
      lastVerifiedAt: null,
    });
    expect(body.recordVersion).toBe(1);
  });

  it('refuses an HCP with no source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hcps',
      headers: auth(steward),
      payload: { fullName: 'Dr No Source', professionalCategory: 'physician', provenance: { jurisdiction: 'EG' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('refuses an HCP with no jurisdiction', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hcps',
      headers: auth(steward),
      payload: { fullName: 'Dr No Jurisdiction', professionalCategory: 'physician', provenance: { source: 'field_rep' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a jurisdiction that is not an ISO code', async () => {
    const res = await createHcp(steward, { provenance: { source: 'x', jurisdiction: 'Egypt' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('HCP master — verification is stewardship, not field work', () => {
  it('nothing is born verified', async () => {
    const hcp = (await createHcp(steward)).json();
    expect(hcp.provenance.verificationStatus).toBe('unverified');
  });

  it('a steward can verify, and the record then carries evidence of when', async () => {
    const hcp = (await createHcp(steward)).json();
    const res = await verifyThroughReview(hcp.id, steward, 'EG MOH register lookup');
    expect(res.statusCode).toBe(200);
    const verified = res.json();
    expect(verified.provenance.verificationStatus).toBe('verified');
    expect(verified.provenance.lastVerifiedAt).not.toBeNull();
    // A verification is granted for a bounded period, never indefinitely.
    expect(verified.verificationExpiresAt).not.toBeNull();
    expect(verified.recordVersion).toBe(3);
  });

  it('REFUSES a jump straight from unverified to verified (review is mandatory)', async () => {
    const hcp = (await createHcp(steward)).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/verification`,
      headers: auth(steward),
      payload: { verificationStatus: 'verified', evidenceSource: 'skipping review' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.allowed).not.toContain('verified');
  });

  it('requires a reason to reject or suspend', async () => {
    const hcp = (await createHcp(steward)).json();
    await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/verification`,
      headers: auth(steward),
      payload: { verificationStatus: 'pending_review', evidenceSource: 'queued' },
    });
    const noReason = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/verification`,
      headers: auth(steward),
      payload: { verificationStatus: 'rejected', evidenceSource: 'register lookup' },
    });
    expect(noReason.statusCode).toBe(400);

    const withReason = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/verification`,
      headers: auth(steward),
      payload: {
        verificationStatus: 'rejected',
        evidenceSource: 'register lookup',
        note: 'No licence found under this name',
      },
    });
    expect(withReason.statusCode).toBe(200);
    expect(withReason.json().verificationNote).toMatch(/No licence found/);
  });

  it('a field representative CANNOT verify an HCP (least privilege)', async () => {
    const hcp = (await createHcp(steward)).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/verification`,
      headers: auth(rep),
      payload: { verificationStatus: 'verified', evidenceSource: 'I asked him' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a MATERIAL edit to a verified record drops it back to pending review', async () => {
    const hcp = (await createHcp(steward)).json();
    await verifyThroughReview(hcp.id, steward);
    const res = await app.inject({
      method: 'PATCH',
      url: `/hcps/${hcp.id}`,
      headers: auth(steward),
      payload: { fullName: 'Dr Mona Farouk Ibrahim' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance.verificationStatus).toBe('pending_review');
    // The lapse clock belongs to the verification that was just invalidated.
    expect(res.json().verificationExpiresAt).toBeNull();
  });

  it('a NON-material edit leaves the verification intact', async () => {
    const hcp = (await createHcp(steward)).json();
    await verifyThroughReview(hcp.id, steward);
    const res = await app.inject({
      method: 'PATCH',
      url: `/hcps/${hcp.id}`,
      headers: auth(steward),
      // Annotations are not claims a reviewer attested to.
      payload: { notes: 'Prefers morning appointments' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance.verificationStatus).toBe('verified');
  });
});

describe('HCP master — versioning and revision history', () => {
  it('records an append-only snapshot for every change', async () => {
    const hcp = (await createHcp(steward)).json();
    await app.inject({
      method: 'PATCH',
      url: `/hcps/${hcp.id}`,
      headers: auth(steward),
      payload: { title: 'Prof.' },
    });
    await verifyThroughReview(hcp.id, steward, 'syndicate register');

    const res = await app.inject({
      method: 'GET',
      url: `/hcps/${hcp.id}/history`,
      headers: auth(steward),
    });
    expect(res.statusCode).toBe(200);
    const revisions = res.json().revisions;
    expect(revisions.map((r: { changeType: string }) => r.changeType)).toEqual([
      'create',
      'update',
      'verify',
      'verify',
    ]);
    expect(revisions[1].changedFields).toContain('title');
    expect(revisions.map((r: { recordVersion: number }) => r.recordVersion)).toEqual([1, 2, 3, 4]);
  });

  it('revision history cannot be rewritten', async () => {
    const hcp = (await createHcp(steward)).json();
    await expect(
      getPool().query('DELETE FROM hcp_revision WHERE hcp_id = $1', [hcp.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getPool().query(`UPDATE hcp_revision SET source = 'tampered'`),
    ).rejects.toThrow(/append-only/);
  });
});

describe('HCP master — identity resolution (merge)', () => {
  it('merges a duplicate into a surviving record without deleting it', async () => {
    const survivor = (await createHcp(steward)).json();
    const duplicate = (await createHcp(steward, { fullName: 'Dr M. Farouk' })).json();

    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${duplicate.id}/merge`,
      headers: auth(steward),
      payload: { targetHcpId: survivor.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'merged', mergedIntoHcpId: survivor.id });

    // The merged record is read-only from now on.
    const update = await app.inject({
      method: 'PATCH',
      url: `/hcps/${duplicate.id}`,
      headers: auth(steward),
      payload: { title: 'Dr.' },
    });
    expect(update.statusCode).toBe(409);
  });

  it('refuses a self-merge', async () => {
    const hcp = (await createHcp(steward)).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/merge`,
      headers: auth(steward),
      payload: { targetHcpId: hcp.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it('merged records drop out of search', async () => {
    const survivor = (await createHcp(steward)).json();
    const duplicate = (await createHcp(steward, { fullName: 'Dr M. Farouk' })).json();
    await app.inject({
      method: 'POST',
      url: `/hcps/${duplicate.id}/merge`,
      headers: auth(steward),
      payload: { targetHcpId: survivor.id },
    });
    const res = await app.inject({ method: 'GET', url: '/hcps?q=Farouk', headers: auth(steward) });
    expect(res.json().results.map((h: { id: string }) => h.id)).toEqual([survivor.id]);
  });
});

describe('HCP master — professional identifiers only', () => {
  it('stores a professional licence identifier', async () => {
    const hcp = (await createHcp(steward)).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/identifiers`,
      headers: auth(steward),
      payload: {
        identifierSystem: 'EG_MOH_LICENSE',
        identifierValue: 'LIC-99881',
        issuingJurisdiction: 'EG',
        source: 'licence card',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().identifierSystem).toBe('EG_MOH_LICENSE');
  });

  it('REFUSES a personal government identifier', async () => {
    const hcp = (await createHcp(steward)).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/identifiers`,
      headers: auth(steward),
      payload: {
        identifierSystem: 'NATIONAL_ID',
        identifierValue: '29001011234567',
        issuingJurisdiction: 'EG',
        source: 'id card',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/professional identifiers/i);
  });

  it('refuses the same identifier on two HCPs', async () => {
    const first = (await createHcp(steward)).json();
    const second = (await createHcp(steward, { fullName: 'Dr Other Person' })).json();
    const payload = {
      identifierSystem: 'NPI',
      identifierValue: '1234567893',
      issuingJurisdiction: 'US',
      source: 'npi registry',
    };
    await app.inject({
      method: 'POST',
      url: `/hcps/${first.id}/identifiers`,
      headers: auth(steward),
      payload,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${second.id}/identifiers`,
      headers: auth(steward),
      payload,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('HCP master — affiliations, locations, specialties, interests', () => {
  it('builds the full professional picture and returns it as HCP 360', async () => {
    const hco = (
      await app.inject({
        method: 'POST',
        url: '/hcos',
        headers: auth(steward),
        payload: {
          name: 'Cairo University Hospital',
          hcoType: 'hospital',
          country: 'EG',
          provenance: { source: 'public_register', jurisdiction: 'EG' },
        },
      })
    ).json();

    const specialty = (
      await app.inject({
        method: 'POST',
        url: '/specialties',
        headers: auth(steward),
        payload: {
          code: 'CARDIO',
          displayName: 'Cardiology',
          source: 'medcore_taxonomy',
        },
      })
    ).json();

    const hcp = (await createHcp(steward, { primarySpecialtyId: specialty.id })).json();

    const affiliation = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/affiliations`,
      headers: auth(steward),
      payload: {
        hcoId: hco.id,
        department: 'Cardiology',
        roleTitle: 'Consultant',
        affiliationType: 'primary',
        source: 'field_rep',
      },
    });
    expect(affiliation.statusCode).toBe(201);

    await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/locations`,
      headers: auth(steward),
      payload: { label: 'Private clinic', city: 'Cairo', country: 'EG', isPrimary: true, source: 'field_rep' },
    });
    await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/interests`,
      headers: auth(steward),
      payload: { interest: 'heart failure', strength: 'high', source: 'field_rep' },
    });

    const res = await app.inject({ method: 'GET', url: `/hcps/${hcp.id}`, headers: auth(steward) });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.hcp.id).toBe(hcp.id);
    expect(view.affiliations[0]).toMatchObject({ department: 'Cardiology', hcoName: 'Cairo University Hospital' });
    expect(view.practiceLocations[0].isPrimary).toBe(true);
    expect(view.interests[0].interest).toBe('heart failure');
    expect(view.specialties[0].code).toBe('CARDIO');
    expect(view.masterDataHistory).toHaveLength(1);
    expect(view.dataBoundary).toMatch(/no patient-level data/i);
  });

  it('refuses a second primary practice location', async () => {
    const hcp = (await createHcp(steward)).json();
    const payload = { city: 'Cairo', country: 'EG', isPrimary: true, source: 'field_rep' };
    await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/locations`,
      headers: auth(steward),
      payload,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/locations`,
      headers: auth(steward),
      payload,
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a duplicate open affiliation for the same HCO and department', async () => {
    const hco = (
      await app.inject({
        method: 'POST',
        url: '/hcos',
        headers: auth(steward),
        payload: {
          name: 'Nile Hospital',
          country: 'EG',
          provenance: { source: 'public_register', jurisdiction: 'EG' },
        },
      })
    ).json();
    const hcp = (await createHcp(steward)).json();
    const payload = { hcoId: hco.id, department: 'ICU', source: 'field_rep' };
    await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/affiliations`,
      headers: auth(steward),
      payload,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/affiliations`,
      headers: auth(steward),
      payload,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('HCP master — tenant isolation', () => {
  it('an HCP in another clinic is not found', async () => {
    const other = await makeClinic('Other Clinic');
    const otherSteward = await makeUser(other.clinicId, 'steward2', RoleKey.ADMIN);
    const mine = (await createHcp(steward)).json();

    const res = await app.inject({
      method: 'GET',
      url: `/hcps/${mine.id}`,
      headers: auth(otherSteward),
    });
    expect(res.statusCode).toBe(404);
  });
});
