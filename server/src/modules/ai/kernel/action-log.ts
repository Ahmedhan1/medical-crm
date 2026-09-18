import { getPool } from '../../../db/pool.js';
import type { AiActionDecision } from './guard.js';

/**
 * AI action observability (E4). One append-only row per guard decision. Records
 * SHAPE ONLY — identity, tool, risk, decision, reason — and NEVER the tool
 * arguments, patient data, prompt, model secret, or any PHI.
 */
export async function recordActionDecision(decision: AiActionDecision, opts: { executed: boolean; createdBy?: string | null }): Promise<void> {
  await getPool().query(
    `INSERT INTO ai_action_log
       (clinic_id, request_id, identity_id, tool_id, access, risk, data_class,
        decision, reason_code, confirmation_required, executed, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      decision.clinicId,
      decision.requestId,
      // identity_id is a real column of type uuid; only store it when it is a
      // resolved identity (the guard echoes the requested id even when unknown).
      decision.reasonCode === 'unknown_identity' ? null : decision.identityId,
      decision.toolId,
      decision.access,
      decision.risk,
      decision.dataClass,
      decision.decision,
      decision.reasonCode,
      decision.confirmationRequired,
      opts.executed,
      opts.createdBy ?? null,
    ],
  );
}
