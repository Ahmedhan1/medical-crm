import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { classifyDueState } from '../../src/modules/clinical/followup-detection.service.js';

let app: FastifyInstance;
let clinicId: string;
let reception: TestUser;
let nurse: TestUser;
let doctor: TestUser;

const bearer = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

/** A date offset (in days) from today, as YYYY-MM-DD. */
function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

/** Register, check in, take intake so the encounter can host a follow-up. */
async function encounterFor(name: string): Promise<string> {
  const patient = (
    await app.inject({ method: 'POST', url: '/patients', headers: bearer(reception), payload: { fullName: name, sex: 'male' } })
  ).json();
  const encounter = (
    await app.inject({ method: 'POST', url: '/encounters/check-in', headers: bearer(reception), payload: { patientId: patient.id } })
  ).json();
  return encounter.id;
}

async function scheduleFollowUp(name: string, dueOn: string, reason = 'Review'): Promise<string> {
  const encounterId = await encounterFor(name);
  const res = await app.inject({
    method: 'POST',
    url: `/encounters/${encounterId}/follow-ups`,
    headers: bearer(doctor),
    payload: { dueOn, reason },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function sweep(user: TestUser = doctor) {
  return app.inject({ method: 'POST', url: '/follow-ups/detection/run', headers: bearer(user) });
}

async function eventCount(type: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM event WHERE type = $1`, [type]);
  return Number(rows[0]!.n);
}

describe('Phase 11 — classifyDueState (pure, deterministic)', () => {
  it('classifies overdue, due, approaching and upcoming', () => {
    expect(classifyDueState('2026-01-01', '2026-01-10', 7)).toBe('overdue');
    expect(classifyDueState('2026-01-10', '2026-01-10', 7)).toBe('due');
    expect(classifyDueState('2026-01-14', '2026-01-10', 7)).toBe('approaching');
    expect(classifyDueState('2026-01-17', '2026-01-10', 7)).toBe('approaching');
    expect(classifyDueState('2026-01-18', '2026-01-10', 7)).toBe('upcoming');
  });

  it('is stable under repeated evaluation', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(classifyDueState('2026-02-01', '2026-02-05', 3)).toBe('overdue');
    }
  });
});

describe('Phase 11 — detection worklist', () => {
  it('classifies scheduled follow-ups by due state', async () => {
    await scheduleFollowUp('Overdue Patient', dayOffset(-3));
    await scheduleFollowUp('Due Patient', dayOffset(0));
    await scheduleFollowUp('Approaching Patient', dayOffset(3));
    await scheduleFollowUp('Upcoming Patient', dayOffset(60));

    const res = await app.inject({ method: 'GET', url: '/follow-ups/detection', headers: bearer(reception) });
    expect(res.statusCode).toBe(200);
    const byName = Object.fromEntries(
      res.json().entries.map((e: { patientName: string; dueState: string }) => [e.patientName, e.dueState]),
    );
    expect(byName['Overdue Patient']).toBe('overdue');
    expect(byName['Due Patient']).toBe('due');
    expect(byName['Approaching Patient']).toBe('approaching');
    expect(byName['Upcoming Patient']).toBe('upcoming');
  });

  it('filters by state and reports signed days-until-due', async () => {
    await scheduleFollowUp('Overdue A', dayOffset(-5));
    await scheduleFollowUp('Future A', dayOffset(20));
    const res = await app.inject({ method: 'GET', url: '/follow-ups/detection?state=overdue', headers: bearer(doctor) });
    expect(res.json().entries).toHaveLength(1);
    expect(res.json().entries[0].patientName).toBe('Overdue A');
    expect(res.json().entries[0].daysUntilDue).toBe(-5);
  });

  it('does not classify completed or cancelled follow-ups', async () => {
    const id = await scheduleFollowUp('Closed Patient', dayOffset(-2));
    await app.inject({
      method: 'POST',
      url: `/follow-ups/${id}/close`,
      headers: bearer(reception),
      payload: { status: 'completed' },
    });
    const res = await app.inject({ method: 'GET', url: '/follow-ups/detection', headers: bearer(doctor) });
    expect(res.json().entries).toHaveLength(0);
  });
});

describe('Phase 11 — detection sweep (event emission)', () => {
  it('emits FOLLOW_UP_OVERDUE for a past-due follow-up, once', async () => {
    await scheduleFollowUp('Overdue Sweep', dayOffset(-4));
    const first = await sweep();
    expect(first.statusCode).toBe(200);
    expect(first.json().overdueEmitted).toBe(1);
    expect(await eventCount('FOLLOW_UP_OVERDUE')).toBe(1);

    // Idempotent: a second sweep emits nothing.
    const second = await sweep();
    expect(second.json().overdueEmitted).toBe(0);
    expect(second.json().dueEmitted).toBe(0);
    expect(await eventCount('FOLLOW_UP_OVERDUE')).toBe(1);
  });

  it('emits FOLLOW_UP_DUE for a follow-up due today, once, and not OVERDUE', async () => {
    await scheduleFollowUp('Due Sweep', dayOffset(0));
    const res = await sweep();
    expect(res.json().dueEmitted).toBe(1);
    expect(res.json().overdueEmitted).toBe(0);
    expect(await eventCount('FOLLOW_UP_DUE')).toBe(1);
    expect(await eventCount('FOLLOW_UP_OVERDUE')).toBe(0);
  });

  it('does not fire DUE for a follow-up first seen already overdue', async () => {
    await scheduleFollowUp('Missed Patient', dayOffset(-10));
    await sweep();
    // Only OVERDUE fired; DUE was suppressed since it was never due-today when seen.
    expect(await eventCount('FOLLOW_UP_OVERDUE')).toBe(1);
    expect(await eventCount('FOLLOW_UP_DUE')).toBe(0);
  });

  it('does not sweep a future follow-up', async () => {
    await scheduleFollowUp('Future Sweep', dayOffset(30));
    const res = await sweep();
    expect(res.json().scanned).toBe(0);
    expect(await eventCount('FOLLOW_UP_DUE')).toBe(0);
  });

  it('carries no clinical reason into the event payload', async () => {
    await scheduleFollowUp('PHI Patient', dayOffset(-1), 'Recheck suspicious mole');
    await sweep();
    const { rows } = await getPool().query<{ payload: unknown }>(`SELECT payload FROM event WHERE type = 'FOLLOW_UP_OVERDUE'`);
    expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/mole/i);
    expect(JSON.stringify(rows[0]!.payload)).toContain('dueOn');
  });

  it('stops signalling once a follow-up is completed', async () => {
    const id = await scheduleFollowUp('Resolve Patient', dayOffset(-2));
    await sweep();
    expect(await eventCount('FOLLOW_UP_OVERDUE')).toBe(1);
    // Completing it is a clinical action, not a detection side effect.
    await app.inject({
      method: 'POST',
      url: `/follow-ups/${id}/close`,
      headers: bearer(reception),
      payload: { status: 'completed' },
    });
    const res = await sweep();
    expect(res.json().scanned).toBe(0);
  });
});

describe('Phase 11 — authority, isolation, automation boundary', () => {
  it('requires followup:detect to run the sweep; reception and nurse cannot', async () => {
    await scheduleFollowUp('Guarded Patient', dayOffset(-1));
    expect((await sweep(reception)).statusCode).toBe(403);
    expect((await sweep(nurse)).statusCode).toBe(403);
    expect((await sweep(doctor)).statusCode).toBe(200);
  });

  it('lets reception and nurse read the detection worklist', async () => {
    await scheduleFollowUp('Readable Patient', dayOffset(-1));
    expect((await app.inject({ method: 'GET', url: '/follow-ups/detection', headers: bearer(reception) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/follow-ups/detection', headers: bearer(nurse) })).statusCode).toBe(200);
  });

  it('is tenant-isolated: a sweep never touches another clinic follow-ups', async () => {
    await scheduleFollowUp('Our Overdue', dayOffset(-3));
    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'odoc', RoleKey.DOCTOR);

    // The other clinic's sweep sees nothing of ours.
    const otherSweep = await app.inject({ method: 'POST', url: '/follow-ups/detection/run', headers: bearer(otherDoctor) });
    expect(otherSweep.json().scanned).toBe(0);
    expect(await eventCount('FOLLOW_UP_OVERDUE')).toBe(0);

    // Our sweep processes only ours.
    await sweep();
    expect(await eventCount('FOLLOW_UP_OVERDUE')).toBe(1);
  });

  it('denies detection to a pharma rep', async () => {
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    expect((await app.inject({ method: 'GET', url: '/follow-ups/detection', headers: bearer(pharma) })).statusCode).toBe(403);
    expect((await sweep(pharma)).statusCode).toBe(403);
  });

  it('the sweep only reads and stamps markers — it modifies no clinical fact', async () => {
    const id = await scheduleFollowUp('Untouched Patient', dayOffset(-1), 'Original reason');
    await sweep();
    const { rows } = await getPool().query<{ status: string; reason: string; due_on: string | Date; overdue_event_at: string | null }>(
      `SELECT status, reason, due_on, overdue_event_at FROM follow_up WHERE id = $1`,
      [id],
    );
    // Status, reason and due date are unchanged; only the marker was stamped.
    expect(rows[0]!.status).toBe('scheduled');
    expect(rows[0]!.reason).toBe('Original reason');
    expect(rows[0]!.overdue_event_at).not.toBeNull();
  });
});
