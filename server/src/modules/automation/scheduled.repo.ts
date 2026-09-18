import { getPool, type PoolClient } from '../../db/pool.js';
import type { ScheduledAction } from './automation.types.js';

/** Persistence for the scheduled-action (time-engine) queue. */

interface ScheduledRow {
  id: string;
  clinic_id: string;
  rule_id: string | null;
  source_event_id: string | null;
  action_type: string;
  params: Record<string, unknown>;
  dedupe_key: string | null;
  status: ScheduledAction['status'];
  scheduled_for: string;
  not_before: string | null;
  expires_at: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export function mapScheduled(r: ScheduledRow): ScheduledAction {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    ruleId: r.rule_id,
    sourceEventId: r.source_event_id === null ? null : Number(r.source_event_id),
    actionType: r.action_type,
    params: r.params,
    dedupeKey: r.dedupe_key,
    status: r.status,
    scheduledFor: r.scheduled_for,
    notBefore: r.not_before,
    expiresAt: r.expires_at,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lastError: r.last_error,
    result: r.result,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface InsertScheduledInput {
  clinicId: string;
  ruleId?: string | null;
  sourceEventId?: number | null;
  actionType: string;
  params: Record<string, unknown>;
  dedupeKey?: string | null;
  scheduledFor: Date;
  notBefore?: Date | null;
  expiresAt?: Date | null;
  maxAttempts?: number;
  createdBy?: string | null;
}

/**
 * Enqueue a scheduled action. Idempotent on (clinic_id, dedupe_key): scheduling
 * the same logical action twice returns the existing row instead of duplicating.
 * Returns `{ action, created }`.
 */
export async function insertScheduled(
  input: InsertScheduledInput,
): Promise<{ action: ScheduledAction; created: boolean }> {
  const inserted = await getPool().query<ScheduledRow>(
    `INSERT INTO scheduled_action
       (clinic_id, rule_id, source_event_id, action_type, params, dedupe_key,
        scheduled_for, not_before, expires_at, max_attempts, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (clinic_id, dedupe_key) DO NOTHING
     RETURNING *`,
    [
      input.clinicId,
      input.ruleId ?? null,
      input.sourceEventId ?? null,
      input.actionType,
      JSON.stringify(input.params),
      input.dedupeKey ?? null,
      input.scheduledFor,
      input.notBefore ?? null,
      input.expiresAt ?? null,
      input.maxAttempts ?? 5,
      input.createdBy ?? null,
    ],
  );
  if (inserted.rows.length > 0) {
    return { action: mapScheduled(inserted.rows[0]!), created: true };
  }
  // Conflict: return the existing scheduled action.
  const existing = await getPool().query<ScheduledRow>(
    `SELECT * FROM scheduled_action WHERE clinic_id = $1 AND dedupe_key = $2`,
    [input.clinicId, input.dedupeKey],
  );
  return { action: mapScheduled(existing.rows[0]!), created: false };
}

/**
 * Atomically claim up to `limit` due actions. Due = pending, scheduled_for and
 * not_before have passed. Actions past their expiry are marked 'expired' (not
 * run); the rest are moved to 'executing' and their attempt counted. Uses
 * FOR UPDATE SKIP LOCKED so concurrent workers never claim the same row.
 */
export async function claimDue(client: PoolClient, limit: number): Promise<ScheduledAction[]> {
  const { rows } = await client.query<ScheduledRow>(
    `UPDATE scheduled_action s SET
        status = CASE WHEN s.expires_at IS NOT NULL AND s.expires_at <= now() THEN 'expired' ELSE 'executing' END,
        attempts = s.attempts + CASE WHEN (s.expires_at IS NULL OR s.expires_at > now()) THEN 1 ELSE 0 END,
        updated_at = now()
      WHERE s.id IN (
        SELECT id FROM scheduled_action
          WHERE status = 'pending'
            AND scheduled_for <= now()
            AND (not_before IS NULL OR not_before <= now())
          ORDER BY scheduled_for ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit],
  );
  return rows.map(mapScheduled);
}

export async function markDone(id: string, result: Record<string, unknown>): Promise<void> {
  await getPool().query(
    `UPDATE scheduled_action SET status='done', result=$2, last_error=NULL, updated_at=now() WHERE id=$1`,
    [id, JSON.stringify(result)],
  );
}

/** Reschedule for a backoff retry, or dead-letter as 'failed' at the cap. */
export async function markRetryOrFail(
  id: string,
  attempts: number,
  maxAttempts: number,
  error: string,
  nextAttemptAt: Date,
): Promise<'pending' | 'failed'> {
  const dead = attempts >= maxAttempts;
  if (dead) {
    await getPool().query(
      `UPDATE scheduled_action SET status='failed', last_error=$2, updated_at=now() WHERE id=$1`,
      [id, error],
    );
    return 'failed';
  }
  await getPool().query(
    `UPDATE scheduled_action
        SET status='pending', last_error=$2, not_before=$3, next_attempt_at=$3, updated_at=now()
      WHERE id=$1`,
    [id, error, nextAttemptAt],
  );
  return 'pending';
}

export async function listScheduled(
  clinicId: string,
  status: ScheduledAction['status'] | undefined,
  limit = 100,
): Promise<ScheduledAction[]> {
  const { rows } = await getPool().query<ScheduledRow>(
    `SELECT * FROM scheduled_action
      WHERE clinic_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY scheduled_for DESC LIMIT $3`,
    [clinicId, status ?? null, Math.min(limit, 500)],
  );
  return rows.map(mapScheduled);
}

export async function getScheduled(clinicId: string, id: string): Promise<ScheduledAction | null> {
  const { rows } = await getPool().query<ScheduledRow>(
    `SELECT * FROM scheduled_action WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapScheduled(rows[0]) : null;
}

/** Cancel a pending scheduled action. Only pending actions can be cancelled. */
export async function cancelScheduled(clinicId: string, id: string): Promise<'cancelled' | 'not_pending' | 'not_found'> {
  const { rows } = await getPool().query<{ status: ScheduledAction['status'] }>(
    `SELECT status FROM scheduled_action WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  if (rows.length === 0) return 'not_found';
  if (rows[0]!.status !== 'pending') return 'not_pending';
  await getPool().query(
    `UPDATE scheduled_action SET status='cancelled', updated_at=now() WHERE id=$1 AND clinic_id=$2 AND status='pending'`,
    [id, clinicId],
  );
  return 'cancelled';
}
