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

interface Visit {
  patientId: string;
  encounterId: string;
}

/** Drive a patient through registration → check-in → intake → ready. */
async function readyVisit(name = 'Workspace Patient'): Promise<Visit> {
  const patient = (
    await app.inject({
      method: 'POST',
      url: '/patients',
      headers: bearer(reception),
      payload: { fullName: name, sex: 'male' },
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
    payload: { chiefComplaint: 'Fever and sore throat' },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/status`,
    headers: bearer(nurse),
    payload: { status: 'ready' },
  });
  return { patientId: patient.id, encounterId: encounter.id };
}

/** Ready visit that a doctor has taken. */
async function startedVisit(name?: string): Promise<Visit> {
  const visit = await readyVisit(name);
  const res = await app.inject({
    method: 'POST',
    url: `/encounters/${visit.encounterId}/start`,
    headers: bearer(doctor),
  });
  expect(res.statusCode).toBe(200);
  return visit;
}

async function auditRows(action: string) {
  const { rows } = await getPool().query<{ metadata: Record<string, unknown>; outcome: string }>(
    `SELECT metadata, outcome FROM audit_log WHERE action = $1 ORDER BY id`,
    [action],
  );
  return rows;
}

describe('C002 — consultation lifecycle', () => {
  it('lets a doctor take a ready patient and records the attending clinician', async () => {
    const { encounterId } = await readyVisit();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/start`,
      headers: bearer(doctor),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().encounter.status).toBe('in_progress');
    expect(res.json().clinical.attendingDoctorId).toBe(doctor.userId);
    expect(res.json().clinical.startedAt).not.toBeNull();
  });

  it('denies starting a consultation to a nurse', async () => {
    const { encounterId } = await readyVisit();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/start`,
      headers: bearer(nurse),
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses clinical writes before the consultation is started', async () => {
    const { encounterId } = await readyVisit();
    const res = await app.inject({
      method: 'PATCH',
      url: `/encounters/${encounterId}/clinical`,
      headers: bearer(doctor),
      payload: { examination: 'Chest clear' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('blocks a second doctor from writing without an audited handover', async () => {
    const { encounterId } = await startedVisit();
    const other = await makeUser(clinicId, 'doctor2', RoleKey.DOCTOR);

    const blocked = await app.inject({
      method: 'PATCH',
      url: `/encounters/${encounterId}/clinical`,
      headers: bearer(other),
      payload: { examination: 'Written by the wrong doctor' },
    });
    expect(blocked.statusCode).toBe(403);

    const takeover = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/start`,
      headers: bearer(other),
    });
    expect(takeover.statusCode).toBe(200);
    expect(takeover.json().clinical.attendingDoctorId).toBe(other.userId);

    const rows = await auditRows('encounter.takeover');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.previousDoctorId).toBe(doctor.userId);

    const allowed = await app.inject({
      method: 'PATCH',
      url: `/encounters/${encounterId}/clinical`,
      headers: bearer(other),
      payload: { examination: 'Chest clear' },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('C002 — clinical record', () => {
  it('records complaint, examination, assessment and treatment plan', async () => {
    const { encounterId } = await startedVisit();
    const res = await app.inject({
      method: 'PATCH',
      url: `/encounters/${encounterId}/clinical`,
      headers: bearer(doctor),
      payload: {
        complaint: 'Sore throat, 3 days',
        examination: 'Tonsils inflamed, no exudate',
        assessment: { summary: 'Viral pharyngitis', severity: 'mild' },
        treatmentPlan: {
          summary: 'Supportive care',
          instructions: 'Fluids and rest',
          followUpInDays: 7,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.clinical.examination).toBe('Tonsils inflamed, no exudate');
    expect(body.assessment.summary).toBe('Viral pharyngitis');
    expect(body.treatmentPlan.followUpInDays).toBe(7);
  });

  it('leaves omitted fields untouched on a partial update', async () => {
    const { encounterId } = await startedVisit();
    await app.inject({
      method: 'PATCH',
      url: `/encounters/${encounterId}/clinical`,
      headers: bearer(doctor),
      payload: { complaint: 'Sore throat', examination: 'Tonsils inflamed' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/encounters/${encounterId}/clinical`,
      headers: bearer(doctor),
      payload: { examination: 'Tonsils inflamed, exudate present' },
    });
    expect(res.json().clinical.complaint).toBe('Sore throat');
    expect(res.json().clinical.examination).toBe('Tonsils inflamed, exudate present');
  });

  it('rejects an empty clinical patch', async () => {
    const { encounterId } = await startedVisit();
    const res = await app.inject({
      method: 'PATCH',
      url: `/encounters/${encounterId}/clinical`,
      headers: bearer(doctor),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps clinical narrative out of the audit trail and event payloads', async () => {
    const { encounterId } = await startedVisit();
    await app.inject({
      method: 'PATCH',
      url: `/encounters/${encounterId}/clinical`,
      headers: bearer(doctor),
      payload: { examination: 'Palpable hepatomegaly', assessment: { summary: 'Suspected cirrhosis' } },
    });
    const rows = await auditRows('encounter.clinical.update');
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/hepatomegaly|cirrhosis/i);
    expect(rows[0]!.metadata.sections).toEqual(expect.arrayContaining(['examination', 'assessment']));

    const events = await getPool().query<{ payload: unknown }>(
      `SELECT payload FROM event WHERE type = 'ENCOUNTER_CLINICAL_UPDATED'`,
    );
    expect(JSON.stringify(events.rows[0]!.payload)).not.toMatch(/hepatomegaly|cirrhosis/i);
  });
});

describe('C002 — diagnosis', () => {
  async function diagnose(encounterId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/diagnoses`,
      headers: bearer(doctor),
      payload,
    });
  }

  it('records a coded diagnosis', async () => {
    const { encounterId } = await startedVisit();
    const res = await diagnose(encounterId, {
      description: 'Acute pharyngitis',
      codeSystem: 'ICD-10',
      code: 'J02.9',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().category).toBe('primary');
    expect(res.json().certainty).toBe('confirmed');
  });

  it('rejects a code without its coding system', async () => {
    const { encounterId } = await startedVisit();
    const res = await diagnose(encounterId, { description: 'Acute pharyngitis', code: 'J02.9' });
    expect(res.statusCode).toBe(400);
  });

  it('allows only one primary diagnosis per encounter', async () => {
    const { encounterId } = await startedVisit();
    expect((await diagnose(encounterId, { description: 'Pharyngitis' })).statusCode).toBe(201);
    const second = await diagnose(encounterId, { description: 'Otitis media' });
    expect(second.statusCode).toBe(409);
    const secondary = await diagnose(encounterId, {
      description: 'Otitis media',
      category: 'secondary',
    });
    expect(secondary.statusCode).toBe(201);
  });

  it('audits a diagnosis revision with the before and after coded values', async () => {
    const { encounterId } = await startedVisit();
    const created = (
      await diagnose(encounterId, { description: 'Pharyngitis', certainty: 'suspected' })
    ).json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/encounters/${encounterId}/diagnoses/${created.id}`,
      headers: bearer(doctor),
      payload: { certainty: 'confirmed', status: 'active' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().certainty).toBe('confirmed');

    const rows = await auditRows('diagnosis.revise');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.from).toMatchObject({ certainty: 'suspected' });
    expect(rows[0]!.metadata.to).toMatchObject({ certainty: 'confirmed' });
  });

  it('denies diagnosis to a nurse', async () => {
    const { encounterId } = await startedVisit();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/diagnoses`,
      headers: bearer(nurse),
      payload: { description: 'Pharyngitis' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('will not revise a diagnosis belonging to another encounter', async () => {
    const first = await startedVisit('Patient One');
    const created = (
      await app.inject({
        method: 'POST',
        url: `/encounters/${first.encounterId}/diagnoses`,
        headers: bearer(doctor),
        payload: { description: 'Pharyngitis' },
      })
    ).json();
    const second = await startedVisit('Patient Two');

    const res = await app.inject({
      method: 'PATCH',
      url: `/encounters/${second.encounterId}/diagnoses/${created.id}`,
      headers: bearer(doctor),
      payload: { status: 'resolved' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('C002 — clinical notes', () => {
  it('appends notes in order and links a correction to what it supersedes', async () => {
    const { encounterId } = await startedVisit();
    const first = (
      await app.inject({
        method: 'POST',
        url: `/encounters/${encounterId}/notes`,
        headers: bearer(doctor),
        payload: { body: 'Patient reports improvement' },
      })
    ).json();

    const correction = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/notes`,
      headers: bearer(doctor),
      payload: {
        body: 'Correction: patient reports no improvement',
        noteType: 'correction',
        supersedesId: first.id,
      },
    });
    expect(correction.statusCode).toBe(201);
    expect(correction.json().supersedesId).toBe(first.id);
  });

  it('rejects a supersedes link on a non-correction note', async () => {
    const { encounterId } = await startedVisit();
    const first = (
      await app.inject({
        method: 'POST',
        url: `/encounters/${encounterId}/notes`,
        headers: bearer(doctor),
        payload: { body: 'Initial note' },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/notes`,
      headers: bearer(doctor),
      payload: { body: 'Another note', noteType: 'progress', supersedesId: first.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the note history append-only at the database level', async () => {
    const { encounterId } = await startedVisit();
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/notes`,
      headers: bearer(doctor),
      payload: { body: 'Original observation' },
    });
    await expect(
      getPool().query(`UPDATE clinical_note SET body = 'tampered'`),
    ).rejects.toThrow(/append-only/);
    await expect(getPool().query(`DELETE FROM clinical_note`)).rejects.toThrow(/append-only/);
  });
});

describe('C002 — completing a consultation', () => {
  async function diagnosed(): Promise<string> {
    const { encounterId } = await startedVisit();
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/diagnoses`,
      headers: bearer(doctor),
      payload: { description: 'Acute pharyngitis' },
    });
    return encounterId;
  }

  it('lets only a doctor complete a consultation', async () => {
    const encounterId = await diagnosed();

    for (const user of [nurse, reception]) {
      const denied = await app.inject({
        method: 'POST',
        url: `/encounters/${encounterId}/complete`,
        headers: bearer(user),
      });
      expect(denied.statusCode).toBe(403);
    }

    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/complete`,
      headers: bearer(doctor),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('completed');

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE type = 'ENCOUNTER_COMPLETED'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('refuses to complete a consultation with no assessment and no diagnosis', async () => {
    const { encounterId } = await startedVisit();
    const res = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/complete`,
      headers: bearer(doctor),
    });
    expect(res.statusCode).toBe(409);
  });

  it('closes the clinical record to further writes once completed', async () => {
    const encounterId = await diagnosed();
    await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/complete`,
      headers: bearer(doctor),
    });

    for (const call of [
      { method: 'PATCH' as const, url: `/encounters/${encounterId}/clinical`, payload: { examination: 'x' } },
      { method: 'POST' as const, url: `/encounters/${encounterId}/notes`, payload: { body: 'late note' } },
      { method: 'POST' as const, url: `/encounters/${encounterId}/diagnoses`, payload: { description: 'late dx' } },
    ]) {
      const res = await app.inject({ ...call, headers: bearer(doctor) });
      expect(res.statusCode).toBe(409);
    }

    const again = await app.inject({
      method: 'POST',
      url: `/encounters/${encounterId}/complete`,
      headers: bearer(doctor),
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('C002 — workspace read', () => {
  it('assembles the full consultation for a doctor, including previous visits', async () => {
    const first = await startedVisit('Repeat Patient');
    await app.inject({
      method: 'POST',
      url: `/encounters/${first.encounterId}/diagnoses`,
      headers: bearer(doctor),
      payload: { description: 'Acute pharyngitis' },
    });
    await app.inject({
      method: 'POST',
      url: `/encounters/${first.encounterId}/complete`,
      headers: bearer(doctor),
    });

    // Same patient returns for a second visit.
    const second = (
      await app.inject({
        method: 'POST',
        url: '/encounters/check-in',
        headers: bearer(reception),
        payload: { patientId: first.patientId },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/encounters/${second.id}/intake`,
      headers: bearer(nurse),
      payload: { chiefComplaint: 'Cough' },
    });
    await app.inject({
      method: 'POST',
      url: `/encounters/${second.id}/vitals`,
      headers: bearer(nurse),
      payload: { heartRate: 82 },
    });
    await app.inject({
      method: 'POST',
      url: `/encounters/${second.id}/status`,
      headers: bearer(nurse),
      payload: { status: 'ready' },
    });
    await app.inject({
      method: 'POST',
      url: `/encounters/${second.id}/start`,
      headers: bearer(doctor),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/encounters/${second.id}`,
      headers: bearer(doctor),
    });
    expect(res.statusCode).toBe(200);
    const w = res.json();
    expect(w.patient.fullName).toBe('Repeat Patient');
    expect(w.intake.chiefComplaint).toBe('Cough');
    expect(w.vitals).toHaveLength(1);
    expect(w.previousVisits).toHaveLength(1);
    expect(w.previousVisits[0].primaryDiagnosis).toBe('Acute pharyngitis');
    expect(w.previousVisits[0].encounterId).toBe(first.encounterId);
  });

  it('omits clinical sections for a caller without clinical read permission', async () => {
    const { encounterId } = await startedVisit();
    const res = await app.inject({
      method: 'GET',
      url: `/encounters/${encounterId}`,
      headers: bearer(reception),
    });
    expect(res.statusCode).toBe(200);
    const w = res.json();
    expect(w.patient.mrn).toBeDefined();
    // Reception holds encounter:read only — no clinical content is returned.
    expect(w).not.toHaveProperty('intake');
    expect(w).not.toHaveProperty('vitals');
    expect(w).not.toHaveProperty('diagnoses');
    expect(w).not.toHaveProperty('notes');
  });

  it('gives a nurse the clinical record read-only', async () => {
    const { encounterId } = await startedVisit();
    const read = await app.inject({
      method: 'GET',
      url: `/encounters/${encounterId}`,
      headers: bearer(nurse),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toHaveProperty('diagnoses');

    const write = await app.inject({
      method: 'PATCH',
      url: `/encounters/${encounterId}/clinical`,
      headers: bearer(nurse),
      payload: { examination: 'Nurse should not write this' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('does not expose an encounter from another clinic', async () => {
    const { encounterId } = await startedVisit();
    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'doc2', RoleKey.DOCTOR);
    const res = await app.inject({
      method: 'GET',
      url: `/encounters/${encounterId}`,
      headers: bearer(otherDoctor),
    });
    expect(res.statusCode).toBe(404);
  });
});
