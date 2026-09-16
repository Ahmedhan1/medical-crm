import { Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { patientRoutes } from '../../src/http/routes/patients.routes.js';
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

describe('PHI containment in logs and audit (§9)', () => {
  it('audits a patient search without storing the search term', async () => {
    const { clinicId } = await makeClinic();
    const reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
    const auth = { authorization: `Bearer ${reception.token}` };

    await app.inject({
      method: 'POST',
      url: '/patients',
      headers: auth,
      payload: { fullName: 'Ahmed Hassan', sex: 'male' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/patients/search?q=Ahmed',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(1);

    const { rows } = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'patient.search'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.results).toBe(1);
    expect(rows[0]!.metadata.queryLength).toBe(5);
    // The term itself identifies a patient and must never be persisted.
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/ahmed/i);
  });

  it('never writes a searched patient name into the request log', async () => {
    // Fastify's info-level request log records the full URL, query string and
    // all. The search route is registered at 'warn' precisely so a name typed
    // into the search box cannot reach application logs. Assert it against real
    // captured log output rather than trusting the route option.
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });

    const logged = Fastify({ logger: { level: 'info', stream } });
    await logged.register(patientRoutes);
    await logged.ready();

    // Auth is irrelevant here: the request log is written either way.
    await logged.inject({ method: 'GET', url: '/patients/search?q=Ahmed%20Hassan' });
    // A control route in the same module must still be logged, so this test
    // fails if request logging is simply off.
    await logged.inject({ method: 'GET', url: '/patients/00000000-0000-0000-0000-000000000000' });
    await logged.close();

    const output = lines.join('');
    expect(output).toContain('/patients/00000000-0000-0000-0000-000000000000');
    expect(output).not.toMatch(/Ahmed/i);
    expect(output).not.toContain('/patients/search');
  });
});
