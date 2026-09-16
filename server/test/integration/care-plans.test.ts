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

afterAll(async () => { if (app) await app.close(); });

async function newPatient(name = 'Care Plan Patient') {
  return (await app.inject({ method: 'POST', url: '/patients', headers: bearer(reception), payload: { fullName: name, sex: 'female' } })).json();
}
async function createPlan(patientId: string, over: Record<string, unknown> = {}, user: TestUser = doctor) {
  return app.inject({ method: 'POST', url: '/care-plans', headers: bearer(user), payload: { patientId, title: 'Diabetes management', periodStart: '2026-01-01', goals: [{ description: 'HbA1c below 7%' }], activities: [{ description: 'Dietitian referral', kind: 'referral' }], ...over } });
}
async function eventCount(type: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM event WHERE type = $1`, [type]);
  return Number(rows[0]!.n);
}

describe('Care plans — authoring', () => {
  it('creates a plan with goals and activities', async () => {
    const patient = await newPatient();
    const res = await createPlan(patient.id);
    expect(res.statusCode).toBe(201);
    const plan = res.json();
    expect(plan.status).toBe('active');
    expect(plan.goals).toHaveLength(1);
    expect(plan.activities).toHaveLength(1);
    expect(await eventCount('CARE_PLAN_CREATED')).toBe(1);
  });

  it('links a plan to a treatment episode', async () => {
    const patient = await newPatient();
    const episode = (await app.inject({ method: 'POST', url: `/patients/${patient.id}/treatment-episodes`, headers: bearer(doctor), payload: { label: 'Diabetes', startedOn: '2026-01-01' } })).json();
    const res = await createPlan(patient.id, { episodeId: episode.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().episodeId).toBe(episode.id);
  });

  it('rejects an invalid period', async () => {
    const patient = await newPatient();
    expect((await createPlan(patient.id, { periodStart: '2026-06-01', periodEnd: '2026-01-01' })).statusCode).toBe(400);
  });

  it('is doctor-owned for authoring; reception cannot create', async () => {
    const patient = await newPatient();
    expect((await createPlan(patient.id, {}, reception)).statusCode).toBe(403);
    expect((await createPlan(patient.id, {}, nurse)).statusCode).toBe(403);
  });
});

describe('Care plans — status & progress (deterministic)', () => {
  it('follows the plan status machine and rejects invalid moves', async () => {
    const patient = await newPatient();
    const plan = (await createPlan(patient.id)).json();
    const hold = await app.inject({ method: 'POST', url: `/care-plans/${plan.id}/status`, headers: bearer(doctor), payload: { status: 'on_hold' } });
    expect(hold.json().status).toBe('on_hold');
    // on_hold cannot go straight to completed.
    const bad = await app.inject({ method: 'POST', url: `/care-plans/${plan.id}/status`, headers: bearer(doctor), payload: { status: 'completed' } });
    expect(bad.statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/care-plans/${plan.id}/status`, headers: bearer(doctor), payload: { status: 'active' } });
    const done = await app.inject({ method: 'POST', url: `/care-plans/${plan.id}/status`, headers: bearer(doctor), payload: { status: 'completed' } });
    expect(done.json().status).toBe('completed');
    expect(await eventCount('CARE_PLAN_STATUS_CHANGED')).toBe(3);
  });

  it('records goal achievement once, with an event, and lets a nurse record progress', async () => {
    const patient = await newPatient();
    const plan = (await createPlan(patient.id)).json();
    const goalId = plan.goals[0].id;
    // A nurse (care_plan:progress) can move a goal to achieved.
    const res = await app.inject({ method: 'POST', url: `/care-plans/${plan.id}/goals/${goalId}/progress`, headers: bearer(nurse), payload: { status: 'achieved', progressNote: 'Latest HbA1c 6.8%' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('achieved');
    expect(res.json().achievedAt).toBeTruthy();
    expect(await eventCount('CARE_GOAL_ACHIEVED')).toBe(1);
    // Re-confirming achieved does not double-fire.
    await app.inject({ method: 'POST', url: `/care-plans/${plan.id}/goals/${goalId}/progress`, headers: bearer(nurse), payload: { status: 'achieved' } });
    expect(await eventCount('CARE_GOAL_ACHIEVED')).toBe(1);
  });

  it('lets a nurse progress an activity but not author goals', async () => {
    const patient = await newPatient();
    const plan = (await createPlan(patient.id)).json();
    const actId = plan.activities[0].id;
    const prog = await app.inject({ method: 'POST', url: `/care-plans/${plan.id}/activities/${actId}/progress`, headers: bearer(nurse), payload: { status: 'completed' } });
    expect(prog.statusCode).toBe(200);
    const addGoal = await app.inject({ method: 'POST', url: `/care-plans/${plan.id}/goals`, headers: bearer(nurse), payload: { description: 'New goal' } });
    expect(addGoal.statusCode).toBe(403);
  });

  it('refuses to add goals to a completed plan', async () => {
    const patient = await newPatient();
    const plan = (await createPlan(patient.id)).json();
    await app.inject({ method: 'POST', url: `/care-plans/${plan.id}/status`, headers: bearer(doctor), payload: { status: 'completed' } });
    const res = await app.inject({ method: 'POST', url: `/care-plans/${plan.id}/goals`, headers: bearer(doctor), payload: { description: 'Late goal' } });
    expect(res.statusCode).toBe(409);
  });
});

describe('Care plans — integration, PHI & isolation', () => {
  it('appears on the timeline and Patient 360', async () => {
    const patient = await newPatient();
    await createPlan(patient.id, { title: 'Hypertension control' });
    const tl = await app.inject({ method: 'GET', url: `/patients/${patient.id}/timeline`, headers: bearer(doctor) });
    expect(tl.json().entries.find((e: { kind: string }) => e.kind === 'care_plan').summary).toBe('Hypertension control');
    const v = await app.inject({ method: 'GET', url: `/patients/${patient.id}/360`, headers: bearer(nurse) });
    expect(v.json().carePlans).toHaveLength(1);
  });

  it('keeps plan narrative out of events and audit', async () => {
    const patient = await newPatient();
    await createPlan(patient.id, { title: 'Palliative care for metastatic disease', description: 'end of life planning' });
    const ev = await getPool().query<{ payload: unknown }>(`SELECT payload FROM event WHERE type = 'CARE_PLAN_CREATED'`);
    expect(JSON.stringify(ev.rows[0]!.payload)).not.toMatch(/metastatic|end of life/i);
    const au = await getPool().query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM audit_log WHERE action = 'care_plan.create'`);
    expect(JSON.stringify(au.rows[0]!.metadata)).not.toMatch(/metastatic|end of life/i);
  });

  it('is tenant-isolated and denied to pharma', async () => {
    const patient = await newPatient();
    const plan = (await createPlan(patient.id)).json();
    const other = await makeClinic('Other');
    const otherDoc = await makeUser(other.clinicId, 'od', RoleKey.DOCTOR);
    expect((await app.inject({ method: 'GET', url: `/care-plans/${plan.id}`, headers: bearer(otherDoc) })).statusCode).toBe(404);
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    expect((await app.inject({ method: 'GET', url: `/patients/${patient.id}/care-plans`, headers: bearer(pharma) })).statusCode).toBe(403);
  });
});
