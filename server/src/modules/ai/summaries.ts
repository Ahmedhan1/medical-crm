import { getPool, withTransaction } from '../../db/pool.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import { authorizeAiRequest } from './gateway.js';
import type { SourceRecord } from './ai.types.js';
import { insertDraft, type AIDraft } from './drafts.js';
import { recordGeneration, recordGenerationPool } from './observability.js';
import { validateAiOutput } from './schema/output-schemas.js';
import { SCHEMA_VERSIONS, PROMPT_VERSIONS } from './schema/versions.js';

/**
 * AI longitudinal summaries (blueprint §13, §27; task A005).
 *
 * Grounds strictly on the patient's real, clinic-scoped domain events. The
 * provider must cite only these sources and cannot invent facts (the local
 * provider refuses with no sources). The result is a review-first DRAFT; it is
 * never authoritative until a human confirms it.
 */

/** Human-readable, non-fabricated labels for the domain events we summarise. */
const EVENT_LABELS: Record<string, string> = {
  PATIENT_REGISTERED: 'Patient registered',
  PATIENT_CHECKED_IN: 'Checked in for a visit',
  ENCOUNTER_STATUS_CHANGED: 'Encounter status changed',
  QR_ISSUED: 'Identity QR issued',
  QR_RESOLVED: 'Identity QR scanned',
};

async function gatherPatientSources(clinicId: string, patientId: string): Promise<SourceRecord[]> {
  const { rows } = await getPool().query<{
    id: string;
    type: string;
    occurred_at: string;
  }>(
    `SELECT id, type, occurred_at
       FROM event
      WHERE clinic_id = $1
        AND (subject_id::text = $2 OR payload->>'patientId' = $2)
      ORDER BY occurred_at ASC
      LIMIT 500`,
    [clinicId, patientId],
  );
  return rows.map((r) => ({
    ref: `event:${r.id}`,
    kind: 'event',
    text: EVENT_LABELS[r.type] ?? r.type,
    // pg returns timestamptz as a Date; normalise to an ISO string.
    occurredAt: new Date(r.occurred_at).toISOString(),
  }));
}

export async function generatePatientSummary(
  principal: Principal,
  patientId: string,
): Promise<AIDraft> {
  requirePermission(principal, Permission.AI_SUMMARY_GENERATE);

  // Ensure the patient exists in this clinic (no cross-tenant summarisation).
  const patient = await getPool().query<{ id: string }>(
    `SELECT id FROM patient WHERE id = $1 AND clinic_id = $2`,
    [patientId, principal.clinicId],
  );
  if (patient.rows.length === 0) throw new NotFoundError('Patient');

  // Governance gateway: classify → tenant policy → provider routing. A patient
  // summary is PHI, so the default (no cloud opt-in) routes to the local provider.
  const auth = await authorizeAiRequest({
    clinicId: principal.clinicId,
    capability: 'summary',
    actorId: principal.userId,
  });
  const provider = auth.provider;
  const sources = await gatherPatientSources(principal.clinicId, patientId);

  const started = Date.now();
  const result = await provider.summarize({ sources, kind: 'summary' });
  const latencyMs = Date.now() - started;

  // Structured-output gate: reject a malformed/unsafe summary — never persist it.
  const validation = validateAiOutput('summary', result);
  if (!validation.ok) {
    await recordGenerationPool({
      clinicId: principal.clinicId,
      kind: 'summary',
      provider: provider.id,
      model: provider.model,
      status: 'failed',
      inputChars: sources.reduce((n, s) => n + s.text.length, 0),
      latencyMs,
      errorCode: 'invalid_ai_output',
      failureStage: 'validate',
      validationStatus: 'invalid',
      schemaVersion: validation.schemaVersion,
      promptVersion: PROMPT_VERSIONS.summary,
      createdBy: principal.userId,
      dataClass: auth.classification,
      policyDecision: auth.decision,
      providerTier: auth.providerTier,
      requestId: auth.requestId,
    });
    throw new ValidationError('AI produced an invalid summary output', { issues: validation.issues });
  }

  return withTransaction(async (client) => {
    const draft = await insertDraft(client, {
      clinicId: principal.clinicId,
      kind: 'summary',
      subjectType: 'patient',
      subjectId: patientId,
      content: { summary: result.summary, sourceCount: sources.length },
      citations: result.citations,
      provider: provider.id,
      model: provider.model,
      createdBy: principal.userId,
    });
    await recordGeneration(client, {
      clinicId: principal.clinicId,
      draftId: draft.id,
      kind: 'summary',
      provider: provider.id,
      model: provider.model,
      status: 'succeeded',
      validationStatus: 'valid',
      schemaVersion: SCHEMA_VERSIONS.summary,
      promptVersion: PROMPT_VERSIONS.summary,
      attempt: 1,
      inputChars: sources.reduce((n, s) => n + s.text.length, 0),
      outputChars: result.summary.length,
      sourceCount: sources.length,
      latencyMs,
      createdBy: principal.userId,
      dataClass: auth.classification,
      policyDecision: auth.decision,
      providerTier: auth.providerTier,
      requestId: auth.requestId,
    });
    return draft;
  });
}
