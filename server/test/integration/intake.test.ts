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

/** Register a patient and check them in; returns the encounter id. */
async function newEncounter(name = 'Intake Patient'): Promise<string> {
  const patient = (
    await app.inject({
      method: 'POST',
      url: '/patients',
      headers: bearer(reception),
      payload: { fullName: name, sex: 'female' },
    })
  ).json();
  const encounter = await app.inject({
    method: 'POST',
    url: '/encounters/check-in',
    headers: bearer(reception),
    payload: { patientId: patient.id },
  });
  return encounter.json().id;
}

async function eventCount(type: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM event WHERE type = $1`,
    [type],
  );
  return Number(rows[0]!.n);
}

describe('C001 — clinical intake', () => {
  it('records intake, advances the encounter to `intake`, and emits an event', async () => {
    const encounterId = await newEncounter();

    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(nurse),
      payload: {
        chiefComplaint: 'Persistent cough for 5 days',
        historyPresentIllness: 'Dry cough, worse at night. No fever.',
        allergies: 'Penicillin',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.intake.chiefComplaint).toBe('Persistent cough for 5 days');
    expect(body.intake.source).toBe('staff');
    expect(body.encounterStatus).toBe('intake');
    expect(await eventCount('INTAKE_RECORDED')).toBe(1);
    expect(await eventCount('ENCOUNTER_STATUS_CHANGED')).toBe(1);
  });

  it('revises an existing intake in place without a second status transition', async () => {
    const encounterId = await newEncounter();
    const payload = { chiefComplaint: 'Headache' };
    const first = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(nurse),
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(nurse),
      payload: { chiefComplaint: 'Headache with photophobia' },
    });

    expect(second.statusCode).toBe(201);
    expect(second.json().intake.id).toBe(first.json().intake.id);
    expect(second.json().intake.chiefComplaint).toBe('Headache with photophobia');
    expect(await eventCount('INTAKE_RECORDED')).toBe(2);
    // Already in `intake`; the second write must not re-transition.
    expect(await eventCount('ENCOUNTER_STATUS_CHANGED')).toBe(1);

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM intake WHERE encounter_id = $1`,
      [encounterId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('rejects intake without a chief complaint', async () => {
    const encounterId = await newEncounter();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(nurse),
      payload: { historyPresentIllness: 'Something' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('refuses an AI-assisted intake that no human confirmed (§12)', async () => {
    const encounterId = await newEncounter();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(nurse),
      payload: {
        chiefComplaint: 'Back pain',
        source: 'ai_assisted',
        sourceRef: 'draft-123',
      },
    });
    expect(res.statusCode).toBe(400);

    const confirmed = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(nurse),
      payload: {
        chiefComplaint: 'Back pain',
        source: 'ai_assisted',
        sourceRef: 'draft-123',
        confirmed: true,
      },
    });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().intake.confirmedBy).toBe(nurse.userId);
  });

  it('denies intake to reception (operational role, no clinical authority)', async () => {
    const encounterId = await newEncounter();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(reception),
      payload: { chiefComplaint: 'Cough' },
    });
    expect(res.statusCode).toBe(403);

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'access.denied' AND outcome = 'denied'`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('keeps intake inside the clinic boundary', async () => {
    const encounterId = await newEncounter();
    const other = await makeClinic('Other Clinic');
    const otherNurse = await makeUser(other.clinicId, 'nurse2', RoleKey.NURSE);
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(otherNurse),
      payload: { chiefComplaint: 'Cough' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('does not put clinical text in the audit trail', async () => {
    const encounterId = await newEncounter();
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(nurse),
      payload: { chiefComplaint: 'Severe chest pain radiating to the left arm' },
    });
    const { rows } = await getPool().query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_log WHERE action = 'intake.record'`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/chest pain/i);

    const events = await getPool().query<{ payload: unknown }>(
      `SELECT payload FROM event WHERE type = 'INTAKE_RECORDED'`,
    );
    expect(JSON.stringify(events.rows[0]!.payload)).not.toMatch(/chest pain/i);
  });
});

describe('C001 — vitals', () => {
  it('records a vitals set, derives BMI, and flags abnormal measurements', async () => {
    const encounterId = await newEncounter();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/vitals`,
      headers: bearer(nurse),
      payload: {
        systolicBp: 165,
        diastolicBp: 95,
        heartRate: 78,
        temperatureC: 37.1,
        spo2: 98,
        weightKg: 80,
        heightCm: 180,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.vital.bmi).toBeCloseTo(24.69, 2);
    expect(body.abnormal).toEqual(expect.arrayContaining(['systolicBp', 'diastolicBp']));
    expect(body.abnormal).not.toContain('heartRate');
    expect(await eventCount('VITALS_RECORDED')).toBe(1);
  });

  it('keeps repeat measurements as separate observations', async () => {
    const encounterId = await newEncounter();
    for (const hr of [110, 92]) {
      const res = await app.inject({
        method: 'POST',
        url: `/encounters/${encounterId}/vitals`,
        headers: bearer(nurse),
        payload: { heartRate: hr },
      });
      expect(res.statusCode).toBe(201);
    }
    const list = await app.inject({
      method: 'GET',
      url: `/encounters/${encounterId}/vitals`,
      headers: bearer(nurse),
    });
    expect(list.json().vitals).toHaveLength(2);
  });

  it('is append-only: a recorded vital set cannot be updated or deleted', async () => {
    const encounterId = await newEncounter();
    const recorded = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/vitals`,
      headers: bearer(nurse),
      payload: { heartRate: 72, spo2: 98 },
    });
    expect(recorded.statusCode).toBe(201);
    const vitalId = recorded.json().vital.id;

    // A recorded measurement is a clinical fact; the database is the last line
    // of defence. A correction is a new row, never an in-place edit.
    await expect(
      getPool().query(`UPDATE vital SET heart_rate = 60 WHERE id = $1`, [vitalId]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      getPool().query(`DELETE FROM vital WHERE id = $1`, [vitalId]),
    ).rejects.toThrow(/append-only/i);

    // The original value is intact.
    const { rows } = await getPool().query<{ heart_rate: number }>(
      `SELECT heart_rate FROM vital WHERE id = $1`,
      [vitalId],
    );
    expect(rows[0]!.heart_rate).toBe(72);
  });

  const invalidVitals: Array<[Record<string, unknown>, string]> = [
    [{ heartRate: 400 }, 'heart rate above the possible range'],
    [{ temperatureC: 60 }, 'impossible temperature'],
    [{ spo2: 5 }, 'impossible oxygen saturation'],
    [{ painScore: 11 }, 'pain score out of scale'],
    [{ systolicBp: 120 }, 'blood pressure missing its pair'],
    [{ systolicBp: 80, diastolicBp: 120 }, 'systolic below diastolic'],
    [{}, 'no measurement at all'],
    [{ notes: 'looks well' }, 'notes without any measurement'],
  ];

  it.each(invalidVitals)('rejects %j (%s)', async (payload) => {
    const encounterId = await newEncounter();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/vitals`,
      headers: bearer(nurse),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('denies vitals to reception and allows them for a doctor', async () => {
    const encounterId = await newEncounter();
    const denied = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/vitals`,
      headers: bearer(reception),
      payload: { heartRate: 70 },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/vitals`,
      headers: bearer(doctor),
      payload: { heartRate: 70 },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('does not record measured values in the audit trail or event payload', async () => {
    const encounterId = await newEncounter();
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/vitals`,
      headers: bearer(nurse),
      payload: { heartRate: 137, notes: 'patient anxious' },
    });
    const { rows } = await getPool().query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_log WHERE action = 'vitals.record'`,
    );
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/137|anxious/);
    const events = await getPool().query<{ payload: unknown }>(
      `SELECT payload FROM event WHERE type = 'VITALS_RECORDED'`,
    );
    expect(JSON.stringify(events.rows[0]!.payload)).not.toMatch(/137|anxious/);
  });
});

describe('C001 — encounter status transitions', () => {
  it('advances checked_in → intake → ready', async () => {
    const encounterId = await newEncounter();
    const toIntake = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/status`,
      headers: bearer(nurse),
      payload: { status: 'intake' },
    });
    expect(toIntake.json().status).toBe('intake');

    const toReady = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/status`,
      headers: bearer(nurse),
      payload: { status: 'ready' },
    });
    expect(toReady.json().status).toBe('ready');
  });

  it('rejects a transition that skips the workflow', async () => {
    const encounterId = await newEncounter();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/status`,
      headers: bearer(nurse),
      payload: { status: 'ready' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('refuses to complete an encounter through the workflow endpoint', async () => {
    const encounterId = await newEncounter();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/status`,
      headers: bearer(nurse),
      payload: { status: 'completed' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a repeated transition to the same status', async () => {
    const encounterId = await newEncounter();
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/status`,
      headers: bearer(nurse),
      payload: { status: 'intake' },
    });
    const again = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/status`,
      headers: bearer(nurse),
      payload: { status: 'intake' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('blocks intake and vitals on a cancelled encounter', async () => {
    const encounterId = await newEncounter();
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/status`,
      headers: bearer(reception),
      payload: { status: 'cancelled', reason: 'patient_left' },
    });
    const intake = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/intake`,
      headers: bearer(nurse),
      payload: { chiefComplaint: 'Cough' },
    });
    expect(intake.statusCode).toBe(409);

    const vitals = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/vitals`,
      headers: bearer(nurse),
      payload: { heartRate: 70 },
    });
    expect(vitals.statusCode).toBe(409);
  });
});
