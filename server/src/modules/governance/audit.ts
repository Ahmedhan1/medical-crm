import { getPool, type PoolClient } from '../../db/pool.js';

/**
 * Append an audit record (blueprint §34). Audit is distinct from the event
 * store: it records WHO attempted WHAT against WHICH record and the outcome,
 * for governance and forensics. The `audit_log` table is append-only at the
 * database level (trigger), so entries are tamper-evident.
 *
 * IMPORTANT: never place PHI in `metadata`. Store identifiers and action shape
 * only — the audit trail must be safe to export to administrators/regulators.
 */
export interface AuditInput {
  clinicId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: 'success' | 'denied' | 'error';
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

async function insert(runner: Pick<PoolClient, 'query'>, input: AuditInput): Promise<void> {
  await runner.query(
    `INSERT INTO audit_log
       (clinic_id, actor_id, action, target_type, target_id, outcome, metadata, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.clinicId ?? null,
      input.actorId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.outcome ?? 'success',
      JSON.stringify(input.metadata ?? {}),
      input.ip ?? null,
    ],
  );
}

/** Write an audit record on the shared pool (its own connection). */
export function audit(input: AuditInput): Promise<void> {
  return insert(getPool(), input);
}

/**
 * Write an audit record inside an existing transaction, so a successful state
 * change and its audit entry commit atomically.
 */
export function auditTx(client: PoolClient, input: AuditInput): Promise<void> {
  return insert(client, input);
}
