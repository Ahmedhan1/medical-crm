import type {
  Channel,
  MessagingProvider,
  OutboundMessage,
  ProviderSendResult,
} from '../../messaging.types.js';

/**
 * GOWA (go-whatsapp-web-multidevice) WhatsApp adapter.
 *
 * This is the ONE place GOWA-specific behaviour lives — the rest of MEDCORE
 * depends only on `MessagingProvider` (for sending) and `WhatsAppLifecycle` (for
 * pairing/status), so GOWA is never hardcoded into the messaging architecture
 * and can be swapped for another WhatsApp vendor by writing another adapter.
 *
 * GOWA API ASSUMPTIONS (isolated here on purpose; if GOWA changes, only this
 * file changes). Based on go-whatsapp-web-multidevice's HTTP API:
 *   - POST /send/message      { phone, message }  → 200 { code, results:{ message_id } }
 *   - GET  /app/login                              → 200 { results:{ qr_link, qr_duration } }
 *   - GET  /app/devices        (paired devices)    → 200 { results:[{ name, device }] }
 *   - GET  /app/logout                             → 200 on success
 * Auth is HTTP Basic. All calls go through an injectable `transport` so the
 * adapter contract is unit-tested without a live GOWA/WhatsApp pairing.
 *
 * PHI/secrets: this adapter NEVER logs the message body, the recipient, the QR
 * payload, or the basic-auth credential. Errors returned to the pipeline carry
 * only a generic code, never a raw provider message that might echo content.
 */
export interface GowaResponse {
  status: number;
  json: unknown;
}

export interface GowaRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

export type GowaTransport = (req: GowaRequest) => Promise<GowaResponse>;

export interface GowaConfig {
  baseUrl: string;
  /** "user:pass" for HTTP Basic. Secret — never logged or persisted. */
  basicAuth?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a fetch-based transport. */
  transport?: GowaTransport;
}

export interface DeviceStatus {
  connected: boolean;
  /** Masked device number when paired (never the full MSISDN). */
  phoneMasked?: string;
}

export interface PairingChallenge {
  /** QR content/link the operator scans in WhatsApp. Transient, never persisted. */
  qr: string;
  /** Seconds the QR is valid, when the provider reports it. */
  expiresInSeconds?: number;
}

/** A provider that additionally supports the WhatsApp device pairing lifecycle. */
export interface WhatsAppLifecycle {
  beginPairing(): Promise<PairingChallenge>;
  deviceStatus(): Promise<DeviceStatus>;
  disconnect(): Promise<void>;
}

/** Mask an MSISDN to a country hint + last 4 (contact PHI is never stored raw). */
export function maskMsisdn(raw: string): string {
  const s = String(raw).trim();
  if (s.length <= 4) return '*'.repeat(s.length);
  const keep = s.startsWith('+') ? 3 : 0;
  return `${s.slice(0, keep)}${'*'.repeat(Math.max(0, s.length - keep - 4))}${s.slice(-4)}`;
}

function pick(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === 'object' && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Build the default fetch transport (Basic auth + timeout, no body logging). */
export function fetchTransport(cfg: { baseUrl: string; basicAuth?: string; timeoutMs: number }): GowaTransport {
  return async ({ method, path, body }) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body) headers['content-type'] = 'application/json';
      if (cfg.basicAuth) headers.authorization = `Basic ${Buffer.from(cfg.basicAuth).toString('base64')}`;
      const res = await fetch(`${cfg.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      let json: unknown = null;
      const text = await res.text();
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  };
}

export class GowaWhatsAppProvider implements MessagingProvider, WhatsAppLifecycle {
  readonly id = 'gowa';
  readonly channels: readonly Channel[] = ['whatsapp'];
  private readonly transport: GowaTransport;

  constructor(cfg: GowaConfig) {
    this.transport = cfg.transport ?? fetchTransport({
      baseUrl: cfg.baseUrl,
      basicAuth: cfg.basicAuth,
      timeoutMs: cfg.timeoutMs ?? 10_000,
    });
  }

  async send(message: OutboundMessage): Promise<ProviderSendResult> {
    if (message.channel !== 'whatsapp') {
      return { status: 'failed', errorCode: 'unsupported_channel', errorMessage: 'gowa handles whatsapp only' };
    }
    let res: GowaResponse;
    try {
      res = await this.transport({ method: 'POST', path: '/send/message', body: { phone: message.to, message: message.body } });
    } catch {
      // Network/timeout — retryable; generic code only (no body, no recipient).
      return { status: 'failed', errorCode: 'unreachable', errorMessage: 'gowa unreachable' };
    }
    if (res.status >= 200 && res.status < 300) {
      const providerRef = String(pick(res.json, 'results', 'message_id') ?? pick(res.json, 'message_id') ?? '') || undefined;
      return { status: 'sent', ...(providerRef ? { providerRef } : {}) };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'failed', errorCode: 'unauthorized', errorMessage: 'gowa auth rejected' };
    }
    // Not connected / bad request etc. — a generic code, never the raw message.
    return { status: 'failed', errorCode: `gowa_http_${res.status}`, errorMessage: 'gowa send rejected' };
  }

  async beginPairing(): Promise<PairingChallenge> {
    const res = await this.transport({ method: 'GET', path: '/app/login' });
    if (res.status < 200 || res.status >= 300) {
      throw new GowaError(res.status === 401 || res.status === 403 ? 'unauthorized' : 'unreachable');
    }
    const qr = pick(res.json, 'results', 'qr_link') ?? pick(res.json, 'results', 'qr_code') ?? pick(res.json, 'qr_link');
    if (typeof qr !== 'string' || !qr) throw new GowaError('no_qr');
    const exp = pick(res.json, 'results', 'qr_duration');
    return { qr, ...(typeof exp === 'number' ? { expiresInSeconds: exp } : {}) };
  }

  async deviceStatus(): Promise<DeviceStatus> {
    let res: GowaResponse;
    try {
      res = await this.transport({ method: 'GET', path: '/app/devices' });
    } catch {
      throw new GowaError('unreachable');
    }
    if (res.status === 401 || res.status === 403) throw new GowaError('unauthorized');
    if (res.status < 200 || res.status >= 300) throw new GowaError('unreachable');
    const devices = pick(res.json, 'results');
    if (Array.isArray(devices) && devices.length > 0) {
      const first = devices[0] as Record<string, unknown>;
      const num = typeof first.device === 'string' ? first.device : typeof first.name === 'string' ? first.name : undefined;
      return { connected: true, ...(num ? { phoneMasked: maskMsisdn(num) } : {}) };
    }
    return { connected: false };
  }

  async disconnect(): Promise<void> {
    let res: GowaResponse;
    try {
      res = await this.transport({ method: 'GET', path: '/app/logout' });
    } catch {
      throw new GowaError('unreachable');
    }
    if (res.status === 401 || res.status === 403) throw new GowaError('unauthorized');
    if (res.status < 200 || res.status >= 300) throw new GowaError('unreachable');
  }
}

/** Generic, non-PHI error from the GOWA lifecycle (code only, never a body). */
export class GowaError extends Error {
  constructor(public readonly code: 'unreachable' | 'unauthorized' | 'no_qr' | 'not_paired') {
    super(code);
    this.name = 'GowaError';
  }
}
