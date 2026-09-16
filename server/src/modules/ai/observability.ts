import { getPool, type PoolClient } from '../../db/pool.js';

/**
 * AI observability / auditability (blueprint §27, §34).
 *
 * Records one append-only row per AI generation call. It captures SHAPE ONLY —
 * provider, model, latency, input/output SIZES, grounded-source count, outcome.
 * It never stores the prompt, the response, or any PHI, so the AI audit trail
 * is safe to export to administrators/regulators.
 */
export interface GenerationRecordInput {
  clinicId: string;
  draftId?: string | null;
  kind: string;
  provider: string;
  model?: string | null;
  status: 'succeeded' | 'failed';
  inputChars?: number;
  outputChars?: number;
  sourceCount?: number;
  latencyMs?: number;
  errorCode?: string | null;
  createdBy?: string | null;
  // Governance decision context (no PHI — labels only).
  dataClass?: string | null;
  policyDecision?: string | null;
  providerTier?: string | null;
  requestId?: string | null;
}

export async function recordGeneration(
  runner: Pick<PoolClient, 'query'>,
  input: GenerationRecordInput,
): Promise<void> {
  await runner.query(
    `INSERT INTO ai_generation
       (clinic_id, draft_id, kind, provider, model, status, input_chars, output_chars,
        source_count, latency_ms, error_code, created_by,
        data_class, policy_decision, provider_tier, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      input.clinicId,
      input.draftId ?? null,
      input.kind,
      input.provider,
      input.model ?? null,
      input.status,
      input.inputChars ?? null,
      input.outputChars ?? null,
      input.sourceCount ?? null,
      input.latencyMs ?? null,
      input.errorCode ?? null,
      input.createdBy ?? null,
      input.dataClass ?? null,
      input.policyDecision ?? null,
      input.providerTier ?? null,
      input.requestId ?? null,
    ],
  );
}

/** Convenience for a call on the shared pool (its own connection). */
export function recordGenerationPool(input: GenerationRecordInput): Promise<void> {
  return recordGeneration(getPool(), input);
}
