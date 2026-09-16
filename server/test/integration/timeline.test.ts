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

async function registerPatient(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/patients',
    headers: bearer(reception),
    payload: { fullName: name, sex: 'male' },
  });
  return res.json().id;
}

/** A complete visit: check-in → intake → vitals → consultation → completion. */
async function fullVisit(patientId: string, diagnosis: string): Promise<string> {
  const encounter = (
    await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: bearer(reception),
      payload: { patientId },
    })
  ).json();
  const id = encounter.id;
  await app.inject({
    method: 'POST',
    url: `/encounters/${id}/intake`,
    headers: bearer(nurse),
    payload: { chiefComplaint: `Complaint for ${diagnosis}` },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${id}/vitals`,
    headers: bearer(nurse),
    payload: { heartRate: 76, temperatureC: 36.9 },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${id}/status`,
    headers: bearer(nurse),
    payload: { status: 'ready' },
  });
  await app.inject({ method: 'POST', url: `/encounters/${id}/start`, headers: bearer(doctor) });
  await app.inject({
    method: 'PATCH',
    url: `/encounters/${id}/clinical`,
    headers: bearer(doctor),
    payload: {
      examination: 'Unremarkable',
      assessment: { summary: `Assessment: ${diagnosis}` },
      treatmentPlan: { summary: `Plan for ${diagnosis}` },
    },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${id}/diagnoses`,
    headers: bearer(doctor),
    payload: { description: diagnosis },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${id}/notes`,
    headers: bearer(doctor),
    payload: { body: `Note for ${diagnosis}` },
  });
  await app.inject({ method: 'POST', url: `/encounters/${id}/complete`, headers: bearer(doctor) });
  return id;
}

async function timeline(user: TestUser, patientId: string, query = '') {
  return app.inject({
    method: 'GET',
    url: `/patients/${patientId}/timeline${query}`,
    headers: bearer(user),
  });
}

describe('C004 — patient timeline', () => {
  it('returns an empty timeline for a patient with no visits', async () => {
    const patientId = await registerPatient('Fresh Patient');
    const res = await timeline(doctor, patientId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [], nextCursor: null });
  });

  it('gathers every clinical record type from a visit', async () => {
    const patientId = await registerPatient('Complete Visit');
    await fullVisit(patientId, 'Acute bronchitis');

    const res = await timeline(doctor, patientId);
    const kinds = new Set(res.json().entries.map((e: { kind: string }) => e.kind));
    expect(kinds).toEqual(
      new Set(['visit', 'intake', 'vitals', 'assessment', 'diagnosis', 'treatment_plan', 'note']),
    );

    const diagnosis = res
      .json()
      .entries.find((e: { kind: string }) => e.kind === 'diagnosis');
    expect(diagnosis.summary).toBe('Acute bronchitis');
    expect(diagnosis.detail.category).toBe('primary');

    const vitals = res.json().entries.find((e: { kind: string }) => e.kind === 'vitals');
    expect(vitals.detail.heartRate).toBe(76);
    // jsonb_strip_nulls keeps unmeasured vitals out of the payload entirely.
    expect(vitals.detail).not.toHaveProperty('spo2');
  });

  it('orders entries newest first across several visits', async () => {
    const patientId = await registerPatient('Repeat Visitor');
    await fullVisit(patientId, 'First condition');
    await fullVisit(patientId, 'Second condition');

    const entries = (await timeline(doctor, patientId)).json().entries as Array<{
      occurredAt: string;
      kind: string;
      summary: string | null;
    }>;
    const times = entries.map((e) => Date.parse(e.occurredAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const diagnoses = entries.filter((e) => e.kind === 'diagnosis').map((e) => e.summary);
    expect(diagnoses).toEqual(['Second condition', 'First condition']);
  });

  it('pages with a stable cursor and never repeats or skips an entry', async () => {
    const patientId = await registerPatient('Paged Patient');
    await fullVisit(patientId, 'Condition A');
    await fullVisit(patientId, 'Condition B');

    const all = (await timeline(doctor, patientId)).json().entries as Array<{ id: string }>;
    expect(all.length).toBeGreaterThan(4);

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = (await timeline(doctor, patientId, query)).json();
      collected.push(...page.entries.map((e: { id: string }) => e.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor);

    expect(collected).toEqual(all.map((e) => e.id));
    expect(new Set(collected).size).toBe(collected.length);
  });

  it('caps the page size and rejects a malformed cursor', async () => {
    const patientId = await registerPatient('Bounds Patient');
    expect((await timeline(doctor, patientId, '?limit=500')).statusCode).toBe(400);
    expect((await timeline(doctor, patientId, '?limit=0')).statusCode).toBe(400);
    expect((await timeline(doctor, patientId, '?cursor=not-a-cursor')).statusCode).toBe(400);
  });

  it('never mixes in another patient or another clinic', async () => {
    const mine = await registerPatient('My Patient');
    const otherPatient = await registerPatient('Other Patient');
    await fullVisit(mine, 'Mine only');
    await fullVisit(otherPatient, 'Theirs only');

    const entries = (await timeline(doctor, mine)).json().entries as Array<{
      summary: string | null;
    }>;
    expect(entries.some((e) => e.summary === 'Theirs only')).toBe(false);

    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'doc2', RoleKey.DOCTOR);
    expect((await timeline(otherDoctor, mine)).statusCode).toBe(404);
  });

  it('denies the timeline to reception and allows it to a nurse', async () => {
    const patientId = await registerPatient('Guarded Patient');
    expect((await timeline(reception, patientId)).statusCode).toBe(403);
    expect((await timeline(nurse, patientId)).statusCode).toBe(200);
  });

  it('audits the read without recording clinical content', async () => {
    const patientId = await registerPatient('Audited Patient');
    await fullVisit(patientId, 'Sensitive condition');
    await timeline(doctor, patientId);

    const { rows } = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'patient.timeline.read'`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/sensitive/i);
    expect(rows[0]!.metadata.entries).toBeGreaterThan(0);
  });
});
