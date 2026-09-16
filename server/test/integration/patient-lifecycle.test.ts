import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;
let clinicId: string;
let reception: TestUser;
let nurse: TestUser;
let doctor: TestUser;
let admin: TestUser;

const bearer = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  nurse = await makeUser(clinicId, 'nurse', RoleKey.NURSE);
  doctor = await makeUser(clinicId, 'doctor', RoleKey.DOCTOR);
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

async function register(
  payload: Record<string, unknown>,
  user: TestUser = reception,
): Promise<Record<string, any>> {
  const res = await app.inject({
    method: 'POST',
    url: '/patients',
    headers: bearer(user),
    payload: { sex: 'male', ...payload },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function auditMeta(action: string): Promise<Record<string, unknown>[]> {
  const { rows } = await getPool().query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM audit_log WHERE action = $1 ORDER BY id`,
    [action],
  );
  return rows.map((r) => r.metadata);
}

describe('Phase 1 — date-only fields', () => {
  it('returns a date of birth as a plain date, not a timestamp', async () => {
    // A `date` column arrives from pg as a JS Date; serialized naively it becomes
    // "1980-04-02T00:00:00.000Z", which renders as the PREVIOUS day west of UTC.
    // For a date of birth that is an identification error.
    const patient = await register({ fullName: 'Date Patient', birthDate: '1980-04-02' });
    expect(patient.birthDate).toBe('1980-04-02');

    const fetched = (
      await app.inject({
        method: 'GET',
        url: `/patients/${patient.id}`,
        headers: bearer(reception),
      })
    ).json();
    expect(fetched.birthDate).toBe('1980-04-02');
  });
});

describe('Phase 1 — patient demographics', () => {
  it('registers with a default active status', async () => {
    const patient = await register({ fullName: 'Status Default' });
    expect(patient.status).toBe('active');
    expect(patient.mergedIntoId).toBeNull();
    expect(patient.deceasedDate).toBeNull();
  });

  it('updates demographics and records only the field names in the trail', async () => {
    const patient = await register({ fullName: 'Original Name' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/patients/${patient.id}`,
      headers: bearer(reception),
      payload: {
        fullName: 'Corrected Name',
        email: 'corrected@example.com',
        preferredLanguage: 'ar-EG',
        address: '12 Clinic Street',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fullName).toBe('Corrected Name');
    expect(res.json().preferredLanguage).toBe('ar-EG');

    const [meta] = await auditMeta('patient.update');
    expect(meta!.fields).toEqual(
      expect.arrayContaining(['fullName', 'email', 'preferredLanguage', 'address']),
    );
    // The new values identify the patient and must not be in the audit trail.
    expect(JSON.stringify(meta)).not.toMatch(/Corrected Name|corrected@example|Clinic Street/);
  });

  it('distinguishes an omitted field from an explicit null', async () => {
    const patient = await register({ fullName: 'Partial Patient', phone: '+201000000001' });
    await app.inject({
      method: 'PATCH',
      url: `/patients/${patient.id}`,
      headers: bearer(reception),
      payload: { address: 'Somewhere' },
    });
    const afterOmit = (
      await app.inject({ method: 'GET', url: `/patients/${patient.id}`, headers: bearer(reception) })
    ).json();
    // phone was not mentioned, so it survives.
    expect(afterOmit.phone).toBe('+201000000001');

    await app.inject({
      method: 'PATCH',
      url: `/patients/${patient.id}`,
      headers: bearer(reception),
      payload: { phone: null },
    });
    const afterNull = (
      await app.inject({ method: 'GET', url: `/patients/${patient.id}`, headers: bearer(reception) })
    ).json();
    expect(afterNull.phone).toBeNull();
    expect(afterNull.address).toBe('Somewhere');
  });

  it('rejects an empty patch and a malformed language tag', async () => {
    const patient = await register({ fullName: 'Validation Patient' });
    for (const payload of [{}, { preferredLanguage: 'Egyptian Arabic' }, { email: 'not-an-email' }]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/patients/${patient.id}`,
        headers: bearer(reception),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('denies demographic updates to nurse and doctor', async () => {
    const patient = await register({ fullName: 'Guarded Patient' });
    for (const user of [nurse, doctor]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/patients/${patient.id}`,
        headers: bearer(user),
        payload: { address: 'Should not apply' },
      });
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('Phase 1 — patient status', () => {
  it('marks a patient deceased with a date and blocks further check-in', async () => {
    const patient = await register({ fullName: 'Deceased Patient' });
    const res = await app.inject({
      method: 'POST',
      url: `/patients/${patient.id}/status`,
      headers: bearer(reception),
      payload: { status: 'deceased', deceasedDate: '2026-08-01' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('deceased');
    expect(res.json().deceasedDate).toBe('2026-08-01');

    const checkIn = await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: bearer(reception),
      payload: { patientId: patient.id },
    });
    expect(checkIn.statusCode).toBe(409);
  });

  it('refuses a deceased date on a non-deceased status', async () => {
    const patient = await register({ fullName: 'Bad Status' });
    const res = await app.inject({
      method: 'POST',
      url: `/patients/${patient.id}/status`,
      headers: bearer(reception),
      payload: { status: 'inactive', deceasedDate: '2026-08-01' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to reopen a deceased record and refuses a no-op change', async () => {
    const patient = await register({ fullName: 'Terminal Status' });
    await app.inject({
      method: 'POST',
      url: `/patients/${patient.id}/status`,
      headers: bearer(reception),
      payload: { status: 'deceased' },
    });
    const reopen = await app.inject({
      method: 'POST',
      url: `/patients/${patient.id}/status`,
      headers: bearer(reception),
      payload: { status: 'active' },
    });
    expect(reopen.statusCode).toBe(409);

    const other = await register({ fullName: 'Already Active' });
    const noop = await app.inject({
      method: 'POST',
      url: `/patients/${other.id}/status`,
      headers: bearer(reception),
      payload: { status: 'active' },
    });
    expect(noop.statusCode).toBe(409);
  });

  it('still allows an inactive patient to be seen', async () => {
    const patient = await register({ fullName: 'Returning Patient' });
    await app.inject({
      method: 'POST',
      url: `/patients/${patient.id}/status`,
      headers: bearer(reception),
      payload: { status: 'inactive' },
    });
    const checkIn = await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: bearer(reception),
      payload: { patientId: patient.id },
    });
    expect(checkIn.statusCode).toBe(201);
  });
});

describe('Phase 1 — external identifiers', () => {
  it('records and lists identifiers without the value reaching the audit trail', async () => {
    const patient = await register({ fullName: 'Identified Patient' });
    const res = await app.inject({
      method: 'POST',
      url: `/patients/${patient.id}/identifiers`,
      headers: bearer(reception),
      payload: { system: 'passport:EG', value: 'A12345678', issuedOn: '2024-01-01' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().value).toBe('A12345678');
    expect(res.json().issuedOn).toBe('2024-01-01');

    const list = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/identifiers`,
      headers: bearer(doctor),
    });
    expect(list.json().identifiers).toHaveLength(1);

    const [meta] = await auditMeta('patient.identifier.add');
    expect(meta!.system).toBe('passport:EG');
    expect(JSON.stringify(meta)).not.toContain('A12345678');
  });

  it('refuses the same identifier on two records and points at the duplicate', async () => {
    const first = await register({ fullName: 'First Record' });
    const second = await register({ fullName: 'Second Record' });
    const payload = { system: 'passport:EG', value: 'DUP-1' };

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/patients/${first.id}/identifiers`,
          headers: bearer(reception),
          payload,
        })
      ).statusCode,
    ).toBe(201);

    const clash = await app.inject({
      method: 'POST',
      url: `/patients/${second.id}/identifiers`,
      headers: bearer(reception),
      payload,
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toMatch(/duplicate/i);
  });

  it('rejects an expiry before its issue date', async () => {
    const patient = await register({ fullName: 'Bad Dates' });
    const res = await app.inject({
      method: 'POST',
      url: `/patients/${patient.id}/identifiers`,
      headers: bearer(reception),
      payload: { system: 'insurance', value: 'X1', issuedOn: '2026-01-01', expiresOn: '2025-01-01' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('lets clinicians read identifiers but not write them', async () => {
    const patient = await register({ fullName: 'Read Only' });
    const write = await app.inject({
      method: 'POST',
      url: `/patients/${patient.id}/identifiers`,
      headers: bearer(nurse),
      payload: { system: 'passport:EG', value: 'N1' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('removes an identifier', async () => {
    const patient = await register({ fullName: 'Removable' });
    const created = (
      await app.inject({
        method: 'POST',
        url: `/patients/${patient.id}/identifiers`,
        headers: bearer(reception),
        payload: { system: 'passport:EG', value: 'RM-1' },
      })
    ).json();
    const res = await app.inject({
      method: 'DELETE',
      url: `/patients/${patient.id}/identifiers/${created.id}`,
      headers: bearer(reception),
    });
    expect(res.statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/identifiers`,
      headers: bearer(reception),
    });
    expect(list.json().identifiers).toHaveLength(0);
  });
});

describe('Phase 1 — emergency contacts', () => {
  it('records a contact and demotes the previous primary of the same kind', async () => {
    const patient = await register({ fullName: 'Contact Patient' });
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/patients/${patient.id}/contacts`,
        headers: bearer(reception),
        payload,
      });

    expect(
      (await post({ fullName: 'First Contact', phone: '+201000000001', isPrimary: true })).statusCode,
    ).toBe(201);
    expect(
      (await post({ fullName: 'Second Contact', phone: '+201000000002', isPrimary: true })).statusCode,
    ).toBe(201);

    const list = (
      await app.inject({
        method: 'GET',
        url: `/patients/${patient.id}/contacts`,
        headers: bearer(doctor),
      })
    ).json().contacts;
    expect(list).toHaveLength(2);
    const primaries = list.filter((c: { isPrimary: boolean }) => c.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].fullName).toBe('Second Contact');
  });

  it('refuses a contact with no way to reach them', async () => {
    const patient = await register({ fullName: 'Unreachable Contact' });
    const res = await app.inject({
      method: 'POST',
      url: `/patients/${patient.id}/contacts`,
      headers: bearer(reception),
      payload: { fullName: 'No Details' },
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps the contact's identity out of the audit trail", async () => {
    const patient = await register({ fullName: 'Audited Contact' });
    await app.inject({
      method: 'POST',
      url: `/patients/${patient.id}/contacts`,
      headers: bearer(reception),
      payload: { fullName: 'Fatima Hassan', phone: '+201234567890', relationship: 'sister' },
    });
    const [meta] = await auditMeta('patient.contact.add');
    expect(meta!.kind).toBe('emergency');
    expect(JSON.stringify(meta)).not.toMatch(/Fatima|201234567890|sister/i);
  });
});

describe('Phase 1 — duplicate detection and merge', () => {
  it('surfaces candidates with the reason they matched', async () => {
    const original = await register({
      fullName: 'Mohamed Ali',
      birthDate: '1990-05-05',
      phone: '+201111111111',
    });
    await register({ fullName: 'mohamed ali', birthDate: '1990-05-05' });
    await register({ fullName: 'Unrelated Person', birthDate: '1975-01-01' });

    const res = await app.inject({
      method: 'GET',
      url: `/patients/${original.id}/duplicates`,
      headers: bearer(reception),
    });
    expect(res.statusCode).toBe(200);
    const candidates = res.json().candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].patient.fullName).toBe('mohamed ali');
    expect(candidates[0].matchedOn).toContain('nameAndBirthDate');
  });

  it('ignores a candidate that shares nothing', async () => {
    const patient = await register({ fullName: 'Lonely Patient', birthDate: '1991-02-03' });
    await register({ fullName: 'Nobody Related', birthDate: '1960-07-07' });
    const candidates = (
      await app.inject({
        method: 'GET',
        url: `/patients/${patient.id}/duplicates`,
        headers: bearer(reception),
      })
    ).json().candidates;
    expect(candidates).toHaveLength(0);
  });

  it('matches on a shared national id and on a shared phone', async () => {
    const original = await register({
      fullName: 'Signal Original',
      nationalId: '29001011234567',
      phone: '+201555555555',
    });
    // Same phone, different person's name — a weaker but real signal.
    await register({ fullName: 'Shared Phone Household', phone: '+201555555555' });

    const candidates = (
      await app.inject({
        method: 'GET',
        url: `/patients/${original.id}/duplicates`,
        headers: bearer(reception),
      })
    ).json().candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].matchedOn).toEqual(['phone']);
  });

  it('merges a duplicate into the survivor and preserves both records', async () => {
    const survivor = await register({ fullName: 'Survivor Record', phone: '+201222222222' });
    const duplicate = await register({ fullName: 'Duplicate Record' });

    const res = await app.inject({
      method: 'POST',
      url: `/patients/${survivor.id}/merge`,
      headers: bearer(admin),
      payload: { sourcePatientId: duplicate.id, reason: 'Same person registered twice' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().survivor.id).toBe(survivor.id);
    expect(res.json().survivor.status).toBe('active');
    expect(res.json().merged.status).toBe('merged');
    expect(res.json().merged.mergedIntoId).toBe(survivor.id);

    // Nothing was deleted: the duplicate is still readable, clearly marked.
    const stillThere = await app.inject({
      method: 'GET',
      url: `/patients/${duplicate.id}`,
      headers: bearer(reception),
    });
    expect(stillThere.statusCode).toBe(200);
    expect(stillThere.json().status).toBe('merged');
  });

  it('carries the merged record history onto the survivor timeline', async () => {
    const survivor = await register({ fullName: 'History Survivor' });
    const duplicate = await register({ fullName: 'History Duplicate' });

    // Give the duplicate a visit with clinical content.
    const encounter = (
      await app.inject({
        method: 'POST',
        url: '/encounters/check-in',
        headers: bearer(reception),
        payload: { patientId: duplicate.id },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounter.id}/intake`,
      headers: bearer(nurse),
      payload: { chiefComplaint: 'Recorded against the duplicate' },
    });

    const before = (
      await app.inject({
        method: 'GET',
        url: `/patients/${survivor.id}/timeline`,
        headers: bearer(doctor),
      })
    ).json().entries;
    expect(before).toHaveLength(0);

    await app.inject({
      method: 'POST',
      url: `/patients/${survivor.id}/merge`,
      headers: bearer(admin),
      payload: { sourcePatientId: duplicate.id, reason: 'Duplicate registration' },
    });

    const after = (
      await app.inject({
        method: 'GET',
        url: `/patients/${survivor.id}/timeline`,
        headers: bearer(doctor),
      })
    ).json().entries;
    const complaints = after.map((e: { summary: string | null }) => e.summary);
    expect(complaints).toContain('Recorded against the duplicate');
  });

  it('blocks writes and check-in against a merged record', async () => {
    const survivor = await register({ fullName: 'Write Survivor' });
    const duplicate = await register({ fullName: 'Write Duplicate' });
    await app.inject({
      method: 'POST',
      url: `/patients/${survivor.id}/merge`,
      headers: bearer(admin),
      payload: { sourcePatientId: duplicate.id, reason: 'Duplicate registration' },
    });

    const update = await app.inject({
      method: 'PATCH',
      url: `/patients/${duplicate.id}`,
      headers: bearer(reception),
      payload: { address: 'New address' },
    });
    expect(update.statusCode).toBe(409);
    expect(update.json().error.details.mergedIntoId).toBe(survivor.id);

    const checkIn = await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: bearer(reception),
      payload: { patientId: duplicate.id },
    });
    expect(checkIn.statusCode).toBe(409);
  });

  it('refuses a second merge, a self-merge and a merge into a merged record', async () => {
    const a = await register({ fullName: 'Merge A' });
    const b = await register({ fullName: 'Merge B' });
    const c = await register({ fullName: 'Merge C' });
    const merge = (target: string, source: string) =>
      app.inject({
        method: 'POST',
        url: `/patients/${target}/merge`,
        headers: bearer(admin),
        payload: { sourcePatientId: source, reason: 'Duplicate registration' },
      });

    expect((await merge(a.id, b.id)).statusCode).toBe(200);
    // b is already merged away.
    expect((await merge(c.id, b.id)).statusCode).toBe(409);
    // b is not a valid destination either.
    expect((await merge(b.id, c.id)).statusCode).toBe(409);
    // a has a dependent, so it cannot itself be merged away.
    expect((await merge(c.id, a.id)).statusCode).toBe(409);
    // self-merge.
    expect((await merge(a.id, a.id)).statusCode).toBe(400);
  });

  it('records the merge in an append-only ledger', async () => {
    const survivor = await register({ fullName: 'Ledger Survivor' });
    const duplicate = await register({ fullName: 'Ledger Duplicate' });
    await app.inject({
      method: 'POST',
      url: `/patients/${survivor.id}/merge`,
      headers: bearer(admin),
      payload: { sourcePatientId: duplicate.id, reason: 'Registered twice at reception' },
    });

    const { rows } = await getPool().query<{ reason: string; source_patient_id: string }>(
      `SELECT reason, source_patient_id FROM patient_merge`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('Registered twice at reception');

    await expect(
      getPool().query(`UPDATE patient_merge SET reason = 'tampered'`),
    ).rejects.toThrow(/append-only/);
    await expect(getPool().query(`DELETE FROM patient_merge`)).rejects.toThrow(/append-only/);

    // The free-text reason is not duplicated into the audit metadata.
    const [meta] = await auditMeta('patient.merge');
    expect(JSON.stringify(meta)).not.toMatch(/Registered twice/);
  });

  it('lets only an administrator merge records', async () => {
    const survivor = await register({ fullName: 'Authz Survivor' });
    const duplicate = await register({ fullName: 'Authz Duplicate' });
    for (const user of [reception, nurse, doctor]) {
      const res = await app.inject({
        method: 'POST',
        url: `/patients/${survivor.id}/merge`,
        headers: bearer(user),
        payload: { sourcePatientId: duplicate.id, reason: 'Duplicate registration' },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('keeps lifecycle data inside the clinic boundary', async () => {
    const patient = await register({ fullName: 'Tenant Patient' });
    const other = await makeClinic('Other Clinic');
    const otherReception = await makeUser(other.clinicId, 'rec2', RoleKey.RECEPTION);
    const otherAdmin = await makeUser(other.clinicId, 'admin2', RoleKey.ADMIN);

    for (const call of [
      { method: 'PATCH' as const, url: `/patients/${patient.id}`, payload: { address: 'x' }, user: otherReception },
      { method: 'GET' as const, url: `/patients/${patient.id}/contacts`, user: otherReception },
      { method: 'GET' as const, url: `/patients/${patient.id}/identifiers`, user: otherReception },
      { method: 'GET' as const, url: `/patients/${patient.id}/duplicates`, user: otherReception },
    ]) {
      const res = await app.inject({
        method: call.method,
        url: call.url,
        headers: bearer(call.user),
        ...(call.payload ? { payload: call.payload } : {}),
      });
      expect(res.statusCode).toBe(404);
    }

    const theirPatient = await register({ fullName: 'Their Patient' }, otherReception);
    const crossMerge = await app.inject({
      method: 'POST',
      url: `/patients/${theirPatient.id}/merge`,
      headers: bearer(otherAdmin),
      payload: { sourcePatientId: patient.id, reason: 'Cross tenant attempt' },
    });
    expect(crossMerge.statusCode).toBe(404);
  });
});
