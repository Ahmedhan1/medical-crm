import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;
let clinicId: string;
let auth: { authorization: string };

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  const reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  auth = { authorization: `Bearer ${reception.token}` };
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

async function newPatient(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/patients',
    headers: auth,
    payload: { fullName: name, sex: 'male' },
  });
  return res.json().id;
}

describe('check-in workflow', () => {
  it('checks a patient in, emits an event, and lists them on the queue', async () => {
    const patientId = await newPatient('Queue Patient');

    const checkin = await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: auth,
      payload: { patientId },
    });
    expect(checkin.statusCode).toBe(201);
    expect(checkin.json().status).toBe('checked_in');

    // PATIENT_CHECKED_IN event recorded.
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE type = 'PATIENT_CHECKED_IN'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);

    const queue = await app.inject({ method: 'GET', url: '/queue', headers: auth });
    expect(queue.statusCode).toBe(200);
    const entries = queue.json().queue;
    expect(entries).toHaveLength(1);
    expect(entries[0].patientName).toBe('Queue Patient');
  });

  it('prevents a second active encounter for the same patient', async () => {
    const patientId = await newPatient('Double Checkin');
    const first = await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: auth,
      payload: { patientId },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: auth,
      payload: { patientId },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('conflict');
  });

  it('rejects check-in of an unknown patient', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: auth,
      payload: { patientId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
  });
});
