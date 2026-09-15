import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;
let clinicId: string;
let receptionAuth: { authorization: string };

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  const reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  receptionAuth = { authorization: `Bearer ${reception.token}` };
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

function register(payload: Record<string, unknown>, headers = receptionAuth) {
  return app.inject({ method: 'POST', url: '/patients', headers, payload });
}

describe('patient registration', () => {
  it('registers a patient and assigns an MRN', async () => {
    const res = await register({ fullName: 'Sara Ahmed', sex: 'female', phone: '+201000000001' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.mrn).toMatch(/^MRN-\d{6}$/);
    expect(body.fullName).toBe('Sara Ahmed');
    expect(body.clinicId).toBe(clinicId);
  });

  it('validates input', async () => {
    const res = await register({ fullName: 'A', sex: 'martian' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('blocks a hard duplicate by national ID', async () => {
    await register({ fullName: 'Ali Hassan', sex: 'male', nationalId: '29001011234567' });
    const dup = await register({ fullName: 'Ali H.', sex: 'male', nationalId: '29001011234567' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('conflict');
  });

  it('blocks a soft duplicate (name+phone) but allows override', async () => {
    await register({ fullName: 'Mona Nabil', sex: 'female', phone: '+201111111111' });
    const dup = await register({ fullName: 'Mona Nabil', sex: 'female', phone: '+201111111111' });
    expect(dup.statusCode).toBe(409);

    const override = await register({
      fullName: 'Mona Nabil',
      sex: 'female',
      phone: '+201111111111',
      overrideDuplicate: true,
    });
    expect(override.statusCode).toBe(201);
  });

  it('searches and fetches a patient', async () => {
    const created = (await register({ fullName: 'Omar Farouk', sex: 'male' })).json();

    const search = await app.inject({
      method: 'GET',
      url: '/patients/search?q=omar',
      headers: receptionAuth,
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().results.some((p: { id: string }) => p.id === created.id)).toBe(true);

    const fetched = await app.inject({
      method: 'GET',
      url: `/patients/${created.id}`,
      headers: receptionAuth,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().mrn).toBe(created.mrn);
  });

  it('returns 404 for an unknown patient id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/patients/00000000-0000-0000-0000-000000000000',
      headers: receptionAuth,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('patient QR identity', () => {
  it('issues a QR (no PHI in payload) and resolves it back to the patient', async () => {
    const patient = (await register({ fullName: 'Layla Said', sex: 'female' })).json();

    const issued = await app.inject({
      method: 'POST',
      url: `/patients/${patient.id}/qr`,
      headers: receptionAuth,
    });
    expect(issued.statusCode).toBe(201);
    const { payload, qrPngDataUrl } = issued.json();
    expect(payload.startsWith('MEDCORE1:')).toBe(true);
    // Payload must not leak PHI.
    expect(payload).not.toContain('Layla');
    expect(payload).not.toContain(patient.mrn);
    expect(qrPngDataUrl.startsWith('data:image/png;base64,')).toBe(true);

    const resolved = await app.inject({
      method: 'POST',
      url: '/qr/resolve',
      headers: receptionAuth,
      payload: { payload },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().id).toBe(patient.id);
  });

  it('rejects an unknown QR token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/qr/resolve',
      headers: receptionAuth,
      payload: { payload: 'MEDCORE1:not-a-real-token' },
    });
    expect(res.statusCode).toBe(404);
  });
});
