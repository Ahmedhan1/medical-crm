import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { defaultMessagingProvider, resetToDefault } from '../../src/modules/messaging/providers/registry.js';

let app: FastifyInstance;
let clinicId: string;
let admin: { token: string };
let reception: { token: string };

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function newPatient(name: string, phone = '+201112223334'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/patients',
    headers: bearer(reception.token),
    payload: { fullName: name, sex: 'male', phone },
  });
  return res.json().id;
}

async function checkIn(patientId: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/encounters/check-in',
    headers: bearer(reception.token),
    payload: { patientId },
  });
}

async function createRule(body: Record<string, unknown>, token = admin.token) {
  return await app.inject({ method: 'POST', url: '/automations', headers: bearer(token), payload: body });
}

async function process(): Promise<{ processed: number; triggered: number }> {
  const res = await app.inject({ method: 'POST', url: '/automations/process', headers: bearer(admin.token) });
  return res.json();
}

beforeEach(async () => {
  await resetDb();
  resetToDefault();
  ({ clinicId } = await makeClinic());
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  app = buildServer();
  await app.ready();
});

afterEach(() => resetToDefault());
afterAll(async () => {
  if (app) await app.close();
});

describe('automation: rule administration + authz', () => {
  it('only an admin (AUTOMATION_MANAGE) can create rules', async () => {
    const body = { name: 'r', eventType: 'PATIENT_CHECKED_IN', actions: [{ type: 'noop' }] };
    expect((await createRule(body, reception.token)).statusCode).toBe(403);
    expect((await createRule(body)).statusCode).toBe(201);
  });

  it('rejects a rule with an unknown action type up front', async () => {
    const res = await createRule({
      name: 'bad',
      eventType: 'PATIENT_CHECKED_IN',
      actions: [{ type: 'launch_missiles' }],
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('automation: engine execution', () => {
  it('fires a matching rule exactly once per event (idempotent re-processing)', async () => {
    await createRule({ name: 'noop-on-checkin', eventType: 'PATIENT_CHECKED_IN', actions: [{ type: 'noop' }] });
    const patientId = await newPatient('Idempotent');
    await checkIn(patientId);

    const first = await process();
    expect(first.triggered).toBe(1);
    // Re-processing must not create a second run for the same (rule, event).
    const second = await process();
    expect(second.triggered).toBe(0);

    const runs = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automation_run WHERE clinic_id = $1 AND status = 'succeeded'`,
      [clinicId],
    );
    expect(Number(runs.rows[0]!.n)).toBe(1);
  });

  it('skips a rule whose conditions do not match', async () => {
    await createRule({
      name: 'only-high-priority',
      eventType: 'PATIENT_CHECKED_IN',
      conditions: [{ field: 'payload.nonexistent', op: 'exists' }],
      actions: [{ type: 'noop' }],
    });
    await checkIn(await newPatient('LowPri'));
    await process();

    const run = await getPool().query<{ status: string; matched: boolean }>(
      `SELECT status, matched FROM automation_run WHERE clinic_id = $1`,
      [clinicId],
    );
    expect(run.rows[0]!.status).toBe('skipped');
    expect(run.rows[0]!.matched).toBe(false);
  });

  it('a disabled rule does not run', async () => {
    await createRule({
      name: 'disabled',
      eventType: 'PATIENT_CHECKED_IN',
      isEnabled: false,
      actions: [{ type: 'noop' }],
    });
    await checkIn(await newPatient('Nobody'));
    const summary = await process();
    expect(summary.triggered).toBe(0);
    const runs = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automation_run WHERE clinic_id = $1`,
      [clinicId],
    );
    expect(Number(runs.rows[0]!.n)).toBe(0);
  });

  it('exposes run history for a rule', async () => {
    const created = await createRule({ name: 'hist', eventType: 'PATIENT_CHECKED_IN', actions: [{ type: 'noop' }] });
    const ruleId = created.json().id;
    await checkIn(await newPatient('History'));
    await process();

    const runs = await app.inject({ method: 'GET', url: `/automations/${ruleId}/runs`, headers: bearer(admin.token) });
    expect(runs.statusCode).toBe(200);
    expect(runs.json().runs).toHaveLength(1);
    expect(runs.json().runs[0].status).toBe('succeeded');
  });
});

describe('automation: WhatsApp workflow end-to-end (A003)', () => {
  async function makeReminderTemplate(): Promise<void> {
    await app.inject({
      method: 'POST',
      url: '/message-templates',
      headers: bearer(admin.token),
      payload: {
        key: 'appointment_reminder',
        channel: 'whatsapp',
        body: 'Hi {{firstName}}, reminder from {{clinicName}}.',
      },
    });
  }

  it('sends a consent-gated WhatsApp message when a check-in event fires the rule', async () => {
    await makeReminderTemplate();
    await createRule({
      name: 'reminder-on-checkin',
      eventType: 'PATIENT_CHECKED_IN',
      actions: [{ type: 'send_message', params: { channel: 'whatsapp', templateKey: 'appointment_reminder' } }],
    });

    const patientId = await newPatient('Consented Auto');
    await app.inject({
      method: 'POST',
      url: '/consent',
      headers: bearer(reception.token),
      payload: { patientId, channel: 'whatsapp', status: 'opted_in' },
    });
    await checkIn(patientId);
    await process();

    expect(defaultMessagingProvider().outbox).toHaveLength(1);
    expect(defaultMessagingProvider().outbox[0]!.body).toContain('reminder from');

    // Re-processing does not re-send (action-level idempotency).
    await process();
    expect(defaultMessagingProvider().outbox).toHaveLength(1);
  });

  it('honors opt-out: the rule runs but the message is suppressed', async () => {
    await makeReminderTemplate();
    await createRule({
      name: 'reminder-optout',
      eventType: 'PATIENT_CHECKED_IN',
      actions: [{ type: 'send_message', params: { channel: 'whatsapp', templateKey: 'appointment_reminder' } }],
    });
    const patientId = await newPatient('OptedOut Auto');
    // No opt-in recorded (defaults to unknown → blocked).
    await checkIn(patientId);
    await process();

    expect(defaultMessagingProvider().outbox).toHaveLength(0);
    const msg = await getPool().query<{ status: string; suppressed_reason: string }>(
      `SELECT status, suppressed_reason FROM message_log WHERE clinic_id = $1`,
      [clinicId],
    );
    expect(msg.rows[0]!.status).toBe('suppressed');
    expect(msg.rows[0]!.suppressed_reason).toBe('no_consent');
  });
});
