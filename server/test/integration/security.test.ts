import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

async function auditCount(action: string, outcome: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND outcome = $2`,
    [action, outcome],
  );
  return Number(rows[0]!.n);
}

describe('governance boundaries (§45, §53)', () => {
  it('a pharma rep CANNOT read or create patient data', async () => {
    const { clinicId } = await makeClinic();
    const reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);

    // Reception creates a patient.
    const patient = (
      await app.inject({
        method: 'POST',
        url: '/patients',
        headers: { authorization: `Bearer ${reception.token}` },
        payload: { fullName: 'Protected Patient', sex: 'male' },
      })
    ).json();

    // Pharma rep is authenticated but must be forbidden from patient access.
    const read = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}`,
      headers: { authorization: `Bearer ${pharma.token}` },
    });
    expect(read.statusCode).toBe(403);

    const create = await app.inject({
      method: 'POST',
      url: '/patients',
      headers: { authorization: `Bearer ${pharma.token}` },
      payload: { fullName: 'Should Not Exist', sex: 'male' },
    });
    expect(create.statusCode).toBe(403);

    // The denied attempts are recorded for forensics.
    expect(await auditCount('access.denied', 'denied')).toBeGreaterThanOrEqual(2);
  });

  it('a doctor cannot register patients (least privilege)', async () => {
    const { clinicId } = await makeClinic();
    const doctor = await makeUser(clinicId, 'doc', RoleKey.DOCTOR);
    const res = await app.inject({
      method: 'POST',
      url: '/patients',
      headers: { authorization: `Bearer ${doctor.token}` },
      payload: { fullName: 'X Y', sex: 'other' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('data is isolated between clinics (no cross-tenant read)', async () => {
    const clinicA = await makeClinic('Clinic A');
    const clinicB = await makeClinic('Clinic B');
    const recA = await makeUser(clinicA.clinicId, 'recA', RoleKey.RECEPTION);
    const recB = await makeUser(clinicB.clinicId, 'recB', RoleKey.RECEPTION);

    const patientA = (
      await app.inject({
        method: 'POST',
        url: '/patients',
        headers: { authorization: `Bearer ${recA.token}` },
        payload: { fullName: 'Clinic A Patient', sex: 'female' },
      })
    ).json();

    // Reception B must not be able to read Clinic A's patient (404, no leak).
    const res = await app.inject({
      method: 'GET',
      url: `/patients/${patientA.id}`,
      headers: { authorization: `Bearer ${recB.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('writes a success audit row for a sensitive action', async () => {
    const { clinicId } = await makeClinic();
    const reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
    await app.inject({
      method: 'POST',
      url: '/patients',
      headers: { authorization: `Bearer ${reception.token}` },
      payload: { fullName: 'Audited Patient', sex: 'male' },
    });
    expect(await auditCount('patient.register', 'success')).toBe(1);
  });

  it('the audit log is append-only (tamper-evident)', async () => {
    await expect(getPool().query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(getPool().query('DELETE FROM event')).rejects.toThrow(/append-only/);
  });
});
