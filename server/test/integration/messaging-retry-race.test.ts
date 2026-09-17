import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { defaultMessagingProvider, resetToDefault } from '../../src/modules/messaging/providers/registry.js';

/**
 * GAP-CLOSURE regression: a message RETRY must be claimed atomically so two
 * concurrent retriers (an admin retry racing the worker sweep, or two workers)
 * can NEVER both transmit the same message. "Retry must never create duplicate
 * patient communication." Before the atomic claim, both retriers read the same
 * 'failed' row and both called the provider — the patient got the message twice.
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
async function sendFailing(patientId: string): Promise<string> {
  defaultMessagingProvider().failOnce(1); // first attempt fails → status 'failed'
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

describe('retry is claimed atomically (no duplicate send)', () => {
  it('two concurrent single retries transmit the message exactly once', async () => {
    const patientId = await newPatient('Race One');
    await app.inject({ method: 'POST', url: '/consent', headers: bearer(reception.token), payload: { patientId, channel: 'whatsapp', status: 'opted_in' } });
    const messageId = await sendFailing(patientId);
    expect(defaultMessagingProvider().outbox.length).toBe(0);

    // Fire two retries of the SAME message at once.
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/messages/${messageId}/retry`, headers: bearer(admin.token) }),
      app.inject({ method: 'POST', url: `/messages/${messageId}/retry`, headers: bearer(admin.token) }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();

    // Exactly one send reached the provider — never two.
    expect(defaultMessagingProvider().outbox.length).toBe(1);
    // One retry succeeded (200); the other lost the claim and got a conflict (409).
    expect(statuses).toEqual([200, 409]);

    const row = await getPool().query<{ status: string; attempts: number }>(`SELECT status, attempts FROM message_log WHERE id=$1`, [messageId]);
    expect(row.rows[0]!.status).toBe('sent');
    expect(row.rows[0]!.attempts).toBe(2); // one failed + one successful attempt, not three
  });

  it('a single retry racing the batch sweep still transmits exactly once', async () => {
    const patientId = await newPatient('Race Two');
    await app.inject({ method: 'POST', url: '/consent', headers: bearer(reception.token), payload: { patientId, channel: 'whatsapp', status: 'opted_in' } });
    const messageId = await sendFailing(patientId);

    const [single, batch] = await Promise.all([
      app.inject({ method: 'POST', url: `/messages/${messageId}/retry`, headers: bearer(admin.token) }),
      app.inject({ method: 'POST', url: '/messages/retry-due', headers: bearer(admin.token) }),
    ]);
    expect(defaultMessagingProvider().outbox.length).toBe(1);

    // The batch either claimed it (1 result) or the single did (batch skipped it).
    const singleSent = single.statusCode === 200 && single.json().status === 'sent';
    const batchResults = batch.json().results ?? [];
    const batchSent = batchResults.some((r: { messageId: string; status: string }) => r.messageId === messageId && r.status === 'sent');
    expect(singleSent || batchSent).toBe(true);
    expect(singleSent && batchSent).toBe(false); // never both

    const row = await getPool().query<{ status: string }>(`SELECT status FROM message_log WHERE id=$1`, [messageId]);
    expect(row.rows[0]!.status).toBe('sent');
  });
});
