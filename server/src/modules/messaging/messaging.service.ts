import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { audit, auditTx } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import type { Channel, MessageRecord, MessageStatus } from './messaging.types.js';
import { getProviderForChannel } from './providers/registry.js';
import { getActiveTemplate, renderTemplate } from './templates.js';
import { resolvePatientRecipient } from './recipients.js';
import { maskRecipient } from './redact.js';
import { getConsentStatus, isSendAllowed } from './consent.js';
import { getEffectivePolicy, inQuietHours, frequencyBlock } from './policy.js';

/**
 * Core outbound messaging pipeline (blueprint §16, §39).
 *
 * Responsibilities, in order, for every send:
 *   1. Consent gate — patient-linked sends require an explicit opt-in.
 *   2. Idempotency — a provided idempotency_key makes the send at-most-once.
 *   3. Render — deterministically from template + live patient/clinic records
 *      (no PHI persisted; retry re-renders the same way).
 *   4. Transmit — via the channel's registered provider (vendor-neutral).
 *   5. Record — status + masked recipient only, in `message_log`.
 *
 * The provider call happens OUTSIDE any DB transaction (never hold a connection
 * across network I/O); the queued row is committed first, the result recorded
 * after.
 */
const MAX_ATTEMPTS_DEFAULT = 5;

export interface SendRequest {
  clinicId: string;
  channel: Channel;
  /** Patient to message; consent + recipient are resolved from the record. */
  patientId?: string | null;
  templateKey?: string;
  locale?: string;
  /** Extra NON-PHI template variables merged over the pipeline-provided ones. */
  variables?: Record<string, string>;
  /**
   * Direct address + body for ad-hoc sends without a patient/template. These
   * are NOT retryable (nothing safe to persist for re-render).
   */
  to?: string;
  body?: string;
  /** At-most-once guard. Highly recommended for automated sends. */
  idempotencyKey?: string | null;
  actorId?: string | null;
  /**
   * Skip the communication-quality guards (quiet hours + frequency caps).
   * Consent is ALWAYS enforced and cannot be bypassed. Reserved for genuinely
   * urgent/system-critical messages; defaults to false.
   */
  bypassPolicy?: boolean;
}

export interface SendOutcome {
  messageId: string;
  status: MessageStatus;
  providerRef?: string | null;
  suppressedReason?: string | null;
  deduped?: boolean;
}

interface RenderPlan {
  to: string;
  body: string;
  templateKey: string | null;
  locale: string;
}

/** Build the address + rendered body for a send, live and PHI-free-at-rest. */
async function planRender(req: SendRequest): Promise<RenderPlan> {
  const locale = req.locale ?? 'en';

  if (req.patientId && req.templateKey) {
    const recipient = await resolvePatientRecipient(req.clinicId, req.patientId, req.channel);
    if (!recipient) {
      throw new ValidationError('Patient has no reachable address for this channel', {
        reason: 'no_recipient',
      });
    }
    const template = await getActiveTemplate(req.clinicId, req.templateKey, req.channel, locale);
    if (!template) throw new NotFoundError('Message template');
    const body = renderTemplate(template.body, { ...recipient.variables, ...(req.variables ?? {}) });
    return { to: recipient.to, body, templateKey: req.templateKey, locale };
  }

  // Ad-hoc direct send.
  if (req.to && req.body) {
    return { to: req.to, body: req.body, templateKey: req.templateKey ?? null, locale };
  }

  throw new ValidationError(
    'A message needs either (patientId + templateKey) or (to + body)',
  );
}

/**
 * Internal send used by both the route-facing wrapper and the automation
 * engine. Enforces consent + idempotency + logging; performs NO permission
 * check (authorization is asserted by the caller/route).
 */
export async function dispatchMessage(req: SendRequest): Promise<SendOutcome> {
  const provider = getProviderForChannel(req.channel);

  // 1. Consent gate for patient-linked messages.
  if (req.patientId) {
    const status = await getConsentStatus(req.clinicId, req.patientId, req.channel);
    if (!isSendAllowed(status)) {
      return recordSuppressed(req, provider.id, 'no_consent');
    }

    // 1b. Communication-quality guards (quiet hours + frequency caps). Skipped
    //     for ad-hoc direct sends (no patientId). Permissive when no policy set.
    if (!req.bypassPolicy) {
      const policy = await getEffectivePolicy(req.clinicId, req.channel);
      if (inQuietHours(policy, new Date())) {
        return recordSuppressed(req, provider.id, 'quiet_hours');
      }
      const block = await frequencyBlock(policy, req.patientId, req.channel);
      if (block) return recordSuppressed(req, provider.id, block);
    }
  }

  // 3. Render (before we create the queued row, so a bad template fails fast).
  const plan = await planRender(req);
  const recipientMasked = maskRecipient(plan.to, req.channel);

  // 2. Idempotency + queue row.
  const insert = await getPool().query<{ id: string; status: MessageStatus }>(
    `INSERT INTO message_log
       (clinic_id, patient_id, channel, provider, template_key, locale, recipient_masked,
        status, max_attempts, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9)
     ON CONFLICT (clinic_id, idempotency_key) DO NOTHING
     RETURNING id, status`,
    [
      req.clinicId,
      req.patientId ?? null,
      req.channel,
      provider.id,
      plan.templateKey,
      plan.locale,
      recipientMasked,
      MAX_ATTEMPTS_DEFAULT,
      req.idempotencyKey ?? null,
    ],
  );

  if (insert.rows.length === 0) {
    // A row with this idempotency key already exists — do not re-send.
    const existing = await getPool().query<{ id: string; status: MessageStatus; provider_ref: string | null }>(
      `SELECT id, status, provider_ref FROM message_log
        WHERE clinic_id = $1 AND idempotency_key = $2`,
      [req.clinicId, req.idempotencyKey],
    );
    const row = existing.rows[0]!;
    return { messageId: row.id, status: row.status, providerRef: row.provider_ref, deduped: true };
  }

  const messageId = insert.rows[0]!.id;

  // 4 + 5. Transmit and record the outcome.
  return attemptDelivery(messageId, req.clinicId, req.channel, plan, req.actorId ?? null);
}

/** Route-facing send: asserts the messaging permission, then dispatches. */
export async function sendMessage(principal: Principal, req: Omit<SendRequest, 'clinicId' | 'actorId'>): Promise<SendOutcome> {
  requirePermission(principal, Permission.MESSAGING_SEND);
  return dispatchMessage({ ...req, clinicId: principal.clinicId, actorId: principal.userId });
}

async function recordSuppressed(
  req: SendRequest,
  providerId: string,
  reason: string,
): Promise<SendOutcome> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO message_log
       (clinic_id, patient_id, channel, provider, template_key, locale, status, suppressed_reason,
        max_attempts, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,'suppressed',$7,$8,$9)
     ON CONFLICT (clinic_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      req.clinicId,
      req.patientId ?? null,
      req.channel,
      providerId,
      req.templateKey ?? null,
      req.locale ?? 'en',
      reason,
      MAX_ATTEMPTS_DEFAULT,
      req.idempotencyKey ?? null,
    ],
  );
  const id = rows[0]?.id ?? '(deduped)';
  await audit({
    clinicId: req.clinicId,
    actorId: req.actorId ?? null,
    action: 'message.suppressed',
    outcome: 'success',
    targetType: 'patient',
    targetId: req.patientId ?? null,
    metadata: { channel: req.channel, reason },
  });
  return { messageId: id, status: 'suppressed', suppressedReason: reason };
}

/**
 * Transmit one attempt and persist the result. Used for the first send and for
 * retries. On failure it schedules a backoff or dead-letters at max attempts.
 */
export async function attemptDelivery(
  messageId: string,
  clinicId: string,
  channel: Channel,
  plan: Pick<RenderPlan, 'to' | 'body' | 'templateKey'>,
  actorId: string | null,
): Promise<SendOutcome> {
  const provider = getProviderForChannel(channel);
  let result;
  try {
    result = await provider.send({ channel, to: plan.to, body: plan.body, templateKey: plan.templateKey ?? undefined });
  } catch (err) {
    result = {
      status: 'failed' as const,
      errorCode: 'provider_exception',
      errorMessage: err instanceof Error ? err.message : 'unknown provider error',
    };
  }

  return withTransaction(async (client) => {
    const current = await client.query<{ attempts: number; max_attempts: number }>(
      `SELECT attempts, max_attempts FROM message_log WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [messageId, clinicId],
    );
    if (current.rows.length === 0) throw new NotFoundError('Message');
    const attempts = current.rows[0]!.attempts + 1;
    const maxAttempts = current.rows[0]!.max_attempts;

    if (result.status === 'sent') {
      await client.query(
        `UPDATE message_log
            SET status = 'sent', provider_ref = $2, attempts = $3,
                last_error = NULL, next_attempt_at = NULL, updated_at = now()
          WHERE id = $1`,
        [messageId, result.providerRef ?? null, attempts],
      );
      await auditTx(client, {
        clinicId,
        actorId,
        action: 'message.sent',
        outcome: 'success',
        targetType: 'message',
        targetId: messageId,
        metadata: { channel, provider: provider.id },
      });
      return { messageId, status: 'sent' as MessageStatus, providerRef: result.providerRef };
    }

    // Failure: dead-letter at the cap, else schedule a backoff retry.
    const dead = attempts >= maxAttempts;
    const status: MessageStatus = dead ? 'dead' : 'failed';
    const nextAttemptAt = dead ? null : new Date(Date.now() + backoffMs(attempts));
    await client.query(
      `UPDATE message_log
          SET status = $2, attempts = $3, last_error = $4, next_attempt_at = $5, updated_at = now()
        WHERE id = $1`,
      [messageId, status, attempts, result.errorMessage ?? result.errorCode ?? 'send failed', nextAttemptAt],
    );
    await auditTx(client, {
      clinicId,
      actorId,
      action: dead ? 'message.dead_letter' : 'message.failed',
      outcome: 'error',
      targetType: 'message',
      targetId: messageId,
      metadata: { channel, provider: provider.id, attempts, errorCode: result.errorCode ?? null },
    });
    return { messageId, status };
  });
}

/** Exponential backoff capped at one hour. */
export function backoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 2 ** attempts * 30 * 1000);
}

// --- Read side -------------------------------------------------------------

interface MessageLogRow {
  id: string;
  clinic_id: string;
  patient_id: string | null;
  channel: Channel;
  provider: string;
  template_key: string | null;
  recipient_masked: string | null;
  status: MessageStatus;
  suppressed_reason: string | null;
  provider_ref: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mapMessage(r: MessageLogRow): MessageRecord {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    patientId: r.patient_id,
    channel: r.channel,
    provider: r.provider,
    templateKey: r.template_key,
    recipientMasked: r.recipient_masked,
    status: r.status,
    suppressedReason: r.suppressed_reason,
    providerRef: r.provider_ref,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listMessages(principal: Principal, limit = 100): Promise<MessageRecord[]> {
  requirePermission(principal, Permission.MESSAGING_READ);
  const { rows } = await getPool().query<MessageLogRow>(
    `SELECT * FROM message_log WHERE clinic_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [principal.clinicId, Math.min(limit, 500)],
  );
  return rows.map(mapMessage);
}

export async function getMessage(clinicId: string, id: string): Promise<MessageRecord | null> {
  const { rows } = await getPool().query<MessageLogRow>(
    `SELECT * FROM message_log WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapMessage(rows[0]) : null;
}
