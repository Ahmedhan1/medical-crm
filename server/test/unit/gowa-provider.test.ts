import { describe, it, expect } from 'vitest';
import {
  GowaWhatsAppProvider,
  GowaError,
  maskMsisdn,
  type GowaTransport,
  type GowaRequest,
} from '../../src/modules/messaging/providers/whatsapp/gowa.provider.js';

/**
 * GOWA adapter contract tests. A live WhatsApp pairing cannot run here, so the
 * adapter's HTTP contract is exercised with an injected transport. This validates
 * request shapes and, critically, that failures map to GENERIC codes and never
 * echo the message body, recipient, or credential.
 */
function fake(routes: Record<string, (req: GowaRequest) => { status: number; json: unknown }>): {
  transport: GowaTransport;
  calls: GowaRequest[];
} {
  const calls: GowaRequest[] = [];
  const transport: GowaTransport = async (req) => {
    calls.push(req);
    const handler = routes[`${req.method} ${req.path}`];
    if (!handler) return { status: 404, json: null };
    return handler(req);
  };
  return { transport, calls };
}

describe('maskMsisdn', () => {
  it('keeps only a country hint + last 4', () => {
    expect(maskMsisdn('+201112223334')).toBe('+20******3334');
    expect(maskMsisdn('123')).toBe('***');
  });
});

describe('GOWA send()', () => {
  it('sends via POST /send/message and returns the provider ref', async () => {
    const { transport, calls } = fake({
      'POST /send/message': () => ({ status: 200, json: { code: 'SUCCESS', results: { message_id: 'wamid.ABC' } } }),
    });
    const p = new GowaWhatsAppProvider({ baseUrl: 'http://x', transport });
    const r = await p.send({ channel: 'whatsapp', to: '+201112223334', body: 'hi' });
    expect(r.status).toBe('sent');
    expect(r.providerRef).toBe('wamid.ABC');
    expect(calls[0]).toEqual({ method: 'POST', path: '/send/message', body: { phone: '+201112223334', message: 'hi' } });
  });

  it('maps a 401 to a generic unauthorized code without leaking the body', async () => {
    const { transport } = fake({ 'POST /send/message': () => ({ status: 401, json: { message: 'SECRET_BODY' } }) });
    const p = new GowaWhatsAppProvider({ baseUrl: 'http://x', transport });
    const r = await p.send({ channel: 'whatsapp', to: '+2011', body: 'SECRET_BODY' });
    expect(r.status).toBe('failed');
    expect(r.errorCode).toBe('unauthorized');
    expect(JSON.stringify(r)).not.toContain('SECRET_BODY');
  });

  it('maps a transport throw (timeout/offline) to a retryable unreachable code', async () => {
    const transport: GowaTransport = async () => { throw new Error('boom'); };
    const p = new GowaWhatsAppProvider({ baseUrl: 'http://x', transport });
    const r = await p.send({ channel: 'whatsapp', to: '+2011', body: 'hi' });
    expect(r).toMatchObject({ status: 'failed', errorCode: 'unreachable' });
  });

  it('refuses a non-whatsapp channel', async () => {
    const p = new GowaWhatsAppProvider({ baseUrl: 'http://x', transport: async () => ({ status: 200, json: {} }) });
    const r = await p.send({ channel: 'sms', to: '+2011', body: 'hi' });
    expect(r).toMatchObject({ status: 'failed', errorCode: 'unsupported_channel' });
  });
});

describe('GOWA pairing lifecycle', () => {
  it('beginPairing returns the QR link from the provider', async () => {
    const { transport } = fake({ 'GET /app/login': () => ({ status: 200, json: { results: { qr_link: 'https://qr', qr_duration: 30 } } }) });
    const p = new GowaWhatsAppProvider({ baseUrl: 'http://x', transport });
    const c = await p.beginPairing();
    expect(c.qr).toBe('https://qr');
    expect(c.expiresInSeconds).toBe(30);
  });

  it('beginPairing throws unauthorized on 401', async () => {
    const { transport } = fake({ 'GET /app/login': () => ({ status: 401, json: null }) });
    const p = new GowaWhatsAppProvider({ baseUrl: 'http://x', transport });
    await expect(p.beginPairing()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('deviceStatus reports connected + masked number when a device is paired', async () => {
    const { transport } = fake({ 'GET /app/devices': () => ({ status: 200, json: { results: [{ name: 'clinic', device: '+201112223334' }] } }) });
    const p = new GowaWhatsAppProvider({ baseUrl: 'http://x', transport });
    const s = await p.deviceStatus();
    expect(s.connected).toBe(true);
    expect(s.phoneMasked).toBe('+20******3334');
  });

  it('deviceStatus reports disconnected with no devices', async () => {
    const { transport } = fake({ 'GET /app/devices': () => ({ status: 200, json: { results: [] } }) });
    const p = new GowaWhatsAppProvider({ baseUrl: 'http://x', transport });
    expect((await p.deviceStatus()).connected).toBe(false);
  });

  it('disconnect succeeds on 200 and throws GowaError on failure', async () => {
    const ok = new GowaWhatsAppProvider({ baseUrl: 'http://x', transport: fake({ 'GET /app/logout': () => ({ status: 200, json: {} }) }).transport });
    await expect(ok.disconnect()).resolves.toBeUndefined();
    const bad = new GowaWhatsAppProvider({ baseUrl: 'http://x', transport: fake({ 'GET /app/logout': () => ({ status: 500, json: {} }) }).transport });
    await expect(bad.disconnect()).rejects.toBeInstanceOf(GowaError);
  });
});
