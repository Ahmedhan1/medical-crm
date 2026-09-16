import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import type { Citation } from './ai.types.js';

/**
 * Review-first AI draft lifecycle (blueprint §12).
 *
 * Every AI output lands here as a `pending` draft. A human with review rights
 * confirms or rejects it. CONFIRMATION DOES NOT WRITE CLINICAL DATA: it only
 * marks the draft authoritative-for-review and emits an event; the actual
 * promotion of a confirmed draft into a clinical record is a separate,
 * contract-governed step owned by the Clinical Core (see CONTRACT_CHANGE_REQUEST
 * CCR-001). This guarantees AI never silently mutates a clinical record.
 */
export type DraftKind = 'intake' | 'summary' | 'call_report' | 'clinical_note';
export type DraftStatus = 'pending' | 'confirmed' | 'rejected';

export interface AIDraft {
  id: string;
  clinicId: string;
  kind: DraftKind;
  subjectType: string;
  subjectId: string;
  status: DraftStatus;
  content: Record<string, unknown>;
  citations: Citation[];
  provider: string;
  model: string | null;
  createdBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DraftRow {
  id: string;
  clinic_id: string;
  kind: DraftKind;
  subject_type: string;
  subject_id: string;
  status: DraftStatus;
  content: Record<string, unknown>;
  citations: Citation[];
  provider: string;
  model: string | null;
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

function mapDraft(r: DraftRow): AIDraft {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    kind: r.kind,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    status: r.status,
    content: r.content,
    citations: r.citations,
    provider: r.provider,
    model: r.model,
    createdBy: r.created_by,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateDraftInput {
  clinicId: string;
  kind: DraftKind;
  subjectType: string;
  subjectId: string;
  content: Record<string, unknown>;
  citations: Citation[];
  provider: string;
  model?: string | null;
  createdBy: string | null;
}

/**
 * Insert a pending draft + emit AI_DRAFT_CREATED, transactionally. Returns the
 * draft row. Callers (intake/summaries) pass a transaction client so the draft
 * and its observability row commit together.
 */
export async function insertDraft(client: PoolClient, input: CreateDraftInput): Promise<AIDraft> {
  const { rows } = await client.query<DraftRow>(
    `INSERT INTO ai_draft
       (clinic_id, kind, subject_type, subject_id, status, content, citations, provider, model, created_by)
     VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      input.clinicId,
      input.kind,
      input.subjectType,
      input.subjectId,
      JSON.stringify(input.content),
      JSON.stringify(input.citations),
      input.provider,
      input.model ?? null,
      input.createdBy,
    ],
  );
  const draft = mapDraft(rows[0]!);
  await emitEvent(client, {
    clinicId: input.clinicId,
    type: EventType.AI_DRAFT_CREATED,
    subjectType: 'ai_draft',
    subjectId: draft.id,
    actorId: input.createdBy,
    payload: { kind: draft.kind, subjectType: draft.subjectType, subjectId: draft.subjectId },
  });
  await auditTx(client, {
    clinicId: input.clinicId,
    actorId: input.createdBy,
    action: 'ai.draft.create',
    outcome: 'success',
    targetType: 'ai_draft',
    targetId: draft.id,
    metadata: { kind: draft.kind, citations: draft.citations.length },
  });
  return draft;
}

export async function getDraft(clinicId: string, id: string): Promise<AIDraft | null> {
  const { rows } = await getPool().query<DraftRow>(
    `SELECT * FROM ai_draft WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapDraft(rows[0]) : null;
}

export interface ListDraftsFilter {
  status?: DraftStatus;
  kind?: DraftKind;
  subjectType?: string;
  subjectId?: string;
}

export async function listDrafts(principal: Principal, filter: ListDraftsFilter = {}): Promise<AIDraft[]> {
  requirePermission(principal, Permission.AI_DRAFT_REVIEW);
  const { rows } = await getPool().query<DraftRow>(
    `SELECT * FROM ai_draft
      WHERE clinic_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR kind = $3)
        AND ($4::text IS NULL OR subject_type = $4)
        AND ($5::uuid IS NULL OR subject_id = $5)
      ORDER BY created_at DESC
      LIMIT 200`,
    [
      principal.clinicId,
      filter.status ?? null,
      filter.kind ?? null,
      filter.subjectType ?? null,
      filter.subjectId ?? null,
    ],
  );
  return rows.map(mapDraft);
}

export async function getDraftForReview(principal: Principal, id: string): Promise<AIDraft> {
  requirePermission(principal, Permission.AI_DRAFT_REVIEW);
  const draft = await getDraft(principal.clinicId, id);
  if (!draft) throw new NotFoundError('AI draft');
  return draft;
}

/**
 * Confirm a pending draft. This is the human review gate. It DOES NOT write to
 * any clinical table — promotion into a clinical record is a separate,
 * contract-governed handoff (CCR-001). Emits AI_DRAFT_CONFIRMED.
 */
export async function confirmDraft(principal: Principal, id: string, note?: string): Promise<AIDraft> {
  requirePermission(principal, Permission.AI_DRAFT_REVIEW);
  return transition(principal, id, 'confirmed', EventType.AI_DRAFT_CONFIRMED, 'ai.draft.confirm', note);
}

/** Reject a pending draft. Emits AI_DRAFT_REJECTED. */
export async function rejectDraft(principal: Principal, id: string, note?: string): Promise<AIDraft> {
  requirePermission(principal, Permission.AI_DRAFT_REVIEW);
  return transition(principal, id, 'rejected', EventType.AI_DRAFT_REJECTED, 'ai.draft.reject', note);
}

async function transition(
  principal: Principal,
  id: string,
  target: DraftStatus,
  eventType: (typeof EventType)[keyof typeof EventType],
  auditAction: string,
  note?: string,
): Promise<AIDraft> {
  return withTransaction(async (client) => {
    // Lock the row so two reviewers cannot both transition it.
    const current = await client.query<DraftRow>(
      `SELECT * FROM ai_draft WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [id, principal.clinicId],
    );
    if (current.rows.length === 0) throw new NotFoundError('AI draft');
    if (current.rows[0]!.status !== 'pending') {
      throw new ConflictError(`Draft already ${current.rows[0]!.status}`);
    }

    const { rows } = await client.query<DraftRow>(
      `UPDATE ai_draft
          SET status = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5, updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING *`,
      [id, principal.clinicId, target, principal.userId, note ?? null],
    );
    const draft = mapDraft(rows[0]!);

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: eventType,
      subjectType: 'ai_draft',
      subjectId: draft.id,
      actorId: principal.userId,
      payload: { kind: draft.kind },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: auditAction,
      outcome: 'success',
      targetType: 'ai_draft',
      targetId: draft.id,
      metadata: { kind: draft.kind },
    });
    return draft;
  });
}
