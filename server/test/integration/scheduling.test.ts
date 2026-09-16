import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { defaultMessagingProvider, resetToDefault } from '../../src/modules/messaging/providers/registry.js';
import { scheduleAction } from '../../src/modules/automation/scheduler.js';
import { runDueActions } from '../../src/modules/automation/scheduler.runner.js';
import { getScheduled } from '../../src/modules/automation/scheduled.repo.js';

let app: FastifyInstance;
let clinicId: string;
let admin: { token: string };
let reception: { token: string };

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function newPatient(name: string, phone = '+201112223334'): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/patients', headers: bearer(reception.token),
    payload: { fullName: name, sex: 'male', phone },
  });
  return res.json().id;
}
async function optIn(patientId: string): Promise<void> {
  await app.inject({
    method: 'POST', url: '/consent', headers: bearer(reception.token),
    payload: { patientId, channel: 'whatsapp', status: 'opted_in' },
  });
}
async function makeTemplate(): Promise<void> {
  await app.inject({
    method: 'POST', url: '/message-templates', headers: bearer(admin.token),
    payload: { key: 'appointment_reminder', channel: 'whatsapp', body: 'Hi {{firstName}}, reminder from {{clinicName}}.' },
  });
}

beforeEach(async () => {
  await resetDb();
  resetToDefault();
  ({ clinicId } = await makeClinic());
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  app = buildServer();
  await app.ready();
  await makeTemplate();
});
afterEach(() => resetToDefault());
afterAll(async () => { if (app) await app.close(); });

describe('time engine: end-to-end event → schedule_action → run', () => {
  it('a check-in rule schedules a reminder that is delivered once when due', async () => {
    await app.inject({
      method: 'POST', url: '/automations', headers: bearer(admin.token),
      payload: {
        name: 'reminder-after-checkin',
        eventType: 'PATIENT_CHECKED_IN',
        actions: [{
          type: 'schedule_action',
          params: { delaySeconds: 0, action: { type: 'send_message', params: { channel: 'whatsapp', templateKey: 'appointment_reminder' } } },
        }],
      },
    });
    const patientId = await newPatient('Reminder Patient');
    await optIn(patientId);
    await app.inject({ method: 'POST', url: '/encounters/check-in', headers: bearer(reception.token), payload: { patientId } });

    // Process the event → a scheduled_action is enqueued (nothing sent yet).
    await app.inject({ method: 'POST', url: '/automations/process', headers: bearer(admin.token) });
    expect(defaultMessagingProvider().outbox).toHaveLength(0);
    const listed = await app.inject({ method: 'GET', url: '/scheduled-actions?status=pending', headers: bearer(admin.token) });
    expect(listed.json().actions).toHaveLength(1);

    // Run the time engine → the reminder is delivered exactly once.
    const run = await app.inject({ method: 'POST', url: '/automations/run-scheduled', headers: bearer(admin.token) });
    expect(run.json().succeeded).toBe(1);
    expect(defaultMessagingProvider().outbox).toHaveLength(1);

    // Running again does not re-send (action is done; send is idempotent).
    const run2 = await app.inject({ method: 'POST', url: '/automations/run-scheduled', headers: bearer(admin.token) });
    expect(run2.json().executed).toBe(0);
    expect(defaultMessagingProvider().outbox).toHaveLength(1);
  });

  it('does not run an action before it is due', async () => {
    const patientId = await newPatient('Future Patient');
    await optIn(patientId);
    await scheduleAction({
      clinicId, actionType: 'send_message',
      params: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
      scheduledFor: new Date(Date.now() + 3_600_000), dedupeKey: `future:${patientId}`,
    });
    const summary = await runDueActions();
    expect(summary.executed).toBe(0);
    expect(defaultMessagingProvider().outbox).toHaveLength(0);
  });
});

describe('time engine: idempotency, expiry, retry, cancel', () => {
  it('scheduling is idempotent on the dedupe key', async () => {
    const patientId = await newPatient('Idem Patient');
    const a = await scheduleAction({ clinicId, actionType: 'noop', params: {}, scheduledFor: new Date(), dedupeKey: `k:${patientId}` });
    const b = await scheduleAction({ clinicId, actionType: 'noop', params: {}, scheduledFor: new Date(), dedupeKey: `k:${patientId}` });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.action.id).toBe(a.action.id);
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM scheduled_action WHERE clinic_id = $1`, [clinicId]);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('drops a scheduled action that has already expired (not sent late)', async () => {
    const patientId = await newPatient('Stale Patient');
    await optIn(patientId);
    await scheduleAction({
      clinicId, actionType: 'send_message',
      params: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
      scheduledFor: new Date(Date.now() - 7_200_000),  // 2h ago
      expiresAt: new Date(Date.now() - 3_600_000),      // expired 1h ago
      dedupeKey: `stale:${patientId}`,
    });
    const summary = await runDueActions();
    expect(summary.expired).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(defaultMessagingProvider().outbox).toHaveLength(0);
  });

  it('dead-letters a scheduled action whose action itself errors (at the cap)', async () => {
    const patientId = await newPatient('DeadLetter Patient');
    await optIn(patientId);
    // A missing template makes the send action throw (config error, not a
    // transient delivery failure) → the scheduler retries/dead-letters it.
    const { action } = await scheduleAction({
      clinicId, actionType: 'send_message',
      params: { channel: 'whatsapp', patientId, templateKey: 'no_such_template' },
      scheduledFor: new Date(), dedupeKey: `dead:${patientId}`, maxAttempts: 1,
    });
    const summary = await runDueActions();
    expect(summary.failed).toBe(1);
    const after = await getScheduled(clinicId, action.id);
    expect(after!.status).toBe('failed'); // maxAttempts=1 → dead-letter immediately
    expect(after!.lastError).toBeTruthy();
  });

  it('separates layers: a delivery failure completes the action but fails the message (message-level retry owns it)', async () => {
    const patientId = await newPatient('TwoLayer Patient');
    await optIn(patientId);
    defaultMessagingProvider().failOnce(1); // provider fails the send
    const { action } = await scheduleAction({
      clinicId, actionType: 'send_message',
      params: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
      scheduledFor: new Date(), dedupeKey: `twolayer:${patientId}`,
    });
    const summary = await runDueActions();
    // The scheduled action successfully DISPATCHED (its job) → done.
    expect(summary.succeeded).toBe(1);
    const after = await getScheduled(clinicId, action.id);
    expect(after!.status).toBe('done');
    // The message itself is 'failed' in message_log, retried by messaging (not the scheduler).
    const msg = await getPool().query<{ status: string }>(
      `SELECT status FROM message_log WHERE clinic_id = $1 AND patient_id = $2`, [clinicId, patientId]);
    expect(msg.rows[0]!.status).toBe('failed');
  });

  it('cancels a pending scheduled action so it never runs', async () => {
    const patientId = await newPatient('Cancel Patient');
    await optIn(patientId);
    const { action } = await scheduleAction({
      clinicId, actionType: 'send_message',
      params: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
      scheduledFor: new Date(), dedupeKey: `cancel:${patientId}`,
    });
    const cancel = await app.inject({ method: 'POST', url: `/scheduled-actions/${action.id}/cancel`, headers: bearer(admin.token) });
    expect(cancel.json().status).toBe('cancelled');
    const summary = await runDueActions();
    expect(summary.executed).toBe(0);
    expect(defaultMessagingProvider().outbox).toHaveLength(0);
  });
});

describe('time engine: quiet-hours deferral', () => {
  it('pushes a scheduled send past the clinic quiet window (not_before set, not due)', async () => {
    // Configure quiet hours to cover the current clinic-local hour, so "now" is quiet.
    const nowHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hour: 'numeric', hour12: false }).format(new Date())) % 24;
    await app.inject({
      method: 'POST', url: '/messaging-policy', headers: bearer(admin.token),
      payload: { channel: 'whatsapp', quietHoursEnabled: true, quietStartHour: nowHour, quietEndHour: (nowHour + 1) % 24 },
    });
    const patientId = await newPatient('Quiet Patient');
    await optIn(patientId);

    const { action } = await scheduleAction({
      clinicId, actionType: 'send_message',
      params: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
      scheduledFor: new Date(), dedupeKey: `quiet:${patientId}`, quietHoursChannel: 'whatsapp',
    });
    const stored = await getScheduled(clinicId, action.id);
    expect(stored!.notBefore).not.toBeNull();
    expect(new Date(stored!.notBefore!).getTime()).toBeGreaterThan(Date.now());

    // Not due yet because not_before is in the future.
    const summary = await runDueActions();
    expect(summary.executed).toBe(0);
    expect(defaultMessagingProvider().outbox).toHaveLength(0);
  });
});
