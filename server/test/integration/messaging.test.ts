import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { defaultMessagingProvider, resetToDefault } from '../../src/modules/messaging/providers/registry.js';

let app: FastifyInstance;
let clinicId: string;
let reception: { token: string };
let admin: { token: string };

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function newPatient(token: string, name: string, phone = '+201112223334'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/patients',
    headers: bearer(token),
    payload: { fullName: name, sex: 'female', phone },
  });
  return res.json().id;
}

async function makeTemplate(token: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/message-templates',
    headers: bearer(token),
    payload: {
      key: 'appointment_reminder',
      channel: 'whatsapp',
      body: 'Hi {{firstName}}, this is a reminder from {{clinicName}} (MRN {{mrn}}).',
    },
  });
}

beforeEach(async () => {
  await resetDb();
  resetToDefault();
  ({ clinicId } = await makeClinic());
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  app = buildServer();
  await app.ready();
  await makeTemplate(admin.token);
});

afterEach(() => {
  resetToDefault();
});

afterAll(async () => {
  if (app) await app.close();
});

async function setConsent(patientId: string, status: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/consent',
    headers: bearer(reception.token),
    payload: { patientId, channel: 'whatsapp', status },
  });
}

describe('messaging: consent gate', () => {
  it('suppresses a send when the patient has NOT opted in (opt-in required)', async () => {
    const patientId = await newPatient(reception.token, 'No Consent');
    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: bearer(reception.token),
      payload: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('suppressed');
    expect(res.json().suppressedReason).toBe('no_consent');
    // Nothing reached the provider.
    expect(defaultMessagingProvider().outbox).toHaveLength(0);
  });

  it('sends when the patient has opted in, and honors a later opt-out', async () => {
    const patientId = await newPatient(reception.token, 'Consented');
    await setConsent(patientId, 'opted_in');

    const sent = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: bearer(reception.token),
      payload: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
    });
    expect(sent.json().status).toBe('sent');
    expect(defaultMessagingProvider().outbox).toHaveLength(1);

    // Opt out — the next send is suppressed.
    await setConsent(patientId, 'opted_out');
    const blocked = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: bearer(reception.token),
      payload: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
    });
    expect(blocked.json().status).toBe('suppressed');
    expect(defaultMessagingProvider().outbox).toHaveLength(1); // unchanged
  });
});

describe('messaging: no PHI in the operational log', () => {
  it('stores a masked recipient and no rendered body/address', async () => {
    const patientId = await newPatient(reception.token, 'Masked Patient', '+201234567890');
    await setConsent(patientId, 'opted_in');
    await app.inject({
      method: 'POST',
      url: '/messages',
      headers: bearer(reception.token),
      payload: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
    });

    // The vendor (provider) received the rendered body; our DB must not have it.
    const outbox = defaultMessagingProvider().outbox;
    expect(outbox[0]!.body).toContain('Masked Patient'.split(' ')[0]); // firstName rendered vendor-side

    const cols = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'message_log'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).not.toContain('body');
    expect(names).not.toContain('recipient'); // only recipient_masked exists

    const row = await getPool().query<{ recipient_masked: string }>(
      `SELECT recipient_masked FROM message_log WHERE clinic_id = $1`,
      [clinicId],
    );
    expect(row.rows[0]!.recipient_masked).toMatch(/\*/);
    expect(row.rows[0]!.recipient_masked).not.toContain('234567');
  });
});

describe('messaging: idempotency', () => {
  it('does not double-send for the same idempotency key', async () => {
    const patientId = await newPatient(reception.token, 'Idem Patient');
    await setConsent(patientId, 'opted_in');
    const payload = {
      channel: 'whatsapp',
      patientId,
      templateKey: 'appointment_reminder',
      idempotencyKey: 'reminder-2026-01-01',
    };
    const first = await app.inject({ method: 'POST', url: '/messages', headers: bearer(reception.token), payload });
    const second = await app.inject({ method: 'POST', url: '/messages', headers: bearer(reception.token), payload });

    expect(first.json().status).toBe('sent');
    expect(second.json().deduped).toBe(true);
    expect(defaultMessagingProvider().outbox).toHaveLength(1);

    const count = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_log WHERE clinic_id = $1`,
      [clinicId],
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
  });
});

describe('messaging: retry + dead-letter + delivery status', () => {
  it('retries a failed message and can then be marked delivered', async () => {
    const patientId = await newPatient(reception.token, 'Retry Patient');
    await setConsent(patientId, 'opted_in');

    // Force the provider to fail the first attempt.
    defaultMessagingProvider().failOnce(1);
    const send = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: bearer(reception.token),
      payload: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
    });
    expect(send.json().status).toBe('failed');
    const messageId = send.json().messageId;

    // Retry (needs MESSAGING_MANAGE → admin). Re-renders from stable records.
    const retry = await app.inject({
      method: 'POST',
      url: `/messages/${messageId}/retry`,
      headers: bearer(admin.token),
    });
    expect(retry.json().status).toBe('sent');

    // Provider delivery-status callback marks it delivered (idempotently).
    const providerRef = defaultMessagingProvider().outbox[0]!.providerRef;
    const delivered = await app.inject({
      method: 'POST',
      url: '/messages/delivery-status',
      headers: bearer(admin.token),
      payload: { provider: 'local-noop', providerRef, delivered: true },
    });
    expect(delivered.json().status).toBe('delivered');
  });
});

describe('messaging: authorization boundaries', () => {
  it('a pharma rep cannot send patient messages', async () => {
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    const patientId = await newPatient(reception.token, 'Protected');
    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: bearer(pharma.token),
      payload: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a reception user in clinic B cannot set consent for clinic A patient', async () => {
    const patientId = await newPatient(reception.token, 'Clinic A Patient');
    const clinicB = await makeClinic('Clinic B');
    const recB = await makeUser(clinicB.clinicId, 'recB', RoleKey.RECEPTION);
    const res = await app.inject({
      method: 'POST',
      url: '/consent',
      headers: bearer(recB.token),
      payload: { patientId, channel: 'whatsapp', status: 'opted_in' },
    });
    expect(res.statusCode).toBe(404); // not visible across tenants
  });
});
