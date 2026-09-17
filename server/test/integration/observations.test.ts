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

async function newEncounter(name = 'Observation Patient'): Promise<{ patientId: string; encounterId: string }> {
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
  return { patientId: patient.id, encounterId: encounter.id };
}

async function defineObservation(payload: Record<string, unknown>, user: TestUser = admin) {
  return app.inject({
    method: 'POST',
    url: '/observation-definitions',
    headers: bearer(user),
    payload,
  });
}

async function record(payload: Record<string, unknown>, user: TestUser = nurse) {
  return app.inject({ method: 'POST', url: '/observations', headers: bearer(user), payload });
}

const PASI = {
  key: 'pasi_score',
  name: 'PASI (psoriasis area and severity index)',
  category: 'scale',
  valueType: 'quantity',
  unit: 'score',
  minValue: 0,
  maxValue: 72,
  referenceLow: 0,
  referenceHigh: 10,
};

describe('Phase 3 — observation definitions', () => {
  it('creates a specialty observation as configuration', async () => {
    const res = await defineObservation(PASI);
    expect(res.statusCode).toBe(201);
    expect(res.json().key).toBe('pasi_score');
    expect(res.json().valueType).toBe('quantity');
    expect(res.json().referenceHigh).toBe(10);

    const list = await app.inject({
      method: 'GET',
      url: '/observation-definitions',
      headers: bearer(doctor),
    });
    expect(list.json().definitions).toHaveLength(1);
  });

  it('lets only an administrator manage definitions but clinicians read them', async () => {
    for (const user of [reception, nurse, doctor]) {
      expect((await defineObservation(PASI, user)).statusCode).toBe(403);
    }
    await defineObservation(PASI);
    expect(
      (await app.inject({ method: 'GET', url: '/observation-definitions', headers: bearer(nurse) }))
        .statusCode,
    ).toBe(200);
  });

  it('rejects malformed and inconsistent definitions', async () => {
    // Reference range on a text observation.
    expect(
      (await defineObservation({ key: 'x', name: 'X', valueType: 'text', referenceHigh: 5 }))
        .statusCode,
    ).toBe(400);
    // Coded without allowed codes.
    expect(
      (await defineObservation({ key: 'y', name: 'Y', valueType: 'coded' })).statusCode,
    ).toBe(400);
    // Quantity without a unit.
    expect(
      (await defineObservation({ key: 'z', name: 'Z', valueType: 'quantity' })).statusCode,
    ).toBe(400);
    // Bad key.
    expect(
      (await defineObservation({ ...PASI, key: 'Not A Key' })).statusCode,
    ).toBe(400);
  });

  it('refuses a duplicate definition key', async () => {
    expect((await defineObservation(PASI)).statusCode).toBe(201);
    expect((await defineObservation(PASI)).statusCode).toBe(409);
  });
});

describe('Phase 3 — recording observations', () => {
  it('records a numeric observation and flags it against the reference range', async () => {
    const def = (await defineObservation(PASI)).json();
    const { encounterId } = await newEncounter();

    const normal = await record({ definitionId: def.id, encounterId, valueNumber: 4 });
    expect(normal.statusCode).toBe(201);
    expect(normal.json().valueNumber).toBe(4);
    expect(normal.json().unit).toBe('score');
    expect(normal.json().isAbnormal).toBe(false);

    const abnormal = await record({ definitionId: def.id, encounterId, valueNumber: 28 });
    expect(abnormal.json().isAbnormal).toBe(true);

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE type = 'OBSERVATION_RECORDED'`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('enforces the definition bounds', async () => {
    const def = (await defineObservation(PASI)).json();
    const { encounterId } = await newEncounter();
    expect((await record({ definitionId: def.id, encounterId, valueNumber: 100 })).statusCode).toBe(400);
    expect((await record({ definitionId: def.id, encounterId, valueNumber: -1 })).statusCode).toBe(400);
  });

  it('is append-only: a recorded observation cannot be updated or deleted', async () => {
    const def = (await defineObservation(PASI)).json();
    const { encounterId } = await newEncounter();
    const recorded = await record({ definitionId: def.id, encounterId, valueNumber: 4 });
    expect(recorded.statusCode).toBe(201);
    const observationId = recorded.json().id;

    // A recorded measurement is part of the clinical record; the database is
    // the last line of defence. Corrections are new rows, never edits.
    await expect(
      getPool().query(`UPDATE observation SET value_number = 99 WHERE id = $1`, [observationId]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      getPool().query(`DELETE FROM observation WHERE id = $1`, [observationId]),
    ).rejects.toThrow(/append-only/i);

    const { rows } = await getPool().query<{ value_number: string }>(
      `SELECT value_number FROM observation WHERE id = $1`,
      [observationId],
    );
    expect(Number(rows[0]!.value_number)).toBe(4);
  });

  it('requires the value type the definition declares', async () => {
    const def = (await defineObservation(PASI)).json();
    const { encounterId } = await newEncounter();
    // PASI is numeric; a text value is rejected.
    expect((await record({ definitionId: def.id, encounterId, valueText: 'high' })).statusCode).toBe(400);
    // No value at all.
    expect((await record({ definitionId: def.id, encounterId })).statusCode).toBe(400);
    // Two values.
    expect(
      (await record({ definitionId: def.id, encounterId, valueNumber: 4, valueText: 'x' }))
        .statusCode,
    ).toBe(400);
  });

  it('records an integer observation and rejects a fraction', async () => {
    const def = (
      await defineObservation({
        key: 'cardiac_ef',
        name: 'Ejection fraction',
        valueType: 'integer',
        unit: '%',
        minValue: 0,
        maxValue: 100,
        referenceLow: 55,
        referenceHigh: 70,
      })
    ).json();
    const { encounterId } = await newEncounter();
    const low = await record({ definitionId: def.id, encounterId, valueNumber: 40 });
    expect(low.statusCode).toBe(201);
    expect(low.json().isAbnormal).toBe(true);
    expect((await record({ definitionId: def.id, encounterId, valueNumber: 40.5 })).statusCode).toBe(400);
  });

  it('records a coded observation and rejects a code outside the set', async () => {
    const def = (
      await defineObservation({
        key: 'skin_type',
        name: 'Fitzpatrick skin type',
        valueType: 'coded',
        allowedCodes: ['I', 'II', 'III', 'IV', 'V', 'VI'],
      })
    ).json();
    const { encounterId } = await newEncounter();
    const ok = await record({ definitionId: def.id, encounterId, valueCode: 'III' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().valueCode).toBe('III');
    expect(ok.json().isAbnormal).toBeNull();
    const bad = await record({ definitionId: def.id, encounterId, valueCode: 'VII' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.allowed).toContain('VI');
  });

  it('records boolean and text observations', async () => {
    const boolDef = (
      await defineObservation({ key: 'smoker', name: 'Current smoker', valueType: 'boolean' })
    ).json();
    const textDef = (
      await defineObservation({ key: 'gait_note', name: 'Gait note', valueType: 'text' })
    ).json();
    const { encounterId } = await newEncounter();
    expect((await record({ definitionId: boolDef.id, encounterId, valueBoolean: true })).json().valueBoolean).toBe(true);
    expect((await record({ definitionId: textDef.id, encounterId, valueText: 'antalgic gait' })).json().valueText).toBe('antalgic gait');
  });

  it('keeps repeat readings as separate observations', async () => {
    const def = (await defineObservation(PASI)).json();
    const { encounterId, patientId } = await newEncounter();
    await record({ definitionId: def.id, encounterId, valueNumber: 20 });
    await record({ definitionId: def.id, encounterId, valueNumber: 12 });

    const list = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/observations?definitionKey=pasi_score`,
      headers: bearer(doctor),
    });
    expect(list.json().observations).toHaveLength(2);
  });

  it('requires human confirmation for an AI-sourced observation', async () => {
    const def = (await defineObservation(PASI)).json();
    const { encounterId } = await newEncounter();
    const unconfirmed = await record({
      definitionId: def.id,
      encounterId,
      valueNumber: 5,
      source: 'ai_assisted',
    });
    expect(unconfirmed.statusCode).toBe(400);
    const confirmed = await record({
      definitionId: def.id,
      encounterId,
      valueNumber: 5,
      source: 'ai_assisted',
      confirmed: true,
    });
    expect(confirmed.statusCode).toBe(201);
  });

  it('denies recording to reception and permits it for nurse and doctor', async () => {
    const def = (await defineObservation(PASI)).json();
    const { encounterId } = await newEncounter();
    expect((await record({ definitionId: def.id, encounterId, valueNumber: 5 }, reception)).statusCode).toBe(403);
    expect((await record({ definitionId: def.id, encounterId, valueNumber: 5 }, nurse)).statusCode).toBe(201);
    expect((await record({ definitionId: def.id, encounterId, valueNumber: 5 }, doctor)).statusCode).toBe(201);
  });

  it('refuses to record against a closed encounter', async () => {
    const def = (await defineObservation(PASI)).json();
    const { encounterId } = await newEncounter();
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/status`,
      headers: bearer(reception),
      payload: { status: 'cancelled', reason: 'patient_left' },
    });
    expect((await record({ definitionId: def.id, encounterId, valueNumber: 5 })).statusCode).toBe(409);
  });

  it('keeps the measured value out of the audit trail and the event payload', async () => {
    const def = (
      await defineObservation({
        key: 'viral_load',
        name: 'HIV viral load',
        valueType: 'integer',
        unit: 'copies/mL',
        minValue: 0,
        maxValue: 10000000,
      })
    ).json();
    const { encounterId } = await newEncounter();
    await record({ definitionId: def.id, encounterId, valueNumber: 45000 });

    const audit = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'observation.record'`,
    );
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain('45000');
    expect(audit.rows[0]!.metadata.definitionKey).toBe('viral_load');
    const events = await getPool().query<{ payload: unknown }>(
      `SELECT payload FROM event WHERE type = 'OBSERVATION_RECORDED'`,
    );
    expect(JSON.stringify(events.rows[0]!.payload)).not.toContain('45000');
  });
});

describe('Phase 3 — integration and isolation', () => {
  it('shows observations on the workspace and the timeline', async () => {
    const def = (await defineObservation(PASI)).json();
    const { encounterId, patientId } = await newEncounter();
    await record({ definitionId: def.id, encounterId, valueNumber: 22 });

    const workspace = await app.inject({
      method: 'GET',
      url: `/encounters/${encounterId}`,
      headers: bearer(doctor),
    });
    expect(workspace.json().observations).toHaveLength(1);
    expect(workspace.json().observations[0].definitionKey).toBe('pasi_score');

    const timeline = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/timeline`,
      headers: bearer(doctor),
    });
    const entry = timeline
      .json()
      .entries.find((e: { kind: string }) => e.kind === 'observation');
    expect(entry).toBeTruthy();
    expect(entry.detail.key).toBe('pasi_score');
    expect(entry.detail.abnormal).toBe(true);
  });

  it('keeps definitions and observations inside the clinic boundary', async () => {
    const def = (await defineObservation(PASI)).json();
    const { encounterId } = await newEncounter();
    const other = await makeClinic('Other Clinic');
    const otherNurse = await makeUser(other.clinicId, 'nurse2', RoleKey.NURSE);

    // Another clinic cannot see this clinic's definition, so recording fails.
    const res = await record({ definitionId: def.id, encounterId, valueNumber: 5 }, otherNurse);
    expect(res.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: '/observation-definitions',
      headers: bearer(otherNurse),
    });
    expect(list.json().definitions).toHaveLength(0);
  });

  it('will not record one clinic observation against another clinic definition', async () => {
    const def = (await defineObservation(PASI)).json();
    const other = await makeClinic('Other Clinic');
    const otherAdmin = await makeUser(other.clinicId, 'admin2', RoleKey.ADMIN);
    const otherNurse = await makeUser(other.clinicId, 'nurse2', RoleKey.NURSE);
    const otherReception = await makeUser(other.clinicId, 'rec2', RoleKey.RECEPTION);
    const theirDef = (await defineObservation({ ...PASI, key: 'their_scale' }, otherAdmin)).json();

    const patient = (
      await app.inject({
        method: 'POST',
        url: '/patients',
        headers: bearer(otherReception),
        payload: { fullName: 'Their Patient', sex: 'male' },
      })
    ).json();
    const encounter = (
      await app.inject({
        method: 'POST',
        url: '/encounters/check-in',
        headers: bearer(otherReception),
        payload: { patientId: patient.id },
      })
    ).json();

    // Their encounter, but this clinic's definition id — not found in their clinic.
    const res = await record(
      { definitionId: def.id, encounterId: encounter.id, valueNumber: 5 },
      otherNurse,
    );
    expect(res.statusCode).toBe(404);
    // Their own definition works.
    expect(
      (await record({ definitionId: theirDef.id, encounterId: encounter.id, valueNumber: 5 }, otherNurse))
        .statusCode,
    ).toBe(201);
  });
});
