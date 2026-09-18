import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { resetToDefault } from '../../src/modules/messaging/providers/registry.js';
import { setWhatsAppLifecycle, resetWhatsApp } from '../../src/modules/messaging/providers/whatsapp/registry.js';
import type { Channel, MessagingProvider, OutboundMessage, ProviderSendResult } from '../../src/modules/messaging/messaging.types.js';
import type { WhatsAppLifecycle, DeviceStatus, PairingChallenge } from '../../src/modules/messaging/providers/whatsapp/gowa.provider.js';

/**
 * WhatsApp connection lifecycle tests. A live pairing cannot run here, so a fake
 * GOWA (implementing the same MessagingProvider + WhatsAppLifecycle contract the
 * real adapter does) drives pair/status/disconnect deterministically. This proves
 * the lifecycle, authorization, tenant isolation, and that no QR is persisted.
 */
class FakeGowa implements MessagingProvider, WhatsAppLifecycle {
  readonly id = 'gowa';
  readonly channels: readonly Channel[] = ['whatsapp'];
  connected = false;
  sent: OutboundMessage[] = [];
  async send(m: OutboundMessage): Promise<ProviderSendResult> {
    this.sent.push(m);
    return { status: 'sent', providerRef: 'fake-1' };
  }
  async beginPairing(): Promise<PairingChallenge> {
    return { qr: 'QR_SECRET_PAYLOAD_XYZ', expiresInSeconds: 30 };
  }
  async deviceStatus(): Promise<DeviceStatus> {
    return this.connected ? { connected: true, phoneMasked: '+20******3334' } : { connected: false };
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

let app: FastifyInstance;
let clinicId: string;
let admin: { token: string };
let reception: { token: string };
let gowa: FakeGowa;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  await resetDb();
  resetToDefault();
  resetWhatsApp();
  gowa = new FakeGowa();
  ({ clinicId } = await makeClinic());
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  app = buildServer();
  await app.ready();
});
afterEach(() => { resetToDefault(); resetWhatsApp(); });
afterAll(async () => { if (app) await app.close(); });

describe('WhatsApp not configured', () => {
  it('status reports not configured; pairing is rejected', async () => {
    const status = await app.inject({ method: 'GET', url: '/whatsapp/status', headers: bearer(admin.token) });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ configured: false, status: 'disconnected' });

    const pair = await app.inject({ method: 'POST', url: '/whatsapp/pair', headers: bearer(admin.token) });
    expect(pair.statusCode).toBe(400);
    expect(pair.json().error.details.reason).toBe('not_configured');
  });
});

describe('WhatsApp pairing lifecycle (fake GOWA)', () => {
  beforeEach(() => setWhatsAppLifecycle(gowa));

  it('pairs, reports connected on reconnect, and disconnects — never persisting the QR', async () => {
    const pair = await app.inject({ method: 'POST', url: '/whatsapp/pair', headers: bearer(admin.token) });
    expect(pair.statusCode).toBe(200);
    expect(pair.json().qr).toBe('QR_SECRET_PAYLOAD_XYZ');
    expect(pair.json().status.status).toBe('pairing');

    // The QR is transient — it must never land in the DB.
    const dump = await getPool().query<{ blob: string }>(
      `SELECT coalesce(string_agg(row_to_json(whatsapp_connection)::text,' '),'') AS blob FROM whatsapp_connection WHERE clinic_id=$1`,
      [clinicId],
    );
    expect(dump.rows[0]!.blob).not.toContain('QR_SECRET_PAYLOAD_XYZ');

    // Simulate the operator scanning: device becomes connected.
    gowa.connected = true;
    const recon = await app.inject({ method: 'POST', url: '/whatsapp/reconnect', headers: bearer(admin.token) });
    expect(recon.json().status).toBe('connected');
    expect(recon.json().phoneMasked).toBe('+20******3334');

    const disc = await app.inject({ method: 'POST', url: '/whatsapp/disconnect', headers: bearer(admin.token) });
    expect(disc.json().status).toBe('disconnected');
    expect(gowa.connected).toBe(false);
  });

  it('reception (no MESSAGING_MANAGE) can read status but cannot pair', async () => {
    expect((await app.inject({ method: 'GET', url: '/whatsapp/status', headers: bearer(reception.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/whatsapp/pair', headers: bearer(reception.token) })).statusCode).toBe(403);
  });

  it('is tenant-isolated: another clinic never sees this clinic connection', async () => {
    gowa.connected = true;
    await app.inject({ method: 'POST', url: '/whatsapp/reconnect', headers: bearer(admin.token) }); // clinic A connected
    const clinicB = await makeClinic('Clinic B');
    const adminB = await makeUser(clinicB.clinicId, 'adminB', RoleKey.ADMIN);
    const statusB = await app.inject({ method: 'GET', url: '/whatsapp/status', headers: bearer(adminB.token) });
    expect(statusB.json().status).toBe('disconnected'); // B has its own (empty) connection
  });

  it('an unauthenticated request is rejected', async () => {
    expect((await app.inject({ method: 'GET', url: '/whatsapp/status' })).statusCode).toBe(401);
  });

  it('consent is still enforced at delivery: an opted-out patient never reaches GOWA', async () => {
    await app.inject({ method: 'POST', url: '/message-templates', headers: bearer(admin.token), payload: { key: 'appointment_reminder', channel: 'whatsapp', body: 'Hi {{firstName}}.' } });
    const patient = await app.inject({ method: 'POST', url: '/patients', headers: bearer(reception.token), payload: { fullName: 'Opted Out', sex: 'male', phone: '+201112223334' } });
    const patientId = patient.json().id;
    await app.inject({ method: 'POST', url: '/consent', headers: bearer(reception.token), payload: { patientId, channel: 'whatsapp', status: 'opted_out' } });

    const send = await app.inject({ method: 'POST', url: '/messages', headers: bearer(reception.token), payload: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' } });
    expect(send.json().status).toBe('suppressed');
    expect(gowa.sent).toHaveLength(0); // the GOWA provider was never invoked
  });
});
