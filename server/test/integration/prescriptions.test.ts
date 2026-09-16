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

const bearer = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  nurse = await makeUser(clinicId, 'nurse', RoleKey.NURSE);
  doctor = await makeUser(clinicId, 'doctor', RoleKey.DOCTOR);
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

interface Visit {
  patientId: string;
  encounterId: string;
}

async function startedVisit(name = 'Rx Patient'): Promise<Visit> {
  const patient = (
    await app.inject({
      method: 'POST',
      url: '/patients',
      headers: bearer(reception),
      payload: { fullName: name, sex: 'male' },
    })
  ).json();
  const encounter = (
    await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: bearer(reception),
      payload: { patientId: patient.id },
    })
  ).json();
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/intake`,
    headers: bearer(nurse),
    payload: { chiefComplaint: 'Chest infection' },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/status`,
    headers: bearer(nurse),
    payload: { status: 'ready' },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/start`,
    headers: bearer(doctor),
  });
  return { patientId: patient.id, encounterId: encounter.id };
}

const AMOX = {
  medicationName: 'Amoxicillin',
  dose: '500 mg',
  route: 'oral',
  frequency: 'three times daily',
  durationDays: 7,
};

async function prescribe(
  encounterId: string,
  payload: Record<string, unknown>,
  user: TestUser = doctor,
) {
  return app.inject({
    method: 'POST',
    url: `/encounters/${encounterId}/prescriptions`,
    headers: bearer(user),
    payload,
  });
}

describe('C007 — prescriptions', () => {
  it('issues a prescription with ordered items', async () => {
    const { encounterId } = await startedVisit();
    const res = await prescribe(encounterId, {
      items: [AMOX, { medicationName: 'Paracetamol', dose: '1 g', route: 'oral', frequency: 'as needed' }],
      notes: 'Complete the full course',
    });

    expect(res.statusCode).toBe(201);
    const rx = res.json();
    expect(rx.status).toBe('active');
    expect(rx.prescriberId).toBe(doctor.userId);
    expect(rx.items).toHaveLength(2);
    expect(rx.items[0].lineNo).toBe(1);
    expect(rx.items[0].medicationName).toBe('Amoxicillin');
    expect(rx.items[1].lineNo).toBe(2);

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE type = 'PRESCRIPTION_ISSUED'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('rejects a prescription with no items or an unknown route', async () => {
    const { encounterId } = await startedVisit();
    expect((await prescribe(encounterId, { items: [] })).statusCode).toBe(400);
    expect(
      (await prescribe(encounterId, { items: [{ ...AMOX, route: 'telepathic' }] })).statusCode,
    ).toBe(400);
    expect(
      (await prescribe(encounterId, { items: [{ ...AMOX, durationDays: 0 }] })).statusCode,
    ).toBe(400);
  });

  it('writes the prescription and all its lines atomically', async () => {
    const { encounterId } = await startedVisit();
    // The second line is invalid, so nothing at all may be persisted.
    const res = await prescribe(encounterId, {
      items: [AMOX, { medicationName: 'Bad', dose: '1 g', route: 'oral', frequency: 'x', durationDays: 9999 }],
    });
    expect(res.statusCode).toBe(400);

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM prescription`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('keeps an issued prescription immutable at the database level', async () => {
    const { encounterId } = await startedVisit();
    await prescribe(encounterId, { items: [AMOX] });

    await expect(
      getPool().query(`UPDATE prescription SET notes = 'tampered'`),
    ).rejects.toThrow(/immutable/i);
    await expect(getPool().query(`DELETE FROM prescription`)).rejects.toThrow(/append-only/);
    await expect(
      getPool().query(`UPDATE prescription_item SET dose = '5 g'`),
    ).rejects.toThrow(/append-only/);
    await expect(getPool().query(`DELETE FROM prescription_item`)).rejects.toThrow(/append-only/);
  });

  it('cancels a prescription with a reason and refuses a second cancellation', async () => {
    const { encounterId } = await startedVisit();
    const rx = (await prescribe(encounterId, { items: [AMOX] })).json();

    const res = await app.inject({
      method: 'POST',
      url: `/prescriptions/${rx.id}/cancel`,
      headers: bearer(doctor),
      payload: { reason: 'Patient reported penicillin allergy' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    expect(res.json().cancelledBy).toBe(doctor.userId);
    // The lines survive the cancellation — the record of what was prescribed stays.
    expect(res.json().items).toHaveLength(1);

    const again = await app.inject({
      method: 'POST',
      url: `/prescriptions/${rx.id}/cancel`,
      headers: bearer(doctor),
      payload: { reason: 'Again' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('requires a reason to cancel', async () => {
    const { encounterId } = await startedVisit();
    const rx = (await prescribe(encounterId, { items: [AMOX] })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/prescriptions/${rx.id}/cancel`,
      headers: bearer(doctor),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to prescribe outside an open consultation the doctor holds', async () => {
    const patient = (
      await app.inject({
        method: 'POST',
        url: '/patients',
        headers: bearer(reception),
        payload: { fullName: 'Not Started', sex: 'female' },
      })
    ).json();
    const encounter = (
      await app.inject({
        method: 'POST',
        url: '/encounters/check-in',
        headers: bearer(reception),
        payload: { patientId: patient.id },
      })
    ).json();
    expect((await prescribe(encounter.id, { items: [AMOX] })).statusCode).toBe(409);

    const { encounterId } = await startedVisit('Held Patient');
    const otherDoctor = await makeUser(clinicId, 'doctor2', RoleKey.DOCTOR);
    expect((await prescribe(encounterId, { items: [AMOX] }, otherDoctor)).statusCode).toBe(409);
  });

  it('lets only a doctor prescribe', async () => {
    const { encounterId } = await startedVisit();
    for (const user of [nurse, reception]) {
      expect((await prescribe(encounterId, { items: [AMOX] }, user)).statusCode).toBe(403);
    }
  });

  it('gives a nurse read access to prescriptions and denies reception', async () => {
    const { encounterId, patientId } = await startedVisit();
    await prescribe(encounterId, { items: [AMOX] });

    const nurseRead = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/prescriptions`,
      headers: bearer(nurse),
    });
    expect(nurseRead.statusCode).toBe(200);
    expect(nurseRead.json().prescriptions).toHaveLength(1);

    const receptionRead = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/prescriptions`,
      headers: bearer(reception),
    });
    expect(receptionRead.statusCode).toBe(403);
  });

  it('does not expose a prescription from another clinic', async () => {
    const { encounterId } = await startedVisit();
    const rx = (await prescribe(encounterId, { items: [AMOX] })).json();
    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'doc2', RoleKey.DOCTOR);
    const res = await app.inject({
      method: 'GET',
      url: `/prescriptions/${rx.id}`,
      headers: bearer(otherDoctor),
    });
    expect(res.statusCode).toBe(404);
  });

  it('keeps medication names out of the audit trail and event payloads', async () => {
    const { encounterId } = await startedVisit();
    await prescribe(encounterId, { items: [AMOX] });

    const audit = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'prescription.issue'`,
    );
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toMatch(/amoxicillin/i);
    expect(audit.rows[0]!.metadata.itemCount).toBe(1);

    const events = await getPool().query<{ payload: unknown }>(
      `SELECT payload FROM event WHERE type = 'PRESCRIPTION_ISSUED'`,
    );
    expect(JSON.stringify(events.rows[0]!.payload)).not.toMatch(/amoxicillin/i);
  });

  it('stores a medication reference without coupling to a medication master', async () => {
    const { encounterId } = await startedVisit();
    const res = await prescribe(encounterId, {
      items: [{ ...AMOX, medicationRef: 'rxnorm:723' }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().items[0].medicationRef).toBe('rxnorm:723');
  });
});

describe('C007 — follow-ups', () => {
  async function scheduled(dueOn = '2026-10-01'): Promise<{ visit: Visit; followUpId: string }> {
    const visit = await startedVisit('Follow Up Patient');
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${visit.encounterId}/follow-ups`,
      headers: bearer(doctor),
      payload: { dueOn, reason: 'Review chest x-ray' },
    });
    expect(res.statusCode).toBe(201);
    return { visit, followUpId: res.json().id };
  }

  it('schedules a follow-up from the visit it was decided at', async () => {
    const { visit, followUpId } = await scheduled();
    const res = await app.inject({
      method: 'GET',
      url: `/patients/${visit.patientId}/follow-ups`,
      headers: bearer(doctor),
    });
    const [followUp] = res.json().followUps;
    expect(followUp.id).toBe(followUpId);
    expect(followUp.status).toBe('scheduled');
    expect(followUp.dueOn).toBe('2026-10-01');
    expect(followUp.originEncounterId).toBe(visit.encounterId);
  });

  it('lets reception work the recall list but never schedule one', async () => {
    const { followUpId } = await scheduled('2026-01-05');

    const worklist = await app.inject({
      method: 'GET',
      url: '/follow-ups?dueBefore=2026-02-01',
      headers: bearer(reception),
    });
    expect(worklist.statusCode).toBe(200);
    const entries = worklist.json().followUps;
    expect(entries).toHaveLength(1);
    // The worklist is workable at the front desk: name and MRN are present.
    expect(entries[0].patientName).toBe('Follow Up Patient');
    expect(entries[0].mrn).toMatch(/^MRN-/);

    const close = await app.inject({
      method: 'POST',
      url: `/follow-ups/${followUpId}/close`,
      headers: bearer(reception),
      payload: { status: 'completed' },
    });
    expect(close.statusCode).toBe(200);
    expect(close.json().status).toBe('completed');

    const schedule = await app.inject({
      method: 'POST',
      url: `/encounters/${(await startedVisit('Another')).encounterId}/follow-ups`,
      headers: bearer(reception),
      payload: { dueOn: '2026-11-01' },
    });
    expect(schedule.statusCode).toBe(403);
  });

  it('excludes follow-ups that are not yet due from the worklist', async () => {
    await scheduled('2027-01-01');
    const res = await app.inject({
      method: 'GET',
      url: '/follow-ups?dueBefore=2026-06-01',
      headers: bearer(reception),
    });
    expect(res.json().followUps).toHaveLength(0);
  });

  it('links a completion to the visit that fulfilled it', async () => {
    const { visit, followUpId } = await scheduled();
    const res = await app.inject({
      method: 'POST',
      url: `/follow-ups/${followUpId}/close`,
      headers: bearer(reception),
      payload: { status: 'completed', encounterId: visit.encounterId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().completedEncounterId).toBe(visit.encounterId);
  });

  it('refuses a fulfilling visit belonging to a different patient', async () => {
    const { followUpId } = await scheduled();
    const other = await startedVisit('Different Patient');
    const res = await app.inject({
      method: 'POST',
      url: `/follow-ups/${followUpId}/close`,
      headers: bearer(reception),
      payload: { status: 'completed', encounterId: other.encounterId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a fulfilling visit on a cancellation', async () => {
    const { visit, followUpId } = await scheduled();
    const res = await app.inject({
      method: 'POST',
      url: `/follow-ups/${followUpId}/close`,
      headers: bearer(reception),
      payload: { status: 'cancelled', encounterId: visit.encounterId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to close a follow-up twice', async () => {
    const { followUpId } = await scheduled();
    const close = () =>
      app.inject({
        method: 'POST',
        url: `/follow-ups/${followUpId}/close`,
        headers: bearer(reception),
        payload: { status: 'cancelled' },
      });
    expect((await close()).statusCode).toBe(200);
    expect((await close()).statusCode).toBe(409);
  });

  it('keeps the clinical reason out of the audit trail', async () => {
    await scheduled();
    const { rows } = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'follow_up.schedule'`,
    );
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/chest x-ray/i);
    expect(rows[0]!.metadata.dueOn).toBe('2026-10-01');
  });

  it('does not show another clinic follow-ups on the worklist', async () => {
    await scheduled('2026-01-05');
    const other = await makeClinic('Other Clinic');
    const otherReception = await makeUser(other.clinicId, 'rec2', RoleKey.RECEPTION);
    const res = await app.inject({
      method: 'GET',
      url: '/follow-ups?dueBefore=2026-02-01',
      headers: bearer(otherReception),
    });
    expect(res.json().followUps).toHaveLength(0);
  });
});

describe('C007 — integration with the rest of the record', () => {
  it('shows prescriptions and follow-ups on the encounter workspace', async () => {
    const { encounterId } = await startedVisit();
    await prescribe(encounterId, { items: [AMOX] });
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/follow-ups`,
      headers: bearer(doctor),
      payload: { dueOn: '2026-10-01' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/encounters/${encounterId}`,
      headers: bearer(doctor),
    });
    expect(res.json().prescriptions).toHaveLength(1);
    expect(res.json().followUps).toHaveLength(1);

    // Reception sees the follow-up (it works the recall list) but no prescription.
    const asReception = await app.inject({
      method: 'GET',
      url: `/encounters/${encounterId}`,
      headers: bearer(reception),
    });
    expect(asReception.json()).toHaveProperty('followUps');
    expect(asReception.json()).not.toHaveProperty('prescriptions');
  });

  it('shows prescriptions and follow-ups on the patient timeline', async () => {
    const { encounterId, patientId } = await startedVisit();
    await prescribe(encounterId, { items: [AMOX] });
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/follow-ups`,
      headers: bearer(doctor),
      payload: { dueOn: '2026-10-01', reason: 'Review chest x-ray' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/timeline`,
      headers: bearer(doctor),
    });
    const entries = res.json().entries as Array<{
      kind: string;
      summary: string | null;
      detail: Record<string, unknown>;
    }>;
    const rx = entries.find((e) => e.kind === 'prescription');
    expect(rx?.detail.items).toEqual(['Amoxicillin']);
    const followUp = entries.find((e) => e.kind === 'follow_up');
    expect(followUp?.summary).toBe('Review chest x-ray');
    expect(followUp?.detail.status).toBe('scheduled');
  });

  it('prints prescriptions and follow-ups on the encounter report', async () => {
    const { encounterId } = await startedVisit();
    await prescribe(encounterId, { items: [AMOX] });
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/follow-ups`,
      headers: bearer(doctor),
      payload: { dueOn: '2026-10-01', reason: 'Review chest x-ray' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/reports/encounter/${encounterId}.pdf`,
      headers: bearer(doctor),
    });
    const text = res.rawPayload.toString('latin1');
    expect(text).toContain('Prescriptions');
    expect(text).toContain('Amoxicillin');
    expect(text).toContain('500 mg');
    expect(text).toContain('for 7 days');
    expect(text).toContain('Due 2026-10-01');
  });
});
