import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { authenticate } from '../../src/modules/auth/auth.service.js';
import { claimNextReadyTx } from '../../src/modules/workflow/queue.service.js';
import type { Principal } from '../../src/modules/governance/rbac.js';

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

/** Register, check in, take intake and mark ready. Returns the encounter id. */
async function readyPatient(name: string): Promise<string> {
  const patient = (
    await app.inject({
      method: 'POST',
      url: '/patients',
      headers: bearer(reception),
      payload: { fullName: name, sex: 'female' },
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
    payload: { chiefComplaint: 'Routine review' },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/status`,
    headers: bearer(nurse),
    payload: { status: 'ready' },
  });
  return encounter.id;
}

/** Give an encounter a definite queue position so ordering is deterministic. */
async function backdate(encounterId: string, minutesAgo: number): Promise<void> {
  await getPool().query(
    `UPDATE encounter SET checked_in_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
    [encounterId, String(minutesAgo)],
  );
}

async function principalFor(user: TestUser): Promise<Principal> {
  const principal = await authenticate(user.token);
  if (!principal) throw new Error('expected a valid session');
  return principal;
}

/** Take a patient and give the consultation enough content to be completable. */
async function consult(encounterId: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounterId}/start`,
    headers: bearer(doctor),
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounterId}/diagnoses`,
    headers: bearer(doctor),
    payload: { description: 'Hypertension, stable' },
  });
}

describe('C003 — Save & Next', () => {
  it('completes the current consultation and surfaces the next patient', async () => {
    const current = await readyPatient('Current Patient');
    const waiting = await readyPatient('Waiting Patient');
    await backdate(current, 30);
    await backdate(waiting, 20);
    await consult(current);

    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${current}/complete-and-next`,
      headers: bearer(doctor),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.completed.status).toBe('completed');
    expect(body.next.encounter.id).toBe(waiting);
    expect(body.next.encounter.status).toBe('in_progress');
    expect(body.next.clinical.attendingDoctorId).toBe(doctor.userId);
    expect(body.next.patient.fullName).toBe('Waiting Patient');
    // The next patient's intake is carried through, ready to read.
    expect(body.next.intake.chiefComplaint).toBe('Routine review');
  });

  it('returns no next patient when the queue is empty', async () => {
    const current = await readyPatient('Only Patient');
    await consult(current);

    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${current}/complete-and-next`,
      headers: bearer(doctor),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().next).toBeNull();
  });

  it('takes waiting patients in arrival order', async () => {
    const first = await readyPatient('Arrived First');
    const second = await readyPatient('Arrived Second');
    const third = await readyPatient('Arrived Third');
    await backdate(first, 30);
    await backdate(second, 20);
    await backdate(third, 10);

    const taken: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/queue/next',
        headers: bearer(doctor),
      });
      const next = res.json().next;
      taken.push(next.patient.fullName);
      // Close it so the doctor is free for the next one.
      await app.inject({
        method: 'POST',
        url: `/encounters/${next.encounter.id}/diagnoses`,
        headers: bearer(doctor),
        payload: { description: 'Reviewed' },
      });
      await app.inject({
        method: 'POST',
        url: `/encounters/${next.encounter.id}/complete`,
        headers: bearer(doctor),
      });
    }

    expect(taken).toEqual(['Arrived First', 'Arrived Second', 'Arrived Third']);
    expect([first, second, third]).toHaveLength(3);
  });

  it('never hands the same patient to two doctors claiming concurrently', async () => {
    const a = await readyPatient('Queue A');
    const b = await readyPatient('Queue B');
    await backdate(a, 30);
    await backdate(b, 20);

    const doctorTwo = await makeUser(clinicId, 'doctor2', RoleKey.DOCTOR);
    const [p1, p2] = await Promise.all([principalFor(doctor), principalFor(doctorTwo)]);

    // Two genuinely overlapping transactions: the second claim runs while the
    // first still holds its row lock uncommitted.
    const pool = getPool();
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      const first = await claimNextReadyTx(c1, p1);
      const second = await claimNextReadyTx(c2, p2);
      await c1.query('COMMIT');
      await c2.query('COMMIT');

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.id).not.toBe(second!.id);
      expect(new Set([first!.id, second!.id])).toEqual(new Set([a, b]));
    } finally {
      c1.release();
      c2.release();
    }

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM encounter WHERE status = 'in_progress'`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('gives the second doctor nothing when only one patient is waiting', async () => {
    const only = await readyPatient('Solo Patient');
    const doctorTwo = await makeUser(clinicId, 'doctor2', RoleKey.DOCTOR);
    const [p1, p2] = await Promise.all([principalFor(doctor), principalFor(doctorTwo)]);

    const pool = getPool();
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      const first = await claimNextReadyTx(c1, p1);
      const second = await claimNextReadyTx(c2, p2);
      await c1.query('COMMIT');
      await c2.query('COMMIT');

      expect(first!.id).toBe(only);
      expect(second).toBeNull();
    } finally {
      c1.release();
      c2.release();
    }
  });

  it('claims nothing when completing the current consultation fails', async () => {
    const current = await readyPatient('Incomplete Consult');
    const waiting = await readyPatient('Should Stay Queued');
    await backdate(current, 30);
    await backdate(waiting, 20);

    // Started but with no assessment and no diagnosis, so completion is refused.
    await app.inject({
      method: 'POST',
      url: `/encounters/${current}/start`,
      headers: bearer(doctor),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${current}/complete-and-next`,
      headers: bearer(doctor),
    });
    expect(res.statusCode).toBe(409);

    // The whole transaction rolled back: the waiting patient is still queued.
    const { rows } = await getPool().query<{ status: string }>(
      `SELECT status FROM encounter WHERE id = $1`,
      [waiting],
    );
    expect(rows[0]!.status).toBe('ready');
  });

  it('denies Save & Next to a nurse', async () => {
    const current = await readyPatient('Guarded Patient');
    await consult(current);
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${current}/complete-and-next`,
      headers: bearer(nurse),
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not take a patient waiting in another clinic', async () => {
    await readyPatient('Our Clinic Patient');
    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'doc2', RoleKey.DOCTOR);

    const res = await app.inject({
      method: 'POST',
      url: '/queue/next',
      headers: bearer(otherDoctor),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().next).toBeNull();
  });
});
