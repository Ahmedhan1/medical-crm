import { getPool } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { audit } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import type { Channel, MessageStatus } from './messaging.types.js';
import { attemptDelivery, backoffMs } from './messaging.service.js';
import { getActiveTemplate, renderTemplate } from './templates.js';
import { resolvePatientRecipient } from './recipients.js';
import { getConsentStatus, isSendAllowed } from './consent.js';
import { getEffectivePolicy, inQuietHours, nextAllowedTime, frequencyBlock } from './policy.js';

/**
 * Retry + delivery-status handling (blueprint §16 reliability).
 *
 * Retry re-renders the message from stable records (patient + template), so no
 * PHI ever has to be stored to make a message replayable. Only patient-linked,
 * templated messages are retryable; ad-hoc direct sends are one-shot.
 */

interface RetryableRow {
  id: string;
  clinic_id: string;
  channel: Channel;
  patient_id: string | null;
  template_key: string | null;
  locale: string;
  status: MessageStatus;
  attempts: number;
  max_attempts: number;
}

async function rebuildPlan(row: RetryableRow): Promise<{ to: string; body: string; templateKey: string | null }> {
  if (!row.patient_id || !row.template_key) {
    throw new ValidationError('Message is not retryable (no patient/template to re-render from)', {
      messageId: row.id,
    });
  }
  const recipient = await resolvePatientRecipient(row.clinic_id, row.patient_id, row.channel);
  if (!recipient) throw new ValidationError('Patient no longer has a reachable address', { messageId: row.id });
  const template = await getActiveTemplate(row.clinic_id, row.template_key, row.channel, row.locale);
  if (!template) throw new NotFoundError('Message template');
  const body = renderTemplate(template.body, recipient.variables);
  return { to: recipient.to, body, templateKey: row.template_key };
}

/**
 * Re-evaluate consent + communication policy AT DELIVERY TIME for a retry, so a
 * patient who opted out (or a message that would now breach quiet hours or a
 * frequency cap) after the original failure is never delivered on retry.
 *   - consent revoked / not opted-in → SUPPRESS (opt-out honored immediately)
 *   - quiet hours right now          → DEFER to the next allowed time
 *   - over a frequency cap           → SUPPRESS with the cap reason
 */
type RetryGate = { kind: 'allow' } | { kind: 'suppress'; reason: string } | { kind: 'defer'; until: Date };

async function retryGate(row: RetryableRow): Promise<RetryGate> {
  if (!row.patient_id) return { kind: 'allow' }; // non-patient messages aren't retryable anyway
  const consent = await getConsentStatus(row.clinic_id, row.patient_id, row.channel);
  if (!isSendAllowed(consent)) return { kind: 'suppress', reason: 'no_consent' };
  const policy = await getEffectivePolicy(row.clinic_id, row.channel);
  const now = new Date();
  if (inQuietHours(policy, now)) return { kind: 'defer', until: nextAllowedTime(policy, now) };
  const fblock = await frequencyBlock(policy, row.patient_id, row.channel);
  if (fblock) return { kind: 'suppress', reason: fblock };
  return { kind: 'allow' };
}

async function suppressRetry(row: RetryableRow, reason: string, actorId: string | null): Promise<{ messageId: string; status: MessageStatus }> {
  await getPool().query(
    `UPDATE message_log SET status='suppressed', suppressed_reason=$2, next_attempt_at=NULL, updated_at=now() WHERE id=$1`,
    [row.id, reason],
  );
  await audit({
    clinicId: row.clinic_id, actorId, action: 'message.retry_suppressed', outcome: 'success',
    targetType: 'message', targetId: row.id, metadata: { channel: row.channel, reason },
  });
  return { messageId: row.id, status: 'suppressed' };
}

async function deferRetry(row: RetryableRow, until: Date, actorId: string | null): Promise<{ messageId: string; status: MessageStatus }> {
  await getPool().query(
    `UPDATE message_log SET next_attempt_at=$2, updated_at=now() WHERE id=$1`,
    [row.id, until],
  );
  await audit({
    clinicId: row.clinic_id, actorId, action: 'message.retry_deferred', outcome: 'success',
    targetType: 'message', targetId: row.id, metadata: { channel: row.channel, reason: 'quiet_hours' },
  });
  return { messageId: row.id, status: 'failed' };
}

async function loadRetryable(clinicId: string, id: string): Promise<RetryableRow | null> {
  const { rows } = await getPool().query<RetryableRow>(
    `SELECT id, clinic_id, channel, patient_id, template_key, locale, status, attempts, max_attempts
       FROM message_log WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ?? null;
}

/** Retry a single failed message. Authorized + audited. */
export async function retryMessage(principal: Principal, id: string): Promise<{ messageId: string; status: MessageStatus }> {
  requirePermission(principal, Permission.MESSAGING_MANAGE);
  const row = await loadRetryable(principal.clinicId, id);
  if (!row) throw new NotFoundError('Message');
  if (row.status !== 'failed') {
    throw new ConflictError(`Only failed messages can be retried (status is '${row.status}')`);
  }
  if (row.attempts >= row.max_attempts) {
    throw new ConflictError('Message has reached its maximum attempts (dead-lettered)');
  }
  // Re-check consent + policy at delivery time (opt-out honored immediately).
  const gate = await retryGate(row);
  if (gate.kind === 'suppress') return suppressRetry(row, gate.reason, principal.userId);
  if (gate.kind === 'defer') return deferRetry(row, gate.until, principal.userId);
  const plan = await rebuildPlan(row);
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'message.retry',
    outcome: 'success',
    targetType: 'message',
    targetId: id,
  });
  return attemptDelivery(id, principal.clinicId, row.channel, plan, principal.userId);
}

/**
 * Batch recovery: re-attempt all due failed messages for the clinic. Intended
 * to be called by a scheduler/worker. Returns a per-message summary.
 */
export async function retryDueMessages(
  principal: Principal,
  limit = 100,
): Promise<{ attempted: number; results: Array<{ messageId: string; status: MessageStatus }> }> {
  requirePermission(principal, Permission.MESSAGING_MANAGE);
  const { rows } = await getPool().query<RetryableRow>(
    `SELECT id, clinic_id, channel, patient_id, template_key, locale, status, attempts, max_attempts
       FROM message_log
      WHERE clinic_id = $1 AND status = 'failed'
        AND attempts < max_attempts
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY next_attempt_at NULLS FIRST
      LIMIT $2`,
    [principal.clinicId, Math.min(limit, 500)],
  );

  const results: Array<{ messageId: string; status: MessageStatus }> = [];
  for (const row of rows) {
    try {
      // Re-check consent + policy at delivery time for every retry.
      const gate = await retryGate(row);
      if (gate.kind === 'suppress') {
        results.push(await suppressRetry(row, gate.reason, principal.userId));
        continue;
      }
      if (gate.kind === 'defer') {
        results.push(await deferRetry(row, gate.until, principal.userId));
        continue;
      }
      const plan = await rebuildPlan(row);
      results.push(await attemptDelivery(row.id, principal.clinicId, row.channel, plan, principal.userId));
    } catch {
      // A message that can't be re-rendered stays failed; skip it in the batch.
      results.push({ messageId: row.id, status: row.status });
    }
  }
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'message.retry_batch',
    outcome: 'success',
    metadata: { attempted: results.length },
  });
  return { attempted: results.length, results };
}

/**
 * Apply a provider delivery-status callback (webhook). Maps the provider's
 * terminal state onto the message. Idempotent: applying the same status twice
 * is a no-op. Correlates by (provider, providerRef) so a spoofed id for another
 * clinic cannot cross tenant scope.
 */
export async function applyDeliveryStatus(
  principal: Principal,
  input: { provider: string; providerRef: string; delivered: boolean; errorCode?: string },
): Promise<{ messageId: string; status: MessageStatus }> {
  requirePermission(principal, Permission.MESSAGING_MANAGE);

  const target: MessageStatus = input.delivered ? 'delivered' : 'failed';
  const { rows } = await getPool().query<{ id: string; status: MessageStatus }>(
    `UPDATE message_log
        SET status = $4,
            last_error = CASE WHEN $4 = 'failed' THEN $5 ELSE last_error END,
            updated_at = now()
      WHERE clinic_id = $1 AND provider = $2 AND provider_ref = $3
        AND status IN ('sent','failed')
      RETURNING id, status`,
    [principal.clinicId, input.provider, input.providerRef, target, input.errorCode ?? 'provider_reported_failure'],
  );
  if (rows.length === 0) {
    // Either unknown ref, wrong clinic, or already in a terminal state.
    const existing = await getPool().query<{ id: string; status: MessageStatus }>(
      `SELECT id, status FROM message_log
        WHERE clinic_id = $1 AND provider = $2 AND provider_ref = $3`,
      [principal.clinicId, input.provider, input.providerRef],
    );
    if (existing.rows.length === 0) throw new NotFoundError('Message');
    return { messageId: existing.rows[0]!.id, status: existing.rows[0]!.status };
  }
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'message.delivery_status',
    outcome: input.delivered ? 'success' : 'error',
    targetType: 'message',
    targetId: rows[0]!.id,
    metadata: { status: target },
  });
  return { messageId: rows[0]!.id, status: rows[0]!.status };
}

export { backoffMs };
