import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * PHASES 5-7 — HCP master hardening, verification lifecycle, attribute provenance.
 */

let app: FastifyInstance;
let clinicId: string;
let steward: TestUser;
let rep: TestUser;

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'eg_moh_register', jurisdiction: 'EG', sourceDate: '2026-01-15' };

async function createHcp(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/hcps',
    headers: auth(steward),
    payload: {
      fullName: 'Dr Layla Hassan',
      professionalCategory: 'physician',
      provenance: PROV,
      ...overrides,
    },
  });
}

function setVerification(hcpId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/hcps/${hcpId}/verification`,
    headers: auth(steward),
    payload: { evidenceSource: 'EG MOH register', ...payload },
  });
}

async function verifyThroughReview(hcpId: string, validForDays?: number) {
  await setVerification(hcpId, { verificationStatus: 'pending_review' });
  return setVerification(hcpId, {
    verificationStatus: 'verified',
    ...(validForDays !== undefined ? { validForDays } : {}),
  });
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  steward = await makeUser(clinicId, 'steward', RoleKey.PHARMA_DATA_STEWARD);
  rep = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
});

afterAll(async () => {
  if (app) await app.close();
});

describe('HCP master — professional category', () => {
  it('records the kind of professional, not just a name', async () => {
    const res = await createHcp({ professionalCategory: 'pharmacist' });
    expect(res.statusCode).toBe(201);
    expect(res.json().professionalCategory).toBe('pharmacist');
  });

  it('REQUIRES a category rather than assuming physician', async () => {
    // Defaulting would invent a fact about a real professional.
    const res = await app.inject({
      method: 'POST',
      url: '/hcps',
      headers: auth(steward),
      payload: { fullName: 'Dr Unknown Kind', provenance: PROV },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a category outside the vocabulary', async () => {
    const res = await createHcp({ professionalCategory: 'astronaut' });
    expect(res.statusCode).toBe(400);
  });

  it('filters the master by category', async () => {
    await createHcp({ fullName: 'Dr A Physician', professionalCategory: 'physician' });
    await createHcp({ fullName: 'Mr B Pharmacist', professionalCategory: 'pharmacist' });
    const res = await app.inject({
      method: 'GET',
      url: '/hcps?professionalCategory=pharmacist',
      headers: auth(steward),
    });
    expect(res.json().results.map((h: { fullName: string }) => h.fullName)).toEqual([
      'Mr B Pharmacist',
    ]);
  });
});

describe('HCP master — credential validity is derived (0313 audit)', () => {
  async function addCredential(hcpId: string, extra: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${hcpId}/credentials`,
      headers: auth(steward),
      payload: {
        credentialType: 'licence',
        credentialName: 'Practice licence',
        issuingBody: 'EG MOH',
        source: 'licence register',
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it('a lapsed credential no longer reads as in force', async () => {
    const hcp = (await createHcp()).json();
    const credential = await addCredential(hcp.id, {
      validFrom: '2018-01-01',
      validTo: '2019-01-01',
    });
    expect(credential.validity).toBe('expired');
  });

  it('a live credential reads as in force', async () => {
    const hcp = (await createHcp()).json();
    const credential = await addCredential(hcp.id, {
      validFrom: '2020-01-01',
      validTo: '2099-01-01',
    });
    expect(credential.validity).toBe('in_force');
  });

  it('a credential that has not started yet says so rather than being in force', async () => {
    const hcp = (await createHcp()).json();
    const credential = await addCredential(hcp.id, { validFrom: '2099-01-01' });
    expect(credential.validity).toBe('not_yet_effective');
  });

  it('a credential with no window claims nothing about its window', async () => {
    const hcp = (await createHcp()).json();
    const credential = await addCredential(hcp.id, {});
    expect(credential.validity).toBe('undated');
  });

  it('validity is SEPARATE from verification: a checked credential can still be expired', async () => {
    const hcp = (await createHcp()).json();
    await addCredential(hcp.id, { validFrom: '2018-01-01', validTo: '2019-01-01' });
    const list = await app.inject({
      method: 'GET',
      url: `/hcps/${hcp.id}/credentials`,
      headers: auth(steward),
    });
    const [credential] = list.json().credentials;
    expect(credential.verificationStatus).toBe('unverified');
    expect(credential.validity).toBe('expired');
  });
});

describe('specialty taxonomy — tenancy (0313 audit)', () => {
  it('refuses a parent specialty from another clinic', async () => {
    const other = await makeClinic('Other Taxonomy Clinic');
    const otherSteward = await makeUser(other.clinicId, 'tax-stw', RoleKey.PHARMA_DATA_STEWARD);
    const foreign = await app.inject({
      method: 'POST',
      url: '/specialties',
      headers: auth(otherSteward),
      payload: { taxonomy: 'internal', code: 'ROOT', displayName: 'Root', source: 'internal' },
    });
    expect(foreign.statusCode).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: '/specialties',
      headers: auth(steward),
      payload: {
        taxonomy: 'internal',
        code: 'CHILD',
        displayName: 'Child',
        parentId: foreign.json().id,
        source: 'internal',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('accepts a parent from the caller’s own clinic', async () => {
    const parent = await app.inject({
      method: 'POST',
      url: '/specialties',
      headers: auth(steward),
      payload: { taxonomy: 'internal', code: 'ROOT', displayName: 'Root', source: 'internal' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/specialties',
      headers: auth(steward),
      payload: {
        taxonomy: 'internal',
        code: 'CHILD',
        displayName: 'Child',
        parentId: parent.json().id,
        source: 'internal',
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('HCP master — credentials', () => {
  it('records a qualification with its issuing body and provenance', async () => {
    const hcp = (await createHcp()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/credentials`,
      headers: auth(steward),
      payload: {
        credentialType: 'board_certification',
        credentialCode: 'FRCP',
        credentialName: 'Fellowship of the Royal College of Physicians',
        issuingBody: 'Royal College of Physicians',
        issuingJurisdiction: 'GB',
        awardedOn: '2018-06-01',
        source: 'college register',
        sourceDate: '2026-01-15',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      credentialCode: 'FRCP',
      issuingJurisdiction: 'GB',
      awardedOn: '2018-06-01',
      sourceDate: '2026-01-15',
      // A credential is not verified merely because it was entered.
      verificationStatus: 'unverified',
    });
  });

  it('refuses the same credential twice from the same body', async () => {
    const hcp = (await createHcp()).json();
    const payload = {
      credentialName: 'MD',
      issuingBody: 'Cairo University',
      source: 'diploma',
    };
    await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/credentials`,
      headers: auth(steward),
      payload,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/credentials`,
      headers: auth(steward),
      payload,
    });
    expect(res.statusCode).toBe(409);
  });

  it('surfaces credentials in HCP 360', async () => {
    const hcp = (await createHcp()).json();
    await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/credentials`,
      headers: auth(steward),
      payload: { credentialName: 'PhD', source: 'university register' },
    });
    const view = await app.inject({
      method: 'GET',
      url: `/hcps/${hcp.id}`,
      headers: auth(steward),
    });
    expect(view.json().credentials[0].credentialName).toBe('PhD');
  });

  it('screens credential free text for patient identifiers', async () => {
    const hcp = (await createHcp()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/credentials`,
      headers: auth(steward),
      payload: { credentialName: 'Awarded after case MRN-000042', source: 'note' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('HCP verification — the full lifecycle', () => {
  it('walks pending_review → verified → suspended → pending_review', async () => {
    const hcp = (await createHcp()).json();
    expect((await verifyThroughReview(hcp.id)).json().provenance.verificationStatus).toBe(
      'verified',
    );

    const suspended = await setVerification(hcp.id, {
      verificationStatus: 'suspended',
      note: 'Licence under investigation',
    });
    expect(suspended.json().provenance.verificationStatus).toBe('suspended');

    const back = await setVerification(hcp.id, { verificationStatus: 'pending_review' });
    expect(back.json().provenance.verificationStatus).toBe('pending_review');
  });

  it('a suspended record cannot be re-verified without review', async () => {
    const hcp = (await createHcp()).json();
    await verifyThroughReview(hcp.id);
    await setVerification(hcp.id, { verificationStatus: 'suspended', note: 'under review' });
    const res = await setVerification(hcp.id, { verificationStatus: 'verified' });
    expect(res.statusCode).toBe(409);
  });

  it('a rejection is recorded with its reason and is not an appeal target', async () => {
    const hcp = (await createHcp()).json();
    await setVerification(hcp.id, { verificationStatus: 'pending_review' });
    const rejected = await setVerification(hcp.id, {
      verificationStatus: 'rejected',
      note: 'No matching licence in the register',
    });
    expect(rejected.json().verificationNote).toBe('No matching licence in the register');

    // Editing a rejected record does not quietly promote it to review.
    const edited = await app.inject({
      method: 'PATCH',
      url: `/hcps/${hcp.id}`,
      headers: auth(steward),
      payload: { fullName: 'Dr Layla Hassan Ali' },
    });
    expect(edited.json().provenance.verificationStatus).toBe('rejected');
  });

  it('a field representative cannot drive any part of the lifecycle', async () => {
    const hcp = (await createHcp()).json();
    for (const status of ['pending_review', 'verified', 'rejected', 'suspended']) {
      const res = await app.inject({
        method: 'POST',
        url: `/hcps/${hcp.id}/verification`,
        headers: auth(rep),
        payload: { verificationStatus: status, evidenceSource: 'x', note: 'x' },
      });
      expect(res.statusCode, status).toBe(403);
    }
  });
});

describe('HCP verification — expiry', () => {
  /** Force a verification to have lapsed, without waiting a year. */
  async function expireNow(hcpId: string) {
    await getPool().query(
      `UPDATE hcp SET verification_expires_at = now() - interval '1 day' WHERE id = $1`,
      [hcpId],
    );
  }

  it('reads as expired the moment it lapses, with no sweep having run', async () => {
    const hcp = (await createHcp()).json();
    await verifyThroughReview(hcp.id, 30);
    await expireNow(hcp.id);

    const read = await app.inject({
      method: 'GET',
      url: `/hcps/${hcp.id}`,
      headers: auth(steward),
    });
    expect(read.json().hcp.provenance.verificationStatus).toBe('expired');

    // The stored column has not changed yet — expiry is derived, so a missed
    // background job can never leave a stale "verified" on display.
    const { rows } = await getPool().query<{ verification_status: string }>(
      'SELECT verification_status FROM hcp WHERE id = $1',
      [hcp.id],
    );
    expect(rows[0]!.verification_status).toBe('verified');
  });

  it('a lapsed record does not answer a search for verified records', async () => {
    const hcp = (await createHcp()).json();
    await verifyThroughReview(hcp.id, 30);
    await expireNow(hcp.id);

    const verified = await app.inject({
      method: 'GET',
      url: '/hcps?verificationStatus=verified',
      headers: auth(steward),
    });
    expect(verified.json().results).toEqual([]);

    const expired = await app.inject({
      method: 'GET',
      url: '/hcps?verificationStatus=expired',
      headers: auth(steward),
    });
    expect(expired.json().results.map((h: { id: string }) => h.id)).toEqual([hcp.id]);
  });

  it('the sweep persists the lapse and records it as automatic, not human', async () => {
    const hcp = (await createHcp()).json();
    await verifyThroughReview(hcp.id, 30);
    await expireNow(hcp.id);

    const sweep = await app.inject({
      method: 'POST',
      url: '/hcps/verification/sweep',
      headers: auth(steward),
      payload: {},
    });
    expect(sweep.statusCode).toBe(200);
    expect(sweep.json().expired).toBe(1);

    const { rows } = await getPool().query<{ verification_status: string }>(
      'SELECT verification_status FROM hcp WHERE id = $1',
      [hcp.id],
    );
    expect(rows[0]!.verification_status).toBe('expired');

    const history = await app.inject({
      method: 'GET',
      url: `/hcps/${hcp.id}/history`,
      headers: auth(steward),
    });
    const types = history.json().revisions.map((r: { changeType: string }) => r.changeType);
    expect(types).toContain('verification_expired');

    const events = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE type = 'HCP_VERIFICATION_EXPIRED'`,
    );
    expect(Number(events.rows[0]!.n)).toBe(1);
  });

  it('the sweep is idempotent and leaves live verifications alone', async () => {
    const lapsed = (await createHcp({ fullName: 'Dr Lapsed' })).json();
    const live = (await createHcp({ fullName: 'Dr Live' })).json();
    await verifyThroughReview(lapsed.id, 30);
    await verifyThroughReview(live.id, 365);
    await expireNow(lapsed.id);

    const first = await app.inject({
      method: 'POST',
      url: '/hcps/verification/sweep',
      headers: auth(steward),
      payload: {},
    });
    expect(first.json().expired).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: '/hcps/verification/sweep',
      headers: auth(steward),
      payload: {},
    });
    expect(second.json().expired).toBe(0);

    const liveRead = await app.inject({
      method: 'GET',
      url: `/hcps/${live.id}`,
      headers: auth(steward),
    });
    expect(liveRead.json().hcp.provenance.verificationStatus).toBe('verified');
  });

  it('a representative cannot run the sweep', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hcps/verification/sweep',
      headers: auth(rep),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('HCP provenance — attribute-level traceability', () => {
  it('answers where each attribute came from', async () => {
    const hcp = (await createHcp()).json();
    await app.inject({
      method: 'PATCH',
      url: `/hcps/${hcp.id}`,
      headers: auth(steward),
      payload: {
        title: 'Prof.',
        provenance: { source: 'syndicate_register', jurisdiction: 'EG', sourceDate: '2026-02-01' },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/hcps/${hcp.id}/provenance`,
      headers: auth(steward),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The record's own provenance carries the source date the source asserted.
    expect(body.recordProvenance.sourceDate).toBe('2026-02-01');

    const title = body.attributes.find((a: { attribute: string }) => a.attribute === 'title');
    expect(title).toMatchObject({ source: 'syndicate_register', recordVersion: 2 });
    expect(title.changedAt).toBeTruthy();

    // The create revision is represented rather than being invisible.
    expect(
      body.attributes.some((a: { attribute: string }) => a.attribute === '(record created)'),
    ).toBe(true);
  });

  it('reports the LATEST source for an attribute changed more than once', async () => {
    const hcp = (await createHcp()).json();
    for (const [source, title] of [
      ['first_source', 'Dr.'],
      ['second_source', 'Prof.'],
    ]) {
      await app.inject({
        method: 'PATCH',
        url: `/hcps/${hcp.id}`,
        headers: auth(steward),
        payload: { title, provenance: { source, jurisdiction: 'EG' } },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: `/hcps/${hcp.id}/provenance`,
      headers: auth(steward),
    });
    const title = res
      .json()
      .attributes.find((a: { attribute: string }) => a.attribute === 'title');
    expect(title.source).toBe('second_source');
  });

  it('is territory-scoped like every other HCP read', async () => {
    const hcp = (await createHcp()).json();
    const res = await app.inject({
      method: 'GET',
      url: `/hcps/${hcp.id}/provenance`,
      headers: auth(rep),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('HCP master — record validity window', () => {
  it('stores an effective window and treats changing it as material', async () => {
    const hcp = (await createHcp({ effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' })).json();
    expect(hcp.effectiveFrom).toBe('2026-01-01');
    expect(hcp.effectiveTo).toBe('2026-12-31');

    await verifyThroughReview(hcp.id);
    const res = await app.inject({
      method: 'PATCH',
      url: `/hcps/${hcp.id}`,
      headers: auth(steward),
      payload: { effectiveTo: '2027-12-31' },
    });
    expect(res.json().provenance.verificationStatus).toBe('pending_review');
  });

  it('the database refuses an inverted window', async () => {
    await expect(
      getPool().query(
        `INSERT INTO hcp (clinic_id, full_name, source, jurisdiction, effective_from, effective_to)
         VALUES ($1,'Dr Inverted','x','EG','2026-12-31','2026-01-01')`,
        [clinicId],
      ),
    ).rejects.toThrow(/hcp_effective_window/);
  });

  it('the database refuses an unexplained rejection', async () => {
    await expect(
      getPool().query(
        `INSERT INTO hcp (clinic_id, full_name, source, jurisdiction, verification_status)
         VALUES ($1,'Dr Unexplained','x','EG','rejected')`,
        [clinicId],
      ),
    ).rejects.toThrow(/hcp_refusal_has_reason/);
  });
});
