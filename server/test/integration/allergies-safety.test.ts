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

async function newPatient(name = 'Safety Patient', user: TestUser = reception) {
  const res = await app.inject({
    method: 'POST',
    url: '/patients',
    headers: bearer(user),
    payload: { fullName: name, sex: 'male' },
  });
  return res.json();
}

async function addAllergy(patientId: string, payload: Record<string, unknown>, user: TestUser = nurse) {
  return app.inject({
    method: 'POST',
    url: `/patients/${patientId}/allergies`,
    headers: bearer(user),
    payload,
  });
}

/** Register, check in, take intake, mark ready, start the consultation. */
async function startedEncounter(patientId: string): Promise<string> {
  const encounter = (
    await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: bearer(reception),
      payload: { patientId },
    })
  ).json();
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/intake`,
    headers: bearer(nurse),
    payload: { chiefComplaint: 'Infection' },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/status`,
    headers: bearer(nurse),
    payload: { status: 'ready' },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/start`,
    headers: bearer(doctor),
  });
  return encounter.id;
}

async function prescribe(encounterId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/encounters/${encounterId}/prescriptions`,
    headers: bearer(doctor),
    payload,
  });
}

const AMOX = {
  medicationName: 'Amoxicillin 500mg',
  dose: '500 mg',
  route: 'oral',
  frequency: 'three times daily',
};

describe('Phase 8 — allergy records', () => {
  it('records a structured allergy and orders the list by severity', async () => {
    const patient = await newPatient();
    expect((await addAllergy(patient.id, { substance: 'Penicillin', severity: 'severe' })).statusCode).toBe(201);
    expect((await addAllergy(patient.id, { substance: 'Aspirin', severity: 'mild', category: 'medication' })).statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/allergies`,
      headers: bearer(doctor),
    });
    expect(list.json().allergies).toHaveLength(2);
    expect(list.json().allergies[0].substance).toBe('Penicillin');
  });

  it('refuses a duplicate active allergy to the same substance', async () => {
    const patient = await newPatient();
    expect((await addAllergy(patient.id, { substance: 'Penicillin' })).statusCode).toBe(201);
    expect((await addAllergy(patient.id, { substance: '  penicillin ' })).statusCode).toBe(409);
  });

  it('lets a nurse and doctor write but reception only read', async () => {
    const patient = await newPatient();
    expect((await addAllergy(patient.id, { substance: 'Latex', category: 'environment' }, reception)).statusCode).toBe(403);
    expect((await addAllergy(patient.id, { substance: 'Latex', category: 'environment' }, doctor)).statusCode).toBe(201);
    const read = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/allergies`,
      headers: bearer(reception),
    });
    expect(read.statusCode).toBe(200);
  });

  it('amends an allergy status and frees the substance for a new active record', async () => {
    const patient = await newPatient();
    const allergy = (await addAllergy(patient.id, { substance: 'Penicillin', verification: 'unconfirmed' })).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/patients/${patient.id}/allergies/${allergy.id}`,
      headers: bearer(doctor),
      payload: { status: 'entered_in_error' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('entered_in_error');
    // Now the same substance can be recorded active again.
    expect((await addAllergy(patient.id, { substance: 'Penicillin' })).statusCode).toBe(201);
  });

  it('keeps the substance out of audit metadata and event payloads', async () => {
    const patient = await newPatient();
    await addAllergy(patient.id, { substance: 'Sulfamethoxazole', severity: 'severe' });
    const audit = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'allergy.record'`,
    );
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toMatch(/sulfamethoxazole/i);
    expect(audit.rows[0]!.metadata.severity).toBe('severe');
    const events = await getPool().query<{ payload: unknown }>(
      `SELECT payload FROM event WHERE type = 'ALLERGY_RECORDED'`,
    );
    expect(JSON.stringify(events.rows[0]!.payload)).not.toMatch(/sulfamethoxazole/i);
  });
});

describe('Phase 8 — prescribing safety check', () => {
  it('blocks a prescription that matches an active allergy', async () => {
    const patient = await newPatient('Allergic Patient');
    await addAllergy(patient.id, { substance: 'Penicillin', severity: 'severe' });
    const encounterId = await startedEncounter(patient.id);

    const res = await prescribe(encounterId, {
      items: [{ ...AMOX, medicationName: 'Penicillin V' }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.alerts).toHaveLength(1);
    expect(res.json().error.details.alerts[0].type).toBe('allergy');
    expect(res.json().error.details.alerts[0].substance).toBe('Penicillin');

    // Nothing was written.
    const { rows } = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM prescription`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('allows the prescription with an audited override', async () => {
    const patient = await newPatient('Override Patient');
    await addAllergy(patient.id, { substance: 'Penicillin', severity: 'moderate' });
    const encounterId = await startedEncounter(patient.id);

    const res = await prescribe(encounterId, {
      items: [{ ...AMOX, medicationName: 'Penicillin V' }],
      acknowledgeAlerts: true,
      overrideReason: 'Prior reaction was mild rash; benefit outweighs risk',
    });
    expect(res.statusCode).toBe(201);

    const { rows } = await getPool().query<{ reason: string; alert_type: string }>(
      `SELECT reason, alert_type FROM safety_override`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.alert_type).toBe('allergy');

    const events = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE type = 'SAFETY_ALERT_OVERRIDDEN'`,
    );
    expect(Number(events.rows[0]!.n)).toBe(1);
  });

  it('requires a reason to override', async () => {
    const patient = await newPatient('Reasonless Patient');
    await addAllergy(patient.id, { substance: 'Penicillin' });
    const encounterId = await startedEncounter(patient.id);
    const res = await prescribe(encounterId, {
      items: [{ ...AMOX, medicationName: 'Penicillin V' }],
      acknowledgeAlerts: true,
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not flag an unrelated medication', async () => {
    const patient = await newPatient('Unrelated Patient');
    await addAllergy(patient.id, { substance: 'Penicillin' });
    const encounterId = await startedEncounter(patient.id);
    const res = await prescribe(encounterId, {
      items: [{ ...AMOX, medicationName: 'Paracetamol' }],
    });
    expect(res.statusCode).toBe(201);
  });

  it('does not match on a short substring (pen vs penicillin)', async () => {
    const patient = await newPatient('Substring Patient');
    await addAllergy(patient.id, { substance: 'Pen' });
    const encounterId = await startedEncounter(patient.id);
    // "Pen" is not a whole word inside "Penicillin", so no false positive.
    const res = await prescribe(encounterId, {
      items: [{ ...AMOX, medicationName: 'Penicillin V' }],
    });
    expect(res.statusCode).toBe(201);
  });

  it('ignores an inactive or refuted allergy', async () => {
    const patient = await newPatient('Refuted Patient');
    const allergy = (await addAllergy(patient.id, { substance: 'Penicillin' })).json();
    await app.inject({
      method: 'PATCH',
      url: `/patients/${patient.id}/allergies/${allergy.id}`,
      headers: bearer(doctor),
      payload: { verification: 'refuted' },
    });
    const encounterId = await startedEncounter(patient.id);
    const res = await prescribe(encounterId, {
      items: [{ ...AMOX, medicationName: 'Penicillin V' }],
    });
    expect(res.statusCode).toBe(201);
  });

  it('warns on a duplicate active medication', async () => {
    const patient = await newPatient('Duplicate Patient');
    const firstEnc = await startedEncounter(patient.id);
    expect((await prescribe(firstEnc, { items: [AMOX] })).statusCode).toBe(201);
    await app.inject({
      method: 'POST',
      url: `/encounters/${firstEnc}/diagnoses`,
      headers: bearer(doctor),
      payload: { description: 'Infection' },
    });
    await app.inject({ method: 'POST', url: `/encounters/${firstEnc}/complete`, headers: bearer(doctor) });

    // A new visit prescribing the same drug while the first is still active.
    const secondEnc = await startedEncounter(patient.id);
    const dup = await prescribe(secondEnc, { items: [AMOX] });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.details.alerts[0].type).toBe('duplicate_medication');

    const override = await prescribe(secondEnc, {
      items: [AMOX],
      acknowledgeAlerts: true,
      overrideReason: 'Continuing the same course deliberately',
    });
    expect(override.statusCode).toBe(201);
  });

  it('does not warn about a duplicate once the earlier prescription is cancelled', async () => {
    const patient = await newPatient('Cancelled Dup Patient');
    const encounterId = await startedEncounter(patient.id);
    const rx = (await prescribe(encounterId, { items: [AMOX] })).json();
    // Re-prescribing the same drug now warns (the first is still active)...
    const warned = await prescribe(encounterId, { items: [AMOX] });
    expect(warned.statusCode).toBe(409);
    expect(warned.json().error.details.alerts[0].type).toBe('duplicate_medication');

    // ...but not after the first is cancelled.
    await app.inject({
      method: 'POST',
      url: `/prescriptions/${rx.id}/cancel`,
      headers: bearer(doctor),
      payload: { reason: 'Wrong dose' },
    });
    const res = await prescribe(encounterId, { items: [AMOX] });
    expect(res.statusCode).toBe(201);
  });

  it('protects a merged patient using the duplicate record allergies', async () => {
    const survivor = await newPatient('Merge Survivor');
    const duplicate = await newPatient('Merge Duplicate');
    // Allergy recorded on the DUPLICATE before the merge.
    await addAllergy(duplicate.id, { substance: 'Penicillin', severity: 'severe' });
    await app.inject({
      method: 'POST',
      url: `/patients/${survivor.id}/merge`,
      headers: bearer(admin),
      payload: { sourcePatientId: duplicate.id, reason: 'Duplicate registration' },
    });

    // Prescribing to the SURVIVOR must still see the duplicate's allergy.
    const encounterId = await startedEncounter(survivor.id);
    const res = await prescribe(encounterId, {
      items: [{ ...AMOX, medicationName: 'Penicillin V' }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.alerts[0].type).toBe('allergy');
  });

  it('keeps the safety override ledger append-only', async () => {
    const patient = await newPatient('Ledger Patient');
    await addAllergy(patient.id, { substance: 'Penicillin' });
    const encounterId = await startedEncounter(patient.id);
    await prescribe(encounterId, {
      items: [{ ...AMOX, medicationName: 'Penicillin V' }],
      acknowledgeAlerts: true,
      overrideReason: 'Deliberate clinical decision',
    });
    await expect(getPool().query(`UPDATE safety_override SET reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(getPool().query(`DELETE FROM safety_override`)).rejects.toThrow(/append-only/);
  });

  it('records the override reason in the ledger but not in audit metadata', async () => {
    const patient = await newPatient('Reason PHI Patient');
    await addAllergy(patient.id, { substance: 'Penicillin' });
    const encounterId = await startedEncounter(patient.id);
    await prescribe(encounterId, {
      items: [{ ...AMOX, medicationName: 'Penicillin V' }],
      acknowledgeAlerts: true,
      overrideReason: 'Patient tolerated a test dose under supervision',
    });
    const audit = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'safety.override'`,
    );
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toMatch(/test dose/i);
    expect(audit.rows[0]!.metadata.alertTypes).toContain('allergy');
  });
});

describe('Phase 8 — safety preview', () => {
  it('dry-runs the checks without prescribing', async () => {
    const patient = await newPatient('Preview Patient');
    await addAllergy(patient.id, { substance: 'Penicillin' });
    const encounterId = await startedEncounter(patient.id);

    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/prescription-safety-check`,
      headers: bearer(doctor),
      payload: { items: [{ ...AMOX, medicationName: 'Penicillin V' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().alerts).toHaveLength(1);

    // Preview writes nothing.
    const { rows } = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM prescription`);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('Phase 8 — isolation and workspace', () => {
  it('shows allergies on the encounter workspace', async () => {
    const patient = await newPatient('Workspace Allergy');
    await addAllergy(patient.id, { substance: 'Penicillin', severity: 'severe' });
    const encounterId = await startedEncounter(patient.id);
    const res = await app.inject({
      method: 'GET',
      url: `/encounters/${encounterId}`,
      headers: bearer(doctor),
    });
    expect(res.json().allergies).toHaveLength(1);
    expect(res.json().allergies[0].substance).toBe('Penicillin');
  });

  it('keeps allergies inside the clinic boundary', async () => {
    const patient = await newPatient();
    await addAllergy(patient.id, { substance: 'Penicillin' });
    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'doc2', RoleKey.DOCTOR);
    const res = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/allergies`,
      headers: bearer(otherDoctor),
    });
    expect(res.statusCode).toBe(404);
  });

  it('denies allergy visibility to a pharma rep', async () => {
    const patient = await newPatient();
    await addAllergy(patient.id, { substance: 'Penicillin' });
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    const res = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/allergies`,
      headers: bearer(pharma),
    });
    expect(res.statusCode).toBe(403);
  });
});
