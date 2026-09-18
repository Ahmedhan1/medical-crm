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
let doctorTwo: TestUser;

const bearer = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  nurse = await makeUser(clinicId, 'nurse', RoleKey.NURSE);
  doctor = await makeUser(clinicId, 'doctor', RoleKey.DOCTOR);
  doctorTwo = await makeUser(clinicId, 'doctor2', RoleKey.DOCTOR);
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

async function newPatient(name = 'Referral Patient', user: TestUser = reception) {
  return (
    await app.inject({ method: 'POST', url: '/patients', headers: bearer(user), payload: { fullName: name, sex: 'male' } })
  ).json();
}

async function create(payload: Record<string, unknown>, user: TestUser = doctor) {
  return app.inject({ method: 'POST', url: '/referrals', headers: bearer(user), payload });
}

async function transition(id: string, payload: Record<string, unknown>, user: TestUser = doctor) {
  return app.inject({ method: 'POST', url: `/referrals/${id}/status`, headers: bearer(user), payload });
}

const EXTERNAL = (patientId: string, over: Record<string, unknown> = {}) => ({
  patientId,
  direction: 'external',
  receivingSpecialty: 'Cardiology',
  receivingProvider: 'City Heart Centre',
  reason: 'Evaluation of chest pain',
  urgency: 'urgent',
  ...over,
});

describe('Phase 10 — creating referrals', () => {
  it('creates an external referral as a draft by default', async () => {
    const patient = await newPatient();
    const res = await create(EXTERNAL(patient.id));
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('draft');
    expect(res.json().referringPractitionerId).toBe(doctor.userId);

    const { rows } = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM event WHERE type = 'REFERRAL_CREATED'`);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('creates and orders in one step', async () => {
    const patient = await newPatient();
    const res = await create(EXTERNAL(patient.id, { order: true }));
    expect(res.json().status).toBe('ordered');
  });

  it('requires a receiving practitioner for an internal referral', async () => {
    const patient = await newPatient();
    const bad = await create({ patientId: patient.id, direction: 'internal', reason: 'Second opinion' });
    expect(bad.statusCode).toBe(400);
    const ok = await create({ patientId: patient.id, direction: 'internal', receivingPractitionerId: doctorTwo.userId, reason: 'Second opinion' });
    expect(ok.statusCode).toBe(201);
  });

  it('requires a provider or specialty for an external referral', async () => {
    const patient = await newPatient();
    const bad = await create({ patientId: patient.id, direction: 'external', reason: 'x' });
    expect(bad.statusCode).toBe(400);
  });

  it('keeps the clinical reason out of the event payload and audit metadata', async () => {
    const patient = await newPatient();
    await create(EXTERNAL(patient.id, { reason: 'Suspected aortic dissection' }));
    const events = await getPool().query<{ payload: unknown }>(`SELECT payload FROM event WHERE type = 'REFERRAL_CREATED'`);
    expect(JSON.stringify(events.rows[0]!.payload)).not.toMatch(/dissection/i);
    const audit = await getPool().query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM audit_log WHERE action = 'referral.create'`);
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toMatch(/dissection/i);
  });
});

describe('Phase 10 — lifecycle', () => {
  async function ordered(patientName = 'Lifecycle Patient') {
    const patient = await newPatient(patientName);
    const referral = (await create(EXTERNAL(patient.id, { order: true }))).json();
    return { patient, referral };
  }

  it('runs the happy path ordered → sent → accepted → scheduled → completed', async () => {
    const { referral } = await ordered();
    expect((await transition(referral.id, { status: 'sent' }, reception)).json().status).toBe('sent');
    expect((await transition(referral.id, { status: 'accepted' }, reception)).json().status).toBe('accepted');
    expect((await transition(referral.id, { status: 'scheduled' }, reception)).json().status).toBe('scheduled');
    const completed = await transition(referral.id, { status: 'completed' }, doctor);
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe('completed');
    expect(completed.json().completedAt).toBeTruthy();

    const detail = await app.inject({ method: 'GET', url: `/referrals/${referral.id}`, headers: bearer(doctor) });
    expect(detail.json().history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'ordered', 'sent', 'accepted', 'scheduled', 'completed',
    ]);
  });

  it('rejects an invalid transition', async () => {
    const { referral } = await ordered();
    // ordered cannot jump straight to completed.
    const res = await transition(referral.id, { status: 'completed' }, doctor);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.allowed).toContain('sent');
  });

  it('records decline and cancel with a reason and emits events', async () => {
    const a = await ordered('Declined Patient');
    await transition(a.referral.id, { status: 'sent' }, reception);
    const declined = await transition(a.referral.id, { status: 'declined', reason: 'Provider full' }, reception);
    expect(declined.json().status).toBe('declined');
    expect(declined.json().closureReason).toBe('Provider full');

    const b = await ordered('Cancelled Patient');
    const cancelled = await transition(b.referral.id, { status: 'cancelled', reason: 'Patient improved' }, reception);
    expect(cancelled.json().status).toBe('cancelled');

    const { rows } = await getPool().query<{ type: string }>(`SELECT type FROM event WHERE type IN ('REFERRAL_DECLINED','REFERRAL_CANCELLED') ORDER BY type`);
    expect(rows.map((r) => r.type)).toEqual(['REFERRAL_CANCELLED', 'REFERRAL_DECLINED']);
  });

  it('refuses to transition a terminal referral', async () => {
    const { referral } = await ordered();
    await transition(referral.id, { status: 'cancelled', reason: 'x' }, reception);
    expect((await transition(referral.id, { status: 'sent' }, reception)).statusCode).toBe(409);
  });

  it('keeps the status history append-only', async () => {
    const { referral } = await ordered();
    await transition(referral.id, { status: 'sent' }, reception);
    await expect(getPool().query(`UPDATE referral_status_history SET to_status = 'x'`)).rejects.toThrow(/append-only/);
    await expect(getPool().query(`DELETE FROM referral_status_history`)).rejects.toThrow(/append-only/);
  });
});

describe('Phase 10 — coordination linkage', () => {
  it('links a scheduled referral to an appointment for the same patient', async () => {
    const patient = await newPatient();
    const referral = (await create(EXTERNAL(patient.id, { order: true }))).json();
    await transition(referral.id, { status: 'sent' }, reception);
    await transition(referral.id, { status: 'accepted' }, reception);

    const appointment = (
      await app.inject({
        method: 'POST',
        url: '/appointments',
        headers: bearer(reception),
        payload: { patientId: patient.id, startsAt: new Date(Date.UTC(2026, 11, 1, 9)).toISOString(), durationMinutes: 30 },
      })
    ).json();

    const res = await transition(referral.id, { status: 'scheduled', appointmentId: appointment.id }, reception);
    expect(res.statusCode).toBe(200);
    expect(res.json().linkedAppointmentId).toBe(appointment.id);
  });

  it('refuses to link an appointment belonging to another patient', async () => {
    const patient = await newPatient('Own Patient');
    const other = await newPatient('Other Patient');
    const referral = (await create(EXTERNAL(patient.id, { order: true }))).json();
    await transition(referral.id, { status: 'sent' }, reception);
    await transition(referral.id, { status: 'accepted' }, reception);

    const otherAppt = (
      await app.inject({
        method: 'POST',
        url: '/appointments',
        headers: bearer(reception),
        payload: { patientId: other.id, startsAt: new Date(Date.UTC(2026, 11, 1, 9)).toISOString(), durationMinutes: 30 },
      })
    ).json();

    const res = await transition(referral.id, { status: 'scheduled', appointmentId: otherAppt.id }, reception);
    expect(res.statusCode).toBe(400);
  });

  it('refuses to link a document belonging to another patient', async () => {
    const patient = await newPatient('Doc Own');
    const other = await newPatient('Doc Other');
    const referral = (await create(EXTERNAL(patient.id, { order: true }))).json();
    const otherDoc = (
      await app.inject({
        method: 'POST',
        url: '/documents',
        headers: bearer(reception),
        payload: { patientId: other.id, docType: 'referral', title: 'Letter', contentType: 'application/pdf', storageKey: 's3://b/other' },
      })
    ).json();
    const res = await transition(referral.id, { status: 'sent', documentId: otherDoc.id }, reception);
    expect(res.statusCode).toBe(400);
  });

  it('shows referrals on the patient timeline', async () => {
    const patient = await newPatient();
    await create(EXTERNAL(patient.id, { order: true, reason: 'Cardiology review' }));
    const timeline = await app.inject({ method: 'GET', url: `/patients/${patient.id}/timeline`, headers: bearer(doctor) });
    const entry = timeline.json().entries.find((e: { kind: string }) => e.kind === 'referral');
    expect(entry).toBeTruthy();
    expect(entry.summary).toBe('Cardiology review');
    expect(entry.detail.specialty).toBe('Cardiology');
    expect(entry.detail.status).toBe('ordered');
  });

  it('shows referrals on Patient 360', async () => {
    const patient = await newPatient();
    await create(EXTERNAL(patient.id, { order: true }));
    const v = (await app.inject({ method: 'GET', url: `/patients/${patient.id}/360`, headers: bearer(doctor) })).json();
    expect(v.referrals).toHaveLength(1);
  });
});

describe('Phase 10 — clinical authority (red team)', () => {
  it('reception CANNOT create a clinical referral', async () => {
    const patient = await newPatient();
    const res = await create(EXTERNAL(patient.id), reception);
    expect(res.statusCode).toBe(403);
  });

  it('nurse CANNOT create or transition a referral', async () => {
    const patient = await newPatient();
    const referral = (await create(EXTERNAL(patient.id, { order: true }))).json();
    expect((await create(EXTERNAL(patient.id), nurse)).statusCode).toBe(403);
    expect((await transition(referral.id, { status: 'sent' }, nurse)).statusCode).toBe(403);
    // But nurse may read.
    expect((await app.inject({ method: 'GET', url: `/referrals/${referral.id}`, headers: bearer(nurse) })).statusCode).toBe(200);
  });

  it('reception CANNOT complete a referral (clinical outcome)', async () => {
    const patient = await newPatient();
    const referral = (await create(EXTERNAL(patient.id, { order: true }))).json();
    await transition(referral.id, { status: 'sent' }, reception);
    await transition(referral.id, { status: 'accepted' }, reception);
    const res = await transition(referral.id, { status: 'completed' }, reception);
    expect(res.statusCode).toBe(403);
  });

  it('rejects a forged patient id and a forged receiving practitioner id', async () => {
    const fake = '00000000-0000-0000-0000-000000000000';
    expect((await create(EXTERNAL(fake))).statusCode).toBe(404);
    const patient = await newPatient();
    const res = await create({ patientId: patient.id, direction: 'internal', receivingPractitionerId: fake, reason: 'x' });
    expect(res.statusCode).toBe(400);
  });

  it('is tenant-isolated: no cross-clinic read, transition, or practitioner target', async () => {
    const patient = await newPatient();
    const referral = (await create(EXTERNAL(patient.id, { order: true }))).json();

    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'odoc', RoleKey.DOCTOR);
    const otherReception = await makeUser(other.clinicId, 'orec', RoleKey.RECEPTION);

    expect((await app.inject({ method: 'GET', url: `/referrals/${referral.id}`, headers: bearer(otherDoctor) })).statusCode).toBe(404);
    expect((await transition(referral.id, { status: 'sent' }, otherReception)).statusCode).toBe(404);

    const list = await app.inject({ method: 'GET', url: '/referrals', headers: bearer(otherDoctor) });
    expect(list.json().referrals).toHaveLength(0);

    // A practitioner from another clinic cannot be an internal target.
    const cross = await create({ patientId: patient.id, direction: 'internal', receivingPractitionerId: otherDoctor.userId, reason: 'x' });
    expect(cross.statusCode).toBe(400);
  });

  it('denies referrals to a pharma rep entirely', async () => {
    const patient = await newPatient();
    const referral = (await create(EXTERNAL(patient.id, { order: true }))).json();
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    expect((await create(EXTERNAL(patient.id), pharma)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/referrals/${referral.id}`, headers: bearer(pharma) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/referrals', headers: bearer(pharma) })).statusCode).toBe(403);
  });
});
