import { getPool } from '../../db/pool.js';
import { AppError, ValidationError } from '../../domain/errors.js';
import { audit } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import { getWhatsAppLifecycle } from './providers/whatsapp/registry.js';
import { GowaError } from './providers/whatsapp/gowa.provider.js';

/**
 * WhatsApp connection lifecycle (Agent 3). Operator-facing pairing/status/reconnect
 * for a clinic's WhatsApp device via the provider abstraction (GOWA today). It
 * owns only the connection STATE (whatsapp_connection); message sending stays in
 * the consent-gated dispatch pipeline. Every action is MESSAGING-permission gated,
 * clinic-scoped, and audited. No credential, QR payload, message body or raw
 * recipient is ever persisted, returned, or logged.
 */
export type WaStatus = 'disconnected' | 'pairing' | 'connected' | 'error';

export interface WhatsAppStatus {
  provider: string;
  /** Whether a WhatsApp provider is configured on this box at all. */
  configured: boolean;
  status: WaStatus;
  phoneMasked: string | null;
  lastErrorCode: string | null;
  pairedAt: string | null;
  lastStatusAt: string | null;
}

interface ConnRow {
  provider: string;
  status: WaStatus;
  phone_masked: string | null;
  last_error_code: string | null;
  paired_at: string | null;
  last_status_at: string | null;
}

/** Service unavailable — the WhatsApp bridge could not be reached (502). */
class WhatsAppUnavailableError extends AppError {
  constructor(code: string) {
    super(502, 'whatsapp_unavailable', 'The WhatsApp service is not reachable', { code });
  }
}

function notConfigured(): never {
  throw new ValidationError('WhatsApp is not configured on this MEDCORE box', { reason: 'not_configured' });
}

function mapGowaError(err: unknown): never {
  if (err instanceof GowaError) {
    if (err.code === 'unauthorized') throw new WhatsAppUnavailableError('unauthorized');
    if (err.code === 'no_qr') throw new WhatsAppUnavailableError('no_qr');
    throw new WhatsAppUnavailableError('unreachable');
  }
  throw new WhatsAppUnavailableError('unreachable');
}

async function readConn(clinicId: string): Promise<ConnRow | null> {
  const { rows } = await getPool().query<ConnRow>(
    `SELECT provider, status, phone_masked, last_error_code, paired_at, last_status_at
       FROM whatsapp_connection WHERE clinic_id = $1`,
    [clinicId],
  );
  return rows[0] ?? null;
}

async function upsertConn(
  clinicId: string,
  status: WaStatus,
  fields: { phoneMasked?: string | null; lastErrorCode?: string | null; paired?: boolean; actorId?: string | null },
): Promise<void> {
  await getPool().query(
    `INSERT INTO whatsapp_connection
       (clinic_id, provider, status, phone_masked, last_error_code, paired_at, last_status_at, updated_by, updated_at)
     VALUES ($1,'gowa',$2,$3,$4, CASE WHEN $5 THEN now() ELSE NULL END, now(), $6, now())
     ON CONFLICT (clinic_id) DO UPDATE SET
       status = EXCLUDED.status,
       phone_masked = COALESCE(EXCLUDED.phone_masked, whatsapp_connection.phone_masked),
       last_error_code = EXCLUDED.last_error_code,
       paired_at = CASE WHEN $5 THEN now() ELSE whatsapp_connection.paired_at END,
       last_status_at = now(),
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [clinicId, status, fields.phoneMasked ?? null, fields.lastErrorCode ?? null, fields.paired ?? false, fields.actorId ?? null],
  );
}

function toStatus(clinicId: string, row: ConnRow | null): WhatsAppStatus {
  const configured = getWhatsAppLifecycle() !== null;
  return {
    provider: row?.provider ?? 'gowa',
    configured,
    status: row?.status ?? 'disconnected',
    phoneMasked: row?.phone_masked ?? null,
    lastErrorCode: row?.last_error_code ?? null,
    pairedAt: row?.paired_at ?? null,
    lastStatusAt: row?.last_status_at ?? null,
  };
}

/** Current stored status (read side). No provider call, so it never blocks. */
export async function getWhatsAppStatus(principal: Principal): Promise<WhatsAppStatus> {
  requirePermission(principal, Permission.MESSAGING_READ);
  return toStatus(principal.clinicId, await readConn(principal.clinicId));
}

/** Begin pairing: fetch a fresh QR from the provider and mark the clinic 'pairing'. */
export async function beginWhatsAppPairing(
  principal: Principal,
): Promise<{ qr: string; expiresInSeconds?: number; status: WhatsAppStatus }> {
  requirePermission(principal, Permission.MESSAGING_MANAGE);
  const lc = getWhatsAppLifecycle();
  if (!lc) notConfigured();
  let challenge;
  try {
    challenge = await lc.beginPairing();
  } catch (err) {
    await upsertConn(principal.clinicId, 'error', { lastErrorCode: err instanceof GowaError ? err.code : 'unreachable', actorId: principal.userId });
    mapGowaError(err);
  }
  await upsertConn(principal.clinicId, 'pairing', { lastErrorCode: null, actorId: principal.userId });
  await audit({
    clinicId: principal.clinicId, actorId: principal.userId, action: 'whatsapp.pairing_started',
    outcome: 'success', targetType: 'whatsapp_connection', targetId: principal.clinicId, metadata: { provider: 'gowa' },
  });
  // QR is returned to the operator transiently; it is never persisted or logged.
  return { qr: challenge.qr, ...(challenge.expiresInSeconds !== undefined ? { expiresInSeconds: challenge.expiresInSeconds } : {}), status: toStatus(principal.clinicId, await readConn(principal.clinicId)) };
}

/** Poll the live device status from the provider and reconcile the stored state. */
export async function refreshWhatsAppStatus(principal: Principal): Promise<WhatsAppStatus> {
  requirePermission(principal, Permission.MESSAGING_MANAGE);
  const lc = getWhatsAppLifecycle();
  if (!lc) notConfigured();
  let device;
  try {
    device = await lc.deviceStatus();
  } catch (err) {
    await upsertConn(principal.clinicId, 'error', { lastErrorCode: err instanceof GowaError ? err.code : 'unreachable', actorId: principal.userId });
    mapGowaError(err);
  }
  const status: WaStatus = device.connected ? 'connected' : 'disconnected';
  await upsertConn(principal.clinicId, status, {
    phoneMasked: device.phoneMasked ?? null, lastErrorCode: null, paired: device.connected, actorId: principal.userId,
  });
  await audit({
    clinicId: principal.clinicId, actorId: principal.userId, action: 'whatsapp.status_refreshed',
    outcome: 'success', targetType: 'whatsapp_connection', targetId: principal.clinicId, metadata: { status },
  });
  return toStatus(principal.clinicId, await readConn(principal.clinicId));
}

/** Disconnect (log out) the clinic's WhatsApp device. */
export async function disconnectWhatsApp(principal: Principal): Promise<WhatsAppStatus> {
  requirePermission(principal, Permission.MESSAGING_MANAGE);
  const lc = getWhatsAppLifecycle();
  if (!lc) notConfigured();
  try {
    await lc.disconnect();
  } catch (err) {
    mapGowaError(err);
  }
  await upsertConn(principal.clinicId, 'disconnected', { lastErrorCode: null, actorId: principal.userId });
  await audit({
    clinicId: principal.clinicId, actorId: principal.userId, action: 'whatsapp.disconnected',
    outcome: 'success', targetType: 'whatsapp_connection', targetId: principal.clinicId, metadata: { provider: 'gowa' },
  });
  return toStatus(principal.clinicId, await readConn(principal.clinicId));
}
