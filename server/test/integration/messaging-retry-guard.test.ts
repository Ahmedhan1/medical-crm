import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { defaultMessagingProvider, resetToDefault } from '../../src/modules/messaging/providers/registry.js';

/**
 * GAP-AUDIT regression: message RETRY must re-check consent + communication policy
 * AT DELIVERY TIME, not only at the original dispatch. A patient who opts out (or
 * a message that would breach quiet hours / a frequency cap) after the first
 * failure must never be delivered on retry.
 */
let app: FastifyInstance;
let clinicId: string;
let reception: { token: string };
let admin: { token: string };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function newPatient(name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/patients', headers: bearer(reception.token), payload: { fullName: name, sex: 'male', phone: '+201112223334' } });
  return res.json().id;
}
async function setConsent(patientId: string, status: string) {
  return app.inject({ method: 'POST', url: '/consent', headers: bearer(reception.token), payload: { patientId, channel: 'whatsapp', status } });
}
async function setPolicy(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/messaging-policy', headers: bearer(admin.token), payload: body });
}
async function sendFailing(patientId: string): Promise<string> {
  defaultMessagingProvider().failOnce(1); // make the first attempt fail
  const res = await app.inject({ method: 'POST', url: '/messages', headers: bearer(reception.token), payload: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' } });
  expect(res.json().status).toBe('failed');
  return res.json().messageId;
}

beforeEach(async () => {
  await resetDb();
  resetToDefault();
  ({ clinicId } = await makeClinic());
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  app = buildServer();
  await app.ready();
  await app.inject({ method: 'POST', url: '/message-templates', headers: bearer(admin.token), payload: { key: 'appointment_reminder', channel: 'whatsapp', body: 'Hi {{firstName}}.' } });
});
afterEach(() => resetToDefault());
afterAll(async () => { if (app) await app.close(); });

describe('retry re-checks consent at delivery time', () => {
  it('SUPPRESSES a retry after the patient opts out (opt-out honored immediately)', async () => {
    const patientId = await newPatient('OptOut Retry');
    await setConsent(patientId, 'opted_in');
    const messageId = await sendFailing(patientId);
    const sentCount = defaultMessagingProvider().outbox.length; // 0 (the send failed)

    // Patient opts out AFTER the failure, BEFORE the retry.
    await setConsent(patientId, 'opted_out');
    const retry = await app.inject({ method: 'POST', url: `/messages/${messageId}/retry`, headers: bearer(admin.token) });
    expect(retry.json().status).toBe('suppressed');

    const row = await getPool().query<{ status: string; suppressed_reason: string }>(`SELECT status, suppressed_reason FROM message_log WHERE id=$1`, [messageId]);
    expect(row.rows[0]!.status).toBe('suppressed');
    expect(row.rows[0]!.suppressed_reason).toBe('no_consent');
    // Nothing new reached the provider.
    expect(defaultMessagingProvider().outbox.length).toBe(sentCount);
  });

  it('still delivers a retry when consent remains valid', async () => {
    const patientId = await newPatient('Valid Retry');
    await setConsent(patientId, 'opted_in');
    const messageId = await sendFailing(patientId);
    const retry = await app.inject({ method: 'POST', url: `/messages/${messageId}/retry`, headers: bearer(admin.token) });
    expect(retry.json().status).toBe('sent');
    expect(defaultMessagingProvider().outbox.length).toBe(1);
  });
});

describe('retry re-checks communication policy at delivery time', () => {
  it('DEFERS a retry that falls in quiet hours instead of sending', async () => {
    const patientId = await newPatient('Quiet Retry');
    await setConsent(patientId, 'opted_in');
    const messageId = await sendFailing(patientId);

    // Configure quiet hours covering "now" (clinic timezone).
    const nowHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hour: 'numeric', hour12: false }).format(new Date())) % 24;
    await setPolicy({ channel: 'whatsapp', quietHoursEnabled: true, quietStartHour: nowHour, quietEndHour: (nowHour + 1) % 24 });

    const retry = await app.inject({ method: 'POST', url: `/messages/${messageId}/retry`, headers: bearer(admin.token) });
    expect(retry.json().status).toBe('failed'); // deferred, not sent
    const row = await getPool().query<{ status: string; next_attempt_at: string | null }>(`SELECT status, next_attempt_at FROM message_log WHERE id=$1`, [messageId]);
    expect(row.rows[0]!.status).toBe('failed');
    expect(row.rows[0]!.next_attempt_at).not.toBeNull();
    expect(new Date(row.rows[0]!.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
    expect(defaultMessagingProvider().outbox.length).toBe(0);
  });

  it('SUPPRESSES a retry that would breach the daily frequency cap', async () => {
    const patientId = await newPatient('Cap Retry');
    await setConsent(patientId, 'opted_in');
    // 1) A message fails first (no policy yet → it attempts and fails).
    const messageId = await sendFailing(patientId);
    // 2) Now set a cap of 1 and consume it with one successful send (the failed
    //    message does not count toward the cap).
    await setPolicy({ channel: 'whatsapp', dailyCap: 1 });
    const consume = await app.inject({ method: 'POST', url: '/messages', headers: bearer(reception.token), payload: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder', idempotencyKey: 'cap-consume' } });
    expect(consume.json().status).toBe('sent');
    // 3) Retrying the failed message would now exceed the cap → suppressed.
    const retry = await app.inject({ method: 'POST', url: `/messages/${messageId}/retry`, headers: bearer(admin.token) });
    expect(retry.json().status).toBe('suppressed');
    const row = await getPool().query<{ suppressed_reason: string }>(`SELECT suppressed_reason FROM message_log WHERE id=$1`, [messageId]);
    expect(row.rows[0]!.suppressed_reason).toBe('daily_cap');
  });
});
