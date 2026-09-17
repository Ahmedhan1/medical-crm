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

function auth(user: TestUser) {
  return { authorization: `Bearer ${user.token}` };
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  steward = await makeUser(clinicId, 'steward', RoleKey.ADMIN);
  rep = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
});

afterAll(async () => {
  if (app) await app.close();
});

async function createMedication(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/medications',
    headers: auth(steward),
    payload: {
      genericName: 'metformin',
      atcCode: 'A10BA02',
      therapeuticArea: 'diabetes',
      providerKey: 'manual_entry',
      provenance: { source: 'product label', jurisdiction: 'EG', sourceRef: 'label rev 3' },
      ingredients: [
        { ingredientName: 'metformin hydrochloride', strengthValue: 500, strengthUnit: 'mg' },
      ],
      ...overrides,
    },
  });
}

describe('drug master — provenance and licensing discipline', () => {
  it('creates a medication concept with provenance and a licence basis', async () => {
    const res = await createMedication();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      genericName: 'metformin',
      jurisdiction: 'EG',
      source: 'product label',
      licenseBasis: 'operator_owned',
      verificationStatus: 'unverified',
    });
    expect(body.ingredients[0]).toMatchObject({
      ingredientName: 'metformin hydrochloride',
      strengthValue: 500,
      strengthUnit: 'mg',
    });
  });

  it('REFUSES an unregistered data provider (no unlicensed ingestion)', async () => {
    const res = await createMedication({ providerKey: 'some_proprietary_vendor_db' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/registered provider with a declared licence basis/i);
    expect(res.json().error.details.registeredProviders).toContain('manual_entry');
  });

  it('refuses a provider that does not cover the jurisdiction', async () => {
    // RxNorm is a US source; it cannot be cited as the origin of EG data.
    const res = await createMedication({
      providerKey: 'rxnorm',
      provenance: { source: 'rxnorm', jurisdiction: 'EG' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/does not cover jurisdiction/i);
  });

  it('exposes the provider registry with each licence basis', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/medications/providers',
      headers: auth(rep),
    });
    expect(res.statusCode).toBe(200);
    const providers = res.json().providers;
    expect(providers.map((p: { key: string }) => p.key)).toContain('eda_public_register');
    for (const provider of providers) {
      expect(provider.licenseBasis).toBeTruthy();
      expect(typeof provider.redistributionAllowed).toBe('boolean');
    }
  });

  it('refuses a malformed ATC code rather than inventing a classification', async () => {
    const res = await createMedication({ atcCode: 'NOT-AN-ATC' });
    expect(res.statusCode).toBe(400);
  });
});

describe('drug master — regulatory identity is per jurisdiction', () => {
  it('registers the same generic separately in two jurisdictions', async () => {
    const eg = await createMedication();
    expect(eg.statusCode).toBe(201);
    const us = await createMedication({
      providerKey: 'rxnorm',
      provenance: { source: 'rxnorm', jurisdiction: 'US' },
    });
    expect(us.statusCode).toBe(201);
    expect(us.json().id).not.toBe(eg.json().id);
  });

  it('refuses the same generic twice within one jurisdiction', async () => {
    await createMedication();
    const res = await createMedication();
    expect(res.statusCode).toBe(409);
  });

  it('attaches a marketed product with its regulatory facts', async () => {
    const medication = (await createMedication()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/medications/${medication.id}/products`,
      headers: auth(steward),
      payload: {
        brandName: 'Cidophage',
        manufacturerName: 'Example Pharma',
        dosageForm: 'tablet',
        route: 'oral',
        strengthText: '500 mg',
        packageDescription: 'box of 30 tablets',
        packageSize: 30,
        packageUnit: 'tablet',
        jurisdiction: 'EG',
        regulatoryAuthority: 'EDA',
        regulatoryIdentifier: 'EG-REG-11223',
        regulatoryStatus: 'approved',
        approvalDate: '2019-04-01',
        source: 'public register entry',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      brandName: 'Cidophage',
      manufacturerName: 'Example Pharma',
      dosageForm: 'tablet',
      route: 'oral',
      jurisdiction: 'EG',
      regulatoryAuthority: 'EDA',
      regulatoryStatus: 'approved',
      licenseBasis: 'operator_owned',
    });
  });

  it('refuses an approved product with no regulatory identifier', async () => {
    const medication = (await createMedication()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/medications/${medication.id}/products`,
      headers: auth(steward),
      payload: {
        brandName: 'Nameless',
        dosageForm: 'tablet',
        route: 'oral',
        jurisdiction: 'EG',
        regulatoryStatus: 'approved',
        source: 'hearsay',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/regulatory identifier/i);
  });

  it('refuses two products sharing a registration number in one jurisdiction', async () => {
    const medication = (await createMedication()).json();
    const payload = {
      brandName: 'Brand A',
      dosageForm: 'tablet',
      route: 'oral',
      jurisdiction: 'EG',
      regulatoryIdentifier: 'EG-REG-55555',
      regulatoryStatus: 'approved' as const,
      source: 'register',
    };
    await app.inject({
      method: 'POST',
      url: `/medications/${medication.id}/products`,
      headers: auth(steward),
      payload,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/medications/${medication.id}/products`,
      headers: auth(steward),
      payload: { ...payload, brandName: 'Brand B' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a withdrawal date before the approval date', async () => {
    const medication = (await createMedication()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/medications/${medication.id}/products`,
      headers: auth(steward),
      payload: {
        brandName: 'Timewarp',
        dosageForm: 'tablet',
        route: 'oral',
        jurisdiction: 'EG',
        regulatoryStatus: 'withdrawn',
        approvalDate: '2020-01-01',
        withdrawalDate: '2019-01-01',
        source: 'register',
      },
    });
    expect(res.statusCode).toBe(500);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM medication_product');
    expect(rows[0]!.n).toBe(0);
  });
});

describe('drug master — read access and search', () => {
  it('a representative can read the master but not write to it', async () => {
    const medication = (await createMedication()).json();

    const read = await app.inject({
      method: 'GET',
      url: `/medications/${medication.id}`,
      headers: auth(rep),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().genericName).toBe('metformin');

    const write = await createMedicationAs(rep);
    expect(write.statusCode).toBe(403);
  });

  it('searches by generic name and by brand name', async () => {
    const medication = (await createMedication()).json();
    await app.inject({
      method: 'POST',
      url: `/medications/${medication.id}/products`,
      headers: auth(steward),
      payload: {
        brandName: 'Glucoform',
        dosageForm: 'tablet',
        route: 'oral',
        jurisdiction: 'EG',
        source: 'register',
      },
    });

    const byGeneric = await app.inject({
      method: 'GET',
      url: '/medications?q=metfor',
      headers: auth(rep),
    });
    expect(byGeneric.json().results).toHaveLength(1);

    const byBrand = await app.inject({
      method: 'GET',
      url: '/medications?q=glucofo',
      headers: auth(rep),
    });
    expect(byBrand.json().results).toHaveLength(1);
  });

  async function createMedicationAs(user: TestUser) {
    return app.inject({
      method: 'POST',
      url: '/medications',
      headers: auth(user),
      payload: {
        genericName: 'aspirin',
        providerKey: 'manual_entry',
        provenance: { source: 'label', jurisdiction: 'EG' },
      },
    });
  }
});

describe('drug master — import runs are traceable', () => {
  it('records the run, its licence basis and its counts, skipping duplicates', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/medications/import',
      headers: auth(steward),
      payload: {
        providerKey: 'eda_public_register',
        providerVersion: '2026-02-01',
        sourceRef: 'https://example.invalid/register-export',
        jurisdiction: 'EG',
        records: [
          { genericName: 'amoxicillin' },
          { genericName: 'paracetamol' },
          { genericName: 'amoxicillin' }, // duplicate within the same batch
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      recordsCreated: 2,
      recordsSkipped: 1,
      licenseBasis: 'public_register',
    });

    const runs = await app.inject({
      method: 'GET',
      url: '/medications/imports',
      headers: auth(steward),
    });
    expect(runs.json().runs[0]).toMatchObject({
      providerKey: 'eda_public_register',
      status: 'completed',
      recordsCreated: 2,
      recordsSkipped: 1,
    });
  });

  it('refuses an import from an unregistered provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/medications/import',
      headers: auth(steward),
      payload: {
        providerKey: 'scraped_competitor_database',
        jurisdiction: 'EG',
        records: [{ genericName: 'ibuprofen' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM medication');
    expect(rows[0]!.n).toBe(0);
  });
});

describe('drug master — verification', () => {
  function decide(medicationId: string, payload: Record<string, unknown>, as: TestUser = steward) {
    return app.inject({
      method: 'POST',
      url: `/medications/${medicationId}/verification`,
      headers: auth(as),
      payload: { evidenceSource: 'EDA register 2026-02', ...payload },
    });
  }

  async function verifyThroughReview(medicationId: string, validForDays?: number) {
    await decide(medicationId, { verificationStatus: 'pending_review' });
    return decide(medicationId, {
      verificationStatus: 'verified',
      ...(validForDays !== undefined ? { validForDays } : {}),
    });
  }

  it('records who verified and when, and bumps the record version', async () => {
    const medication = (await createMedication()).json();
    const res = await verifyThroughReview(medication.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verificationStatus: 'verified', recordVersion: 3 });
    expect(res.json().lastVerifiedAt).not.toBeNull();
    expect(res.json().verifiedBy).toBe(steward.userId);
    expect(res.json().verificationExpiresAt).not.toBeNull();
  });

  it('keeps an append-only revision trail', async () => {
    const medication = (await createMedication()).json();
    await verifyThroughReview(medication.id);
    const { rows } = await getPool().query<{ change_type: string }>(
      'SELECT change_type FROM medication_revision WHERE medication_id = $1 ORDER BY record_version',
      [medication.id],
    );
    expect(rows.map((r) => r.change_type)).toEqual(['create', 'verify', 'verify']);
    await expect(getPool().query('DELETE FROM medication_revision')).rejects.toThrow(/append-only/);
  });
});

describe('drug master — governance parity with the other masters (0315 audit)', () => {
  let dataSteward: TestUser;
  let writerOnly: TestUser;

  function decide(medicationId: string, payload: Record<string, unknown>, as: TestUser) {
    return app.inject({
      method: 'POST',
      url: `/medications/${medicationId}/verification`,
      headers: auth(as),
      payload: { evidenceSource: 'EDA register 2026-02', ...payload },
    });
  }

  beforeEach(async () => {
    dataSteward = await makeUser(clinicId, 'drug-steward', RoleKey.PHARMA_DATA_STEWARD);
    // Holds every pharma permission EXCEPT verify: MEDICAL_AFFAIRS can read the
    // master but has no stewardship over it.
    writerOnly = await makeUser(clinicId, 'drug-affairs', RoleKey.MEDICAL_AFFAIRS);
  });

  it('NOTHING reaches verified in one step — the rule the other masters enforce', async () => {
    const medication = (await createMedication()).json();
    const res = await decide(medication.id, { verificationStatus: 'verified' }, dataSteward);
    expect(res.statusCode).toBe(409);
  });

  it('review then verify is the only path', async () => {
    const medication = (await createMedication()).json();
    await decide(medication.id, { verificationStatus: 'pending_review' }, dataSteward);
    const res = await decide(medication.id, { verificationStatus: 'verified' }, dataSteward);
    expect(res.statusCode).toBe(200);
  });

  it('a refusal must say why', async () => {
    const medication = (await createMedication()).json();
    await decide(medication.id, { verificationStatus: 'pending_review' }, dataSteward);
    const bare = await decide(medication.id, { verificationStatus: 'rejected' }, dataSteward);
    expect(bare.statusCode).toBe(400);
    const explained = await decide(
      medication.id,
      { verificationStatus: 'rejected', note: 'Registration withdrawn by the authority' },
      dataSteward,
    );
    expect(explained.statusCode).toBe(200);
    expect(explained.json().verificationNote).toContain('withdrawn');
  });

  it('a caller cannot simply declare a record expired', async () => {
    const medication = (await createMedication()).json();
    const res = await decide(medication.id, { verificationStatus: 'expired' }, dataSteward);
    expect(res.statusCode).toBe(400);
  });

  it('ATTESTING is separate from RECORDING: write alone does not verify', async () => {
    const medication = (await createMedication()).json();
    // A role with medication:read but not medication:verify.
    const res = await decide(medication.id, { verificationStatus: 'pending_review' }, writerOnly);
    expect(res.statusCode).toBe(403);
  });

  it('a field representative cannot verify the drug master', async () => {
    const medication = (await createMedication()).json();
    const res = await decide(medication.id, { verificationStatus: 'pending_review' }, rep);
    expect(res.statusCode).toBe(403);
  });

  it('expiry is DERIVED: a lapsed attestation reads as expired before any sweep', async () => {
    const medication = (await createMedication()).json();
    await decide(medication.id, { verificationStatus: 'pending_review' }, dataSteward);
    await decide(medication.id, { verificationStatus: 'verified' }, dataSteward);
    await getPool().query(
      `UPDATE medication SET verification_expires_at = now() - interval '1 day' WHERE id = $1`,
      [medication.id],
    );
    const read = await app.inject({
      method: 'GET',
      url: `/medications/${medication.id}`,
      headers: auth(dataSteward),
    });
    expect(read.json().verificationStatus).toBe('expired');
  });

  it('the sweep persists the lapse, attributes it to nobody, and is idempotent', async () => {
    const medication = (await createMedication()).json();
    await decide(medication.id, { verificationStatus: 'pending_review' }, dataSteward);
    await decide(medication.id, { verificationStatus: 'verified' }, dataSteward);
    await getPool().query(
      `UPDATE medication SET verification_expires_at = now() - interval '1 day' WHERE id = $1`,
      [medication.id],
    );

    const first = await app.inject({
      method: 'POST',
      url: '/medications/verification/sweep',
      headers: auth(dataSteward),
      payload: {},
    });
    expect(first.json().expired).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: '/medications/verification/sweep',
      headers: auth(dataSteward),
      payload: {},
    });
    expect(second.json().expired).toBe(0);

    const { rows } = await getPool().query<{ change_type: string; changed_by: string | null }>(
      `SELECT change_type, changed_by FROM medication_revision
        WHERE medication_id = $1 ORDER BY record_version DESC LIMIT 1`,
      [medication.id],
    );
    expect(rows[0]!.change_type).toBe('verification_expired');
    expect(rows[0]!.changed_by).toBeNull();
  });

  it('the database refuses an unexplained refusal written directly', async () => {
    const medication = (await createMedication()).json();
    await expect(
      getPool().query(
        `UPDATE medication SET verification_status = 'rejected', verification_note = NULL
          WHERE id = $1`,
        [medication.id],
      ),
    ).rejects.toThrow();
  });

  it('the sweep requires the verify permission and authentication', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/medications/verification/sweep',
      headers: auth(rep),
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: 'POST',
      url: '/medications/verification/sweep',
      payload: {},
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
