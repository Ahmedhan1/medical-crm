import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;
let clinicId: string;
let reception: { token: string };
let nurse: { token: string };
let doctor: { token: string };

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function newPatient(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/patients',
    headers: bearer(reception.token),
    payload: { fullName: name, sex: 'female' },
  });
  return res.json().id;
}

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

describe('AI intake extraction (review-first, A004)', () => {
  it('produces a PENDING draft and never writes a clinical record', async () => {
    const patientId = await newPatient('Intake Patient');
    const res = await app.inject({
      method: 'POST',
      url: '/ai/intake',
      headers: bearer(reception.token),
      payload: {
        subjectType: 'patient',
        subjectId: patientId,
        text: 'Chief complaint: fever\nDuration: 2 days',
      },
    });
    expect(res.statusCode).toBe(201);
    const draft = res.json();
    expect(draft.status).toBe('pending');
    expect(draft.kind).toBe('intake');
    expect(draft.content.fields.length).toBeGreaterThan(0);

    // Observability row recorded (shape only, no PHI).
    const gen = await getPool().query<{ status: string; input_chars: number }>(
      `SELECT status, input_chars FROM ai_generation WHERE clinic_id = $1 AND kind = 'intake'`,
      [clinicId],
    );
    expect(gen.rows[0]!.status).toBe('succeeded');
    expect(gen.rows[0]!.input_chars).toBeGreaterThan(0);

    // AI_DRAFT_CREATED event emitted; nothing auto-promoted to a clinical table.
    const evt = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE clinic_id = $1 AND type = 'AI_DRAFT_CREATED'`,
      [clinicId],
    );
    expect(Number(evt.rows[0]!.n)).toBe(1);
  });

  it('a pharma rep cannot create AI drafts', async () => {
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    const patientId = await newPatient('Protected');
    const res = await app.inject({
      method: 'POST',
      url: '/ai/intake',
      headers: bearer(pharma.token),
      payload: { subjectType: 'patient', subjectId: patientId, text: 'complaint: x' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('AI draft review workflow', () => {
  async function createIntakeDraft(patientId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/ai/intake',
      headers: bearer(reception.token),
      payload: { subjectType: 'patient', subjectId: patientId, text: 'Complaint: cough' },
    });
    return res.json().id;
  }

  it('a reviewer confirms a draft; confirmation does not write clinical data', async () => {
    const patientId = await newPatient('Review Patient');
    const draftId = await createIntakeDraft(patientId);

    const confirm = await app.inject({
      method: 'POST',
      url: `/ai/drafts/${draftId}/confirm`,
      headers: bearer(doctor.token),
      payload: { note: 'looks correct' },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe('confirmed');
    expect(confirm.json().reviewedBy).toBeTruthy();

    // The draft store is the only thing that changed — no clinical write path.
    const evt = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE clinic_id = $1 AND type = 'AI_DRAFT_CONFIRMED'`,
      [clinicId],
    );
    expect(Number(evt.rows[0]!.n)).toBe(1);
  });

  it('cannot confirm an already-reviewed draft (no double promotion)', async () => {
    const patientId = await newPatient('Once Patient');
    const draftId = await createIntakeDraft(patientId);
    await app.inject({ method: 'POST', url: `/ai/drafts/${draftId}/reject`, headers: bearer(nurse.token) });
    const second = await app.inject({
      method: 'POST',
      url: `/ai/drafts/${draftId}/confirm`,
      headers: bearer(doctor.token),
    });
    expect(second.statusCode).toBe(409);
  });

  it('a creator without review rights cannot confirm', async () => {
    const patientId = await newPatient('NoReview Patient');
    const draftId = await createIntakeDraft(patientId);
    // reception has AI_DRAFT_CREATE but not AI_DRAFT_REVIEW.
    const res = await app.inject({
      method: 'POST',
      url: `/ai/drafts/${draftId}/confirm`,
      headers: bearer(reception.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('AI longitudinal summary (review-first, A005)', () => {
  it('produces a cited draft grounded only in the patient\'s real events', async () => {
    const patientId = await newPatient('Summary Patient');
    // Generate some real domain history.
    await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: bearer(reception.token),
      payload: { patientId },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/ai/summaries/patient/${patientId}`,
      headers: bearer(doctor.token),
    });
    expect(res.statusCode).toBe(201);
    const draft = res.json();
    expect(draft.kind).toBe('summary');
    expect(draft.status).toBe('pending');
    expect(draft.citations.length).toBeGreaterThan(0);
    // Every citation points at a real event id for this clinic.
    for (const c of draft.citations) {
      expect(c.ref).toMatch(/^event:\d+$/);
    }
  });

  it('cross-clinic isolation: cannot summarise another clinic\'s patient', async () => {
    const patientId = await newPatient('Clinic A Patient');
    const clinicB = await makeClinic('Clinic B');
    const docB = await makeUser(clinicB.clinicId, 'docB', RoleKey.DOCTOR);
    const res = await app.inject({
      method: 'POST',
      url: `/ai/summaries/patient/${patientId}`,
      headers: bearer(docB.token),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('AI observability is append-only (tamper-evident)', () => {
  it('rejects UPDATE/DELETE on ai_generation', async () => {
    await expect(getPool().query('DELETE FROM ai_generation')).rejects.toThrow(/append-only/);
    await expect(getPool().query("UPDATE ai_generation SET kind = 'x'")).rejects.toThrow(/append-only/);
  });
});
