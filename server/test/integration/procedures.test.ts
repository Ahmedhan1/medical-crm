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

async function newPatient(name = 'Procedure Patient', user: TestUser = reception) {
  return (await app.inject({ method: 'POST', url: '/patients', headers: bearer(user), payload: { fullName: name, sex: 'male' } })).json();
}

async function record(payload: Record<string, unknown>, user: TestUser = doctor) {
  return app.inject({ method: 'POST', url: '/procedures', headers: bearer(user), payload });
}

const SUTURE = (patientId: string, over: Record<string, unknown> = {}) => ({
  patientId, name: 'Wound suture, 3cm forearm', codeSystem: 'CPT', code: '12002', bodySite: 'left forearm', ...over,
});

describe('Procedures — recording', () => {
  it('records a completed procedure with performer and time', async () => {
    const patient = await newPatient();
    const res = await record(SUTURE(patient.id));
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('completed');
    expect(res.json().performedBy).toBe(doctor.userId);
    expect(res.json().performedAt).toBeTruthy();
    expect(res.json().code).toBe('12002');
    expect(await eventCount('PROCEDURE_COMPLETED')).toBe(1);
  });

  it('records a planned procedure and advances it to completed', async () => {
    const patient = await newPatient();
    const planned = (await record(SUTURE(patient.id, { status: 'planned' }))).json();
    expect(planned.status).toBe('planned');
    expect(planned.performedBy).toBeNull();
    const done = await app.inject({ method: 'PATCH', url: `/procedures/${planned.id}`, headers: bearer(doctor), payload: { status: 'completed', outcome: 'Wound closed' } });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('completed');
    expect(done.json().performedBy).toBe(doctor.userId);
  });

  it('rejects a code without a coding system', async () => {
    const patient = await newPatient();
    expect((await record(SUTURE(patient.id, { code: '999', codeSystem: undefined }))).statusCode).toBe(400);
  });

  it('validates encounter and episode ownership', async () => {
    const patient = await newPatient();
    const other = await newPatient('Other');
    const encounter = (await app.inject({ method: 'POST', url: '/encounters/check-in', headers: bearer(reception), payload: { patientId: other.id } })).json();
    expect((await record(SUTURE(patient.id, { encounterId: encounter.id }))).statusCode).toBe(400);
  });

  it('links a procedure to a treatment episode', async () => {
    const patient = await newPatient();
    const episode = (await app.inject({ method: 'POST', url: `/patients/${patient.id}/treatment-episodes`, headers: bearer(doctor), payload: { label: 'Wound care', startedOn: '2026-01-10' } })).json();
    const res = await record(SUTURE(patient.id, { episodeId: episode.id }));
    expect(res.statusCode).toBe(201);
    expect(res.json().episodeId).toBe(episode.id);
  });
});

describe('Procedures — immutability & authority', () => {
  it('makes a completed procedure immutable (DB-enforced) except for voiding', async () => {
    const patient = await newPatient();
    const proc = (await record(SUTURE(patient.id))).json();
    // Service refuses edits to a completed procedure.
    expect((await app.inject({ method: 'PATCH', url: `/procedures/${proc.id}`, headers: bearer(doctor), payload: { outcome: 'changed' } })).statusCode).toBe(409);
    // And the DB trigger blocks a direct content change.
    await expect(getPool().query(`UPDATE procedure SET name = 'tampered' WHERE id = $1`, [proc.id])).rejects.toThrow(/immutable/i);
    await expect(getPool().query(`DELETE FROM procedure`)).rejects.toThrow(/append-only/);
  });

  it('voids a completed procedure to entered_in_error with a reason', async () => {
    const patient = await newPatient();
    const proc = (await record(SUTURE(patient.id))).json();
    const res = await app.inject({ method: 'POST', url: `/procedures/${proc.id}/void`, headers: bearer(doctor), payload: { reason: 'Recorded on wrong patient' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('entered_in_error');
    // A voided procedure drops off the default list.
    const list = await app.inject({ method: 'GET', url: `/patients/${patient.id}/procedures`, headers: bearer(doctor) });
    expect(list.json().procedures.find((p: { id: string }) => p.id === proc.id)).toBeUndefined();
  });

  it('is doctor-owned: reception and nurse cannot write; nurse can read', async () => {
    const patient = await newPatient();
    expect((await record(SUTURE(patient.id), reception)).statusCode).toBe(403);
    expect((await record(SUTURE(patient.id), nurse)).statusCode).toBe(403);
    const proc = (await record(SUTURE(patient.id))).json();
    expect((await app.inject({ method: 'GET', url: `/procedures/${proc.id}`, headers: bearer(nurse) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/procedures/${proc.id}`, headers: bearer(reception) })).statusCode).toBe(403);
  });

  it('keeps procedure narrative out of events and audit metadata', async () => {
    const patient = await newPatient();
    await record(SUTURE(patient.id, { name: 'Excision of suspicious melanoma lesion', outcome: 'sent to histopathology' }));
    const ev = await getPool().query<{ payload: unknown }>(`SELECT payload FROM event WHERE type = 'PROCEDURE_COMPLETED'`);
    expect(JSON.stringify(ev.rows[0]!.payload)).not.toMatch(/melanoma|histopathology/i);
    const au = await getPool().query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM audit_log WHERE action = 'procedure.record'`);
    expect(JSON.stringify(au.rows[0]!.metadata)).not.toMatch(/melanoma|histopathology/i);
  });
});

describe('Procedures — integration & isolation', () => {
  it('appears on the timeline and Patient 360', async () => {
    const patient = await newPatient();
    await record(SUTURE(patient.id, { name: 'Cryotherapy of wart' }));
    const tl = await app.inject({ method: 'GET', url: `/patients/${patient.id}/timeline`, headers: bearer(doctor) });
    const entry = tl.json().entries.find((e: { kind: string }) => e.kind === 'procedure');
    expect(entry.summary).toBe('Cryotherapy of wart');
    const v = await app.inject({ method: 'GET', url: `/patients/${patient.id}/360`, headers: bearer(doctor) });
    expect(v.json().procedures).toHaveLength(1);
  });

  it('is tenant-isolated and denied to pharma', async () => {
    const patient = await newPatient();
    const proc = (await record(SUTURE(patient.id))).json();
    const other = await makeClinic('Other');
    const otherDoc = await makeUser(other.clinicId, 'od', RoleKey.DOCTOR);
    expect((await app.inject({ method: 'GET', url: `/procedures/${proc.id}`, headers: bearer(otherDoc) })).statusCode).toBe(404);
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    expect((await app.inject({ method: 'GET', url: `/patients/${patient.id}/procedures`, headers: bearer(pharma) })).statusCode).toBe(403);
  });
});

async function eventCount(type: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM event WHERE type = $1`, [type]);
  return Number(rows[0]!.n);
}
