import { withTransaction } from '../../db/pool.js';
import { ValidationError } from '../../domain/errors.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import { getAIProvider } from './providers/registry.js';
import { insertDraft, type AIDraft } from './drafts.js';
import { recordGeneration, recordGenerationPool } from './observability.js';

/**
 * AI voice/text → structured intake DRAFT (blueprint §12; task A004).
 *
 * This is the review-first half of AI intake that lives entirely within the
 * AI/Automation workstream. It produces a DRAFT only; it NEVER writes to any
 * clinical/intake table. Promoting a confirmed intake draft into the clinical
 * record is a Clinical Core responsibility gated by a contract (CCR-001) — until
 * that contract exists, confirmation stops at the draft. This is the
 * safety-preserving boundary, not a stub.
 */
export interface ExtractIntakeInput {
  subjectType: 'patient' | 'encounter';
  subjectId: string;
  /** Free text or an already-transcribed voice note. */
  text?: string;
  /** Provider-resolvable audio reference (local provider requires text). */
  audioRef?: string;
  locale?: string;
}

export async function extractIntakeToDraft(
  principal: Principal,
  input: ExtractIntakeInput,
): Promise<AIDraft> {
  requirePermission(principal, Permission.AI_DRAFT_CREATE);

  const provider = getAIProvider();

  // Resolve transcript text (transcription is provider-abstracted).
  let text = input.text ?? '';
  if (!text && input.audioRef) {
    if (!provider.transcribe) throw new ValidationError('Provider cannot transcribe audio');
    text = (await provider.transcribe({ audioRef: input.audioRef, locale: input.locale })).text;
  }
  if (!text.trim()) throw new ValidationError('Intake requires text or a transcribable audio reference');

  const started = Date.now();
  let extraction;
  try {
    extraction = await provider.extractIntake({ text });
  } catch (err) {
    // Best-effort failure observability (no PHI — shape only).
    await recordGenerationPool({
      clinicId: principal.clinicId,
      kind: 'intake',
      provider: provider.id,
      model: provider.model,
      status: 'failed',
      inputChars: text.length,
      latencyMs: Date.now() - started,
      errorCode: err instanceof Error ? err.name : 'extract_error',
      createdBy: principal.userId,
    });
    throw err;
  }
  const latencyMs = Date.now() - started;

  return withTransaction(async (client) => {
    const draft = await insertDraft(client, {
      clinicId: principal.clinicId,
      kind: 'intake',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      content: { fields: extraction.fields },
      citations: extraction.citations,
      provider: provider.id,
      model: provider.model,
      createdBy: principal.userId,
    });
    await recordGeneration(client, {
      clinicId: principal.clinicId,
      draftId: draft.id,
      kind: 'intake',
      provider: provider.id,
      model: provider.model,
      status: 'succeeded',
      inputChars: text.length,
      outputChars: JSON.stringify(extraction.fields).length,
      sourceCount: extraction.citations.length,
      latencyMs,
      createdBy: principal.userId,
    });
    return draft;
  });
}
