import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { classifyReferralSla } from '../../src/modules/clinical/referrals.service.js';

let app: FastifyInstance;
let clinicId: string;
let reception: TestUser;
let nurse: TestUser;
let doctor: TestUser;

const bearer = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
function dayOffset(days: number): string { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
async function eventCount(type: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM event WHERE type = $1`, [type]);
  return Number(rows[0]!.n);
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
afterAll(async () => { if (app) await app.close(); });

async function newPatient(name = 'Hardening Patient') {
  return (await app.inject({ method: 'POST', url: '/patients', headers: bearer(reception), payload: { fullName: name, sex: 'male' } })).json();
}
async function orderedReferral(patientId: string, dueDate?: string) {
  const r = (await app.inject({ method: 'POST', url: '/referrals', headers: bearer(doctor), payload: { patientId, direction: 'external', receivingSpecialty: 'Cardiology', reason: 'Review', order: true, ...(dueDate ? { dueDate } : {}) } })).json();
  return r.id;
}

describe('Referral hardening — SLA classification (pure)', () => {
  it('classifies within_sla, approaching and breached', () => {
    expect(classifyReferralSla('2026-01-20', 'sent', '2026-01-10', 7)).toBe('within_sla');
    expect(classifyReferralSla('2026-01-14', 'sent', '2026-01-10', 7)).toBe('approaching');
    expect(classifyReferralSla('2026-01-05', 'sent', '2026-01-10', 7)).toBe('breached');
    expect(classifyReferralSla(null, 'sent', '2026-01-10', 7)).toBe('no_due_date');
    // A completed referral is not an open SLA concern.
    expect(classifyReferralSla('2026-01-05', 'completed', '2026-01-10', 7)).toBe('within_sla');
  });
});

describe('Referral hardening — SLA detection & sweep', () => {
  it('surfaces a breached referral in the SLA worklist', async () => {
    const patient = await newPatient();
    await orderedReferral(patient.id, dayOffset(-3));
    await orderedReferral(patient.id, dayOffset(30));
    const res = await app.inject({ method: 'GET', url: '/referrals/sla?state=breached', headers: bearer(reception) });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(1);
    expect(res.json().entries[0].slaState).toBe('breached');
  });

  it('emits REFERRAL_SLA_BREACHED once per referral (idempotent) and never mutates status', async () => {
    const patient = await newPatient();
    const id = await orderedReferral(patient.id, dayOffset(-2));
    const first = await app.inject({ method: 'POST', url: '/referrals/sla/sweep', headers: bearer(reception) });
    expect(first.json().breachedEmitted).toBe(1);
    expect(await eventCount('REFERRAL_SLA_BREACHED')).toBe(1);
    // Idempotent.
    const second = await app.inject({ method: 'POST', url: '/referrals/sla/sweep', headers: bearer(reception) });
    expect(second.json().breachedEmitted).toBe(0);
    expect(await eventCount('REFERRAL_SLA_BREACHED')).toBe(1);
    // Status is untouched — detection does not expire the referral.
    const ref = await app.inject({ method: 'GET', url: `/referrals/${id}`, headers: bearer(doctor) });
    expect(ref.json().referral.status).toBe('ordered');
  });

  it('carries no PHI in the SLA event and is tenant-isolated', async () => {
    const patient = await newPatient();
    await orderedReferral(patient.id, dayOffset(-1));
    await app.inject({ method: 'POST', url: '/referrals/sla/sweep', headers: bearer(reception) });
    const { rows } = await getPool().query<{ payload: unknown }>(`SELECT payload FROM event WHERE type = 'REFERRAL_SLA_BREACHED'`);
    expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/cardiology|review/i);

    const other = await makeClinic('Other');
    const otherRec = await makeUser(other.clinicId, 'orec', RoleKey.RECEPTION);
    const sweep = await app.inject({ method: 'POST', url: '/referrals/sla/sweep', headers: bearer(otherRec) });
    expect(sweep.json().breachedEmitted).toBe(0);
  });

  it('denies the SLA worklist to pharma', async () => {
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    expect((await app.inject({ method: 'GET', url: '/referrals/sla', headers: bearer(pharma) })).statusCode).toBe(403);
  });
});

describe('Follow-up completion / resolution semantics', () => {
  async function scheduledFollowUp(name: string): Promise<{ id: string; encounterId: string }> {
    const patient = await newPatient(name);
    const encounter = (await app.inject({ method: 'POST', url: '/encounters/check-in', headers: bearer(reception), payload: { patientId: patient.id } })).json();
    const fu = (await app.inject({ method: 'POST', url: `/encounters/${encounter.id}/follow-ups`, headers: bearer(doctor), payload: { dueOn: dayOffset(7), reason: 'Review labs' } })).json();
    return { id: fu.id, encounterId: encounter.id };
  }

  it('emits FOLLOW_UP_COMPLETED on completion (plus the legacy closed event)', async () => {
    const { id, encounterId } = await scheduledFollowUp('Completed FU');
    const res = await app.inject({ method: 'POST', url: `/follow-ups/${id}/close`, headers: bearer(reception), payload: { status: 'completed', encounterId } });
    expect(res.statusCode).toBe(200);
    expect(await eventCount('FOLLOW_UP_COMPLETED')).toBe(1);
    expect(await eventCount('FOLLOW_UP_CLOSED')).toBe(1);
    expect(await eventCount('FOLLOW_UP_CANCELLED')).toBe(0);
  });

  it('emits FOLLOW_UP_CANCELLED when resolved as no-longer-required', async () => {
    const { id } = await scheduledFollowUp('Cancelled FU');
    await app.inject({ method: 'POST', url: `/follow-ups/${id}/close`, headers: bearer(reception), payload: { status: 'cancelled' } });
    expect(await eventCount('FOLLOW_UP_CANCELLED')).toBe(1);
    expect(await eventCount('FOLLOW_UP_COMPLETED')).toBe(0);
  });

  it('carries no clinical reason in the completion event', async () => {
    const { id, encounterId } = await scheduledFollowUp('PHI FU');
    await app.inject({ method: 'POST', url: `/follow-ups/${id}/close`, headers: bearer(reception), payload: { status: 'completed', encounterId } });
    const { rows } = await getPool().query<{ payload: unknown }>(`SELECT payload FROM event WHERE type = 'FOLLOW_UP_COMPLETED'`);
    expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/review labs/i);
  });
});
