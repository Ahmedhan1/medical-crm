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

/** A fixed future window keeps the assertions deterministic. */
const T = (hour: number, minute = 0): string =>
  new Date(Date.UTC(2026, 10, 2, hour, minute, 0)).toISOString();

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

async function newPatient(name = 'Appointment Patient', user: TestUser = reception) {
  const res = await app.inject({
    method: 'POST',
    url: '/patients',
    headers: bearer(user),
    payload: { fullName: name, sex: 'female' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function newRoom(name = 'Room 1') {
  const res = await app.inject({
    method: 'POST',
    url: '/schedule/resources',
    headers: bearer(admin),
    payload: { kind: 'room', name },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function book(payload: Record<string, unknown>, user: TestUser = reception) {
  return app.inject({
    method: 'POST',
    url: '/appointments',
    headers: bearer(user),
    payload,
  });
}

async function setStatus(
  appointmentId: string,
  payload: Record<string, unknown>,
  user: TestUser = reception,
) {
  return app.inject({
    method: 'POST',
    url: `/appointments/${appointmentId}/status`,
    headers: bearer(user),
    payload,
  });
}

describe('Phase 2 — scheduling configuration', () => {
  it('creates appointment types and resources as configuration, not code', async () => {
    const type = await app.inject({
      method: 'POST',
      url: '/appointment-types',
      headers: bearer(admin),
      payload: { key: 'derm_followup', name: 'Dermatology follow-up', defaultDurationMinutes: 15 },
    });
    expect(type.statusCode).toBe(201);
    expect(type.json().defaultDurationMinutes).toBe(15);

    const room = await newRoom('Consulting Room A');
    expect(room.kind).toBe('room');

    const types = await app.inject({
      method: 'GET',
      url: '/appointment-types',
      headers: bearer(doctor),
    });
    expect(types.json().appointmentTypes).toHaveLength(1);
  });

  it('rejects a malformed type key and a duplicate', async () => {
    const payload = { key: 'derm_followup', name: 'Derm', defaultDurationMinutes: 15 };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/appointment-types',
          headers: bearer(admin),
          payload: { ...payload, key: 'Not A Key' },
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (await app.inject({ method: 'POST', url: '/appointment-types', headers: bearer(admin), payload }))
        .statusCode,
    ).toBe(201);
    const dup = await app.inject({
      method: 'POST',
      url: '/appointment-types',
      headers: bearer(admin),
      payload,
    });
    expect(dup.statusCode).toBe(409);
  });

  it('lets only an administrator manage scheduling configuration', async () => {
    for (const user of [reception, nurse, doctor]) {
      const res = await app.inject({
        method: 'POST',
        url: '/schedule/resources',
        headers: bearer(user),
        payload: { kind: 'room', name: 'Unauthorized Room' },
      });
      expect(res.statusCode).toBe(403);
    }
    // But they can all read it.
    const read = await app.inject({
      method: 'GET',
      url: '/schedule/resources',
      headers: bearer(nurse),
    });
    expect(read.statusCode).toBe(200);
  });
});

describe('Phase 2 — booking', () => {
  it('books an appointment and derives the end from the type duration', async () => {
    const patient = await newPatient();
    const type = (
      await app.inject({
        method: 'POST',
        url: '/appointment-types',
        headers: bearer(admin),
        payload: { key: 'consult', name: 'Consultation', defaultDurationMinutes: 30 },
      })
    ).json();

    const res = await book({
      patientId: patient.id,
      appointmentTypeId: type.id,
      practitionerId: doctor.userId,
      startsAt: T(9),
    });
    expect(res.statusCode).toBe(201);
    const appointment = res.json();
    expect(appointment.status).toBe('scheduled');
    expect(new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()).toBe(
      30 * 60_000,
    );

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE type = 'APPOINTMENT_SCHEDULED'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('records the opening transition in the append-only history', async () => {
    const patient = await newPatient();
    const appointment = (
      await book({ patientId: patient.id, startsAt: T(9), durationMinutes: 20 })
    ).json();

    const detail = await app.inject({
      method: 'GET',
      url: `/appointments/${appointment.id}`,
      headers: bearer(reception),
    });
    expect(detail.json().history).toHaveLength(1);
    expect(detail.json().history[0].toStatus).toBe('scheduled');

    await expect(
      getPool().query(`UPDATE appointment_status_history SET to_status = 'completed'`),
    ).rejects.toThrow(/append-only/);
    await expect(getPool().query(`DELETE FROM appointment_status_history`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('requires a way to determine the appointment length', async () => {
    const patient = await newPatient();
    const res = await book({ patientId: patient.id, startsAt: T(9) });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an end before its start and both end and duration together', async () => {
    const patient = await newPatient();
    expect(
      (await book({ patientId: patient.id, startsAt: T(10), endsAt: T(9) })).statusCode,
    ).toBe(400);
    expect(
      (
        await book({
          patientId: patient.id,
          startsAt: T(9),
          endsAt: T(10),
          durationMinutes: 30,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('refuses to book a merged or deceased record', async () => {
    const survivor = await newPatient('Booking Survivor');
    const duplicate = await newPatient('Booking Duplicate');
    await app.inject({
      method: 'POST',
      url: `/patients/${survivor.id}/merge`,
      headers: bearer(admin),
      payload: { sourcePatientId: duplicate.id, reason: 'Duplicate registration' },
    });
    const merged = await book({ patientId: duplicate.id, startsAt: T(9), durationMinutes: 30 });
    expect(merged.statusCode).toBe(409);
    expect(merged.json().error.details.mergedIntoId).toBe(survivor.id);

    const deceasedPatient = await newPatient('Booking Deceased');
    await app.inject({
      method: 'POST',
      url: `/patients/${deceasedPatient.id}/status`,
      headers: bearer(reception),
      payload: { status: 'deceased' },
    });
    expect(
      (await book({ patientId: deceasedPatient.id, startsAt: T(9), durationMinutes: 30 }))
        .statusCode,
    ).toBe(409);
  });

  it('refuses a practitioner or resource from another clinic', async () => {
    const patient = await newPatient();
    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'doc2', RoleKey.DOCTOR);
    const res = await book({
      patientId: patient.id,
      startsAt: T(9),
      durationMinutes: 30,
      practitionerId: otherDoctor.userId,
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the visit reason out of the audit trail and the event payload', async () => {
    const patient = await newPatient();
    await book({
      patientId: patient.id,
      startsAt: T(9),
      durationMinutes: 30,
      reason: 'Suspected malignant melanoma',
    });

    const audit = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'appointment.book'`,
    );
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toMatch(/melanoma/i);
    const events = await getPool().query<{ payload: unknown }>(
      `SELECT payload FROM event WHERE type = 'APPOINTMENT_SCHEDULED'`,
    );
    expect(JSON.stringify(events.rows[0]!.payload)).not.toMatch(/melanoma/i);
    // But the time IS there — automation needs it to send a reminder.
    expect(JSON.stringify(events.rows[0]!.payload)).toContain('startsAt');
  });
});

describe('Phase 2 — double booking', () => {
  it('refuses to put two overlapping appointments in one room', async () => {
    const room = await newRoom();
    const a = await newPatient('Room Patient A');
    const b = await newPatient('Room Patient B');

    expect(
      (await book({ patientId: a.id, startsAt: T(9), durationMinutes: 60, resourceId: room.id }))
        .statusCode,
    ).toBe(201);

    const clash = await book({
      patientId: b.id,
      startsAt: T(9, 30),
      durationMinutes: 60,
      resourceId: room.id,
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toMatch(/room/i);
  });

  it('frees the room once the appointment is cancelled', async () => {
    const room = await newRoom();
    const a = await newPatient('Cancel Room A');
    const b = await newPatient('Cancel Room B');

    const first = (
      await book({ patientId: a.id, startsAt: T(9), durationMinutes: 60, resourceId: room.id })
    ).json();
    await setStatus(first.id, { status: 'cancelled', reason: 'patient rebooked' });

    const second = await book({
      patientId: b.id,
      startsAt: T(9),
      durationMinutes: 60,
      resourceId: room.id,
    });
    expect(second.statusCode).toBe(201);
  });

  it('allows back-to-back appointments in the same room', async () => {
    const room = await newRoom();
    const a = await newPatient('Back A');
    const b = await newPatient('Back B');
    expect(
      (await book({ patientId: a.id, startsAt: T(9), durationMinutes: 30, resourceId: room.id }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await book({
          patientId: b.id,
          startsAt: T(9, 30),
          durationMinutes: 30,
          resourceId: room.id,
        })
      ).statusCode,
    ).toBe(201);
  });

  it('warns about a practitioner clash but allows a deliberate overbook', async () => {
    const a = await newPatient('Overbook A');
    const b = await newPatient('Overbook B');
    expect(
      (
        await book({
          patientId: a.id,
          startsAt: T(9),
          durationMinutes: 30,
          practitionerId: doctor.userId,
        })
      ).statusCode,
    ).toBe(201);

    const refused = await book({
      patientId: b.id,
      startsAt: T(9, 15),
      durationMinutes: 30,
      practitionerId: doctor.userId,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details.conflicts).toHaveLength(1);

    const deliberate = await book({
      patientId: b.id,
      startsAt: T(9, 15),
      durationMinutes: 30,
      practitionerId: doctor.userId,
      allowDoubleBooking: true,
    });
    expect(deliberate.statusCode).toBe(201);

    // The deliberate overbook is recorded as such.
    const { rows } = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'appointment.book' ORDER BY id`,
    );
    expect(rows.map((r) => r.metadata.overbooked)).toEqual([false, true]);
  });

  it('denies an overbook to a role without the permission', async () => {
    const a = await newPatient('Nurse Overbook A');
    const b = await newPatient('Nurse Overbook B');
    await book({
      patientId: a.id,
      startsAt: T(9),
      durationMinutes: 30,
      practitionerId: doctor.userId,
    });
    // A nurse cannot book at all, which is the stronger guarantee.
    const res = await book(
      {
        patientId: b.id,
        startsAt: T(9, 15),
        durationMinutes: 30,
        practitionerId: doctor.userId,
        allowDoubleBooking: true,
      },
      nurse,
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('Phase 2 — lifecycle', () => {
  /** Distinct hours keep two appointments from clashing on the same doctor. */
  async function scheduled(name = 'Lifecycle Patient', hour = 9) {
    const patient = await newPatient(name);
    const res = await book({
      patientId: patient.id,
      startsAt: T(hour),
      durationMinutes: 30,
      practitionerId: doctor.userId,
    });
    expect(res.statusCode).toBe(201);
    return { patient, appointment: res.json() };
  }

  it('runs the happy path scheduled → confirmed → arrived → waiting', async () => {
    const { appointment } = await scheduled();
    expect((await setStatus(appointment.id, { status: 'confirmed' })).json().appointment.status).toBe(
      'confirmed',
    );

    const arrived = await setStatus(appointment.id, { status: 'arrived' });
    expect(arrived.statusCode).toBe(200);
    expect(arrived.json().appointment.status).toBe('arrived');
    // Arrival opens the visit.
    expect(arrived.json().encounterId).toBeTruthy();
    expect(arrived.json().appointment.arrivedAt).toBeTruthy();

    const waiting = await setStatus(appointment.id, { status: 'waiting' });
    expect(waiting.json().appointment.status).toBe('waiting');
  });

  it('puts an arriving patient on the clinical queue', async () => {
    const { appointment } = await scheduled('Queued Patient');
    await setStatus(appointment.id, { status: 'arrived' });

    const queue = await app.inject({ method: 'GET', url: '/queue', headers: bearer(reception) });
    expect(queue.json().queue).toHaveLength(1);
    expect(queue.json().queue[0].patientName).toBe('Queued Patient');
  });

  it('follows the encounter into consultation and completion', async () => {
    const { appointment } = await scheduled('Synced Patient');
    const encounterId = (await setStatus(appointment.id, { status: 'arrived' })).json().encounterId;

    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(nurse),
      payload: { chiefComplaint: 'Rash' },
    });
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/status`,
      headers: bearer(nurse),
      payload: { status: 'ready' },
    });
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/start`,
      headers: bearer(doctor),
    });

    const duringConsult = await app.inject({
      method: 'GET',
      url: `/appointments/${appointment.id}`,
      headers: bearer(reception),
    });
    expect(duringConsult.json().appointment.status).toBe('in_consultation');

    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/diagnoses`,
      headers: bearer(doctor),
      payload: { description: 'Contact dermatitis' },
    });
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/complete`,
      headers: bearer(doctor),
    });

    const afterConsult = await app.inject({
      method: 'GET',
      url: `/appointments/${appointment.id}`,
      headers: bearer(reception),
    });
    expect(afterConsult.json().appointment.status).toBe('completed');
    expect(afterConsult.json().appointment.closedAt).toBeTruthy();
    // The whole journey is on the history.
    expect(afterConsult.json().history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'scheduled',
      'arrived',
      'in_consultation',
      'completed',
    ]);
  });

  it('refuses transitions the lifecycle does not permit', async () => {
    const { appointment } = await scheduled();
    // waiting before arriving
    const early = await setStatus(appointment.id, { status: 'waiting' });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.details.allowed).toContain('confirmed');

    await setStatus(appointment.id, { status: 'cancelled', reason: 'patient rebooked' });
    // terminal
    for (const status of ['confirmed', 'arrived', 'no_show']) {
      expect((await setStatus(appointment.id, { status })).statusCode).toBe(409);
    }
  });

  it('cannot set in_consultation or completed from the front desk', async () => {
    const { appointment } = await scheduled();
    for (const status of ['in_consultation', 'completed']) {
      const res = await setStatus(appointment.id, { status });
      expect(res.statusCode).toBe(400);
    }
  });

  it('records a no-show and a patient who left without being seen', async () => {
    const first = await scheduled('No Show Patient');
    const noShow = await setStatus(first.appointment.id, { status: 'no_show' });
    expect(noShow.json().appointment.status).toBe('no_show');
    expect(noShow.json().appointment.closedAt).toBeTruthy();

    const second = await scheduled('Left Patient', 11);
    await setStatus(second.appointment.id, { status: 'arrived' });
    const left = await setStatus(second.appointment.id, {
      status: 'left_without_being_seen',
      reason: 'waited too long',
    });
    expect(left.json().appointment.status).toBe('left_without_being_seen');

    const { rows } = await getPool().query<{ type: string }>(
      `SELECT type FROM event
        WHERE type IN ('APPOINTMENT_NO_SHOW','APPOINTMENT_LEFT_WITHOUT_BEING_SEEN')
        ORDER BY type`,
    );
    expect(rows.map((r) => r.type)).toEqual([
      'APPOINTMENT_LEFT_WITHOUT_BEING_SEEN',
      'APPOINTMENT_NO_SHOW',
    ]);
  });

  it('separates desk authorities: arrival opens a visit, cancelling does not', async () => {
    const { appointment } = await scheduled();
    // Arrival opens a clinical encounter, so it also needs `encounter:checkin`,
    // which a nurse does not hold. A nurse can move a patient through the
    // waiting room but cannot open the visit.
    expect((await setStatus(appointment.id, { status: 'arrived' }, nurse)).statusCode).toBe(403);
    expect((await setStatus(appointment.id, { status: 'arrived' }, reception)).statusCode).toBe(200);
    // Once the visit is open the nurse can move the patient to waiting.
    expect((await setStatus(appointment.id, { status: 'waiting' }, nurse)).statusCode).toBe(200);

    const second = await scheduled('Cancel Authz', 11);
    const nurseCancel = await setStatus(
      second.appointment.id,
      { status: 'cancelled', reason: 'x' },
      nurse,
    );
    expect(nurseCancel.statusCode).toBe(403);
  });
});

describe('Phase 2 — rescheduling', () => {
  it('moves an appointment and records the move', async () => {
    const patient = await newPatient();
    const appointment = (
      await book({ patientId: patient.id, startsAt: T(9), durationMinutes: 30 })
    ).json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/appointments/${appointment.id}`,
      headers: bearer(reception),
      payload: { startsAt: T(14) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().startsAt).toBe(T(14));
    // The original 30-minute length is preserved when only the start moves.
    expect(new Date(res.json().endsAt).getTime() - new Date(res.json().startsAt).getTime()).toBe(
      30 * 60_000,
    );

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE type = 'APPOINTMENT_RESCHEDULED'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('refuses to move an appointment once the consultation has started', async () => {
    const patient = await newPatient('Started Patient');
    const appointment = (
      await book({ patientId: patient.id, startsAt: T(9), durationMinutes: 30 })
    ).json();
    const encounterId = (await setStatus(appointment.id, { status: 'arrived' })).json().encounterId;
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(nurse),
      payload: { chiefComplaint: 'Cough' },
    });
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/status`,
      headers: bearer(nurse),
      payload: { status: 'ready' },
    });
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/start`,
      headers: bearer(doctor),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/appointments/${appointment.id}`,
      headers: bearer(reception),
      payload: { startsAt: T(15) },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses to move a cancelled appointment and rejects an empty change', async () => {
    const patient = await newPatient();
    const appointment = (
      await book({ patientId: patient.id, startsAt: T(9), durationMinutes: 30 })
    ).json();

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/appointments/${appointment.id}`,
          headers: bearer(reception),
          payload: {},
        })
      ).statusCode,
    ).toBe(400);

    await setStatus(appointment.id, { status: 'cancelled', reason: 'patient rebooked' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/appointments/${appointment.id}`,
      headers: bearer(reception),
      payload: { startsAt: T(14) },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('Phase 2 — the schedule view', () => {
  it('filters by window, practitioner and status', async () => {
    const a = await newPatient('Morning Patient');
    const b = await newPatient('Afternoon Patient');
    const otherDoctor = await makeUser(clinicId, 'doctor2', RoleKey.DOCTOR);

    await book({
      patientId: a.id,
      startsAt: T(9),
      durationMinutes: 30,
      practitionerId: doctor.userId,
    });
    await book({
      patientId: b.id,
      startsAt: T(15),
      durationMinutes: 30,
      practitionerId: otherDoctor.userId,
    });

    const all = await app.inject({
      method: 'GET',
      url: '/appointments',
      headers: bearer(reception),
    });
    expect(all.json().appointments).toHaveLength(2);
    expect(all.json().appointments[0].patientName).toBe('Morning Patient');

    const morning = await app.inject({
      method: 'GET',
      url: `/appointments?from=${encodeURIComponent(T(8))}&to=${encodeURIComponent(T(12))}`,
      headers: bearer(reception),
    });
    expect(morning.json().appointments).toHaveLength(1);

    const mine = await app.inject({
      method: 'GET',
      url: `/appointments?practitionerId=${doctor.userId}`,
      headers: bearer(doctor),
    });
    expect(mine.json().appointments).toHaveLength(1);
    expect(mine.json().appointments[0].patientName).toBe('Morning Patient');
  });

  it('lists a patient appointments', async () => {
    const patient = await newPatient('Listed Patient');
    await book({ patientId: patient.id, startsAt: T(9), durationMinutes: 30 });
    await book({ patientId: patient.id, startsAt: T(11), durationMinutes: 30 });

    const res = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/appointments`,
      headers: bearer(doctor),
    });
    expect(res.json().appointments).toHaveLength(2);
  });

  it('rejects a window that ends before it starts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/appointments?from=${encodeURIComponent(T(12))}&to=${encodeURIComponent(T(8))}`,
      headers: bearer(reception),
    });
    expect(res.statusCode).toBe(400);
  });

  it('never shows another clinic schedule', async () => {
    const patient = await newPatient();
    const appointment = (
      await book({ patientId: patient.id, startsAt: T(9), durationMinutes: 30 })
    ).json();

    const other = await makeClinic('Other Clinic');
    const otherReception = await makeUser(other.clinicId, 'rec2', RoleKey.RECEPTION);

    const list = await app.inject({
      method: 'GET',
      url: '/appointments',
      headers: bearer(otherReception),
    });
    expect(list.json().appointments).toHaveLength(0);

    const direct = await app.inject({
      method: 'GET',
      url: `/appointments/${appointment.id}`,
      headers: bearer(otherReception),
    });
    expect(direct.statusCode).toBe(404);

    const tamper = await setStatus(appointment.id, { status: 'confirmed' }, otherReception);
    expect(tamper.statusCode).toBe(404);
  });

  it('denies the schedule to a pharma rep', async () => {
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    const res = await app.inject({
      method: 'GET',
      url: '/appointments',
      headers: bearer(pharma),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Phase 2 — walk-ins', () => {
  it('books a walk-in and arrives it in one flow', async () => {
    const patient = await newPatient('Walk In Patient');
    const appointment = (
      await book({
        patientId: patient.id,
        startsAt: T(9),
        durationMinutes: 15,
        origin: 'walk_in',
        priority: 'urgent',
      })
    ).json();
    expect(appointment.origin).toBe('walk_in');
    expect(appointment.priority).toBe('urgent');

    const arrived = await setStatus(appointment.id, { status: 'arrived' });
    expect(arrived.statusCode).toBe(200);
    expect(arrived.json().encounterId).toBeTruthy();
  });

  it('leaves the existing direct check-in path working unchanged', async () => {
    const patient = await newPatient('Direct Check In');
    const res = await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: bearer(reception),
      payload: { patientId: patient.id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('checked_in');
  });

  it('refuses a second arrival while the first visit is still open', async () => {
    const patient = await newPatient('Double Arrival');
    const first = (
      await book({ patientId: patient.id, startsAt: T(9), durationMinutes: 15 })
    ).json();
    const second = (
      await book({ patientId: patient.id, startsAt: T(11), durationMinutes: 15 })
    ).json();

    expect((await setStatus(first.id, { status: 'arrived' })).statusCode).toBe(200);
    // The patient already holds an active encounter.
    const clash = await setStatus(second.id, { status: 'arrived' });
    expect(clash.statusCode).toBe(409);

    // And the failed arrival left no trace on the second appointment.
    const detail = await app.inject({
      method: 'GET',
      url: `/appointments/${second.id}`,
      headers: bearer(reception),
    });
    expect(detail.json().appointment.status).toBe('scheduled');
    expect(detail.json().appointment.encounterId).toBeNull();
  });
});
