import { getPool, type PoolClient } from '../../db/pool.js';
import { toDateString } from './dates.js';

type Runner = Pick<PoolClient, 'query'>;

/**
 * Medical-representative field data: visits, call reports and their children
 * (products discussed, objections, competitor mentions), scientific requests
 * and follow-up actions.
 *
 * GOVERNANCE: no statement here references a clinical table. Everything is keyed
 * on `hcp`, `territory`, `medication` and `app_user`.
 */

// --- Visit ------------------------------------------------------------------

export interface Visit {
  id: string;
  clinicId: string;
  /**
   * NULL for an INSTITUTIONAL call — a visit to an organisation (a pharmacy
   * chain's head office, a hospital procurement department) with no individual
   * professional as its subject. `visit_has_subject` guarantees at least one of
   * `hcpId` / `hcoId` is present.
   */
  hcpId: string | null;
  hcpName?: string;
  territoryId: string | null;
  hcoId: string | null;
  hcoName?: string;
  /** HOW the interaction happened, independent of why (`visitType`). */
  modality:
    | 'face_to_face'
    | 'virtual'
    | 'phone'
    | 'conference'
    | 'scientific_meeting'
    | 'institutional';
  practiceLocationId: string | null;
  repUserId: string;
  status: 'planned' | 'confirmed' | 'completed' | 'cancelled' | 'no_access';
  visitType: 'detail' | 'follow_up' | 'scientific' | 'courtesy' | 'event';
  plannedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  objective: string | null;
  outcomeReason: string | null;
  createdAt: string;
}

interface VisitRow {
  id: string;
  clinic_id: string;
  hcp_id: string | null;
  hcp_name?: string | null;
  territory_id: string | null;
  hco_id: string | null;
  hco_name?: string | null;
  modality: Visit['modality'];
  practice_location_id: string | null;
  rep_user_id: string;
  status: Visit['status'];
  visit_type: Visit['visitType'];
  planned_at: string;
  started_at: string | null;
  ended_at: string | null;
  objective: string | null;
  outcome_reason: string | null;
  created_at: string;
}

function mapVisit(row: VisitRow): Visit {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    hcpId: row.hcp_id,
    ...(row.hcp_name !== undefined ? { hcpName: row.hcp_name ?? undefined } : {}),
    territoryId: row.territory_id,
    hcoId: row.hco_id,
    ...(row.hco_name !== undefined ? { hcoName: row.hco_name ?? undefined } : {}),
    modality: row.modality,
    practiceLocationId: row.practice_location_id,
    repUserId: row.rep_user_id,
    status: row.status,
    visitType: row.visit_type,
    plannedAt: row.planned_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    objective: row.objective,
    outcomeReason: row.outcome_reason,
    createdAt: row.created_at,
  };
}

export async function insertVisit(
  runner: Runner,
  input: {
    clinicId: string;
    hcpId: string | null;
    territoryId: string | null;
    hcoId: string | null;
    practiceLocationId: string | null;
    repUserId: string;
    visitType: Visit['visitType'];
    modality: Visit['modality'];
    plannedAt: string;
    objective: string | null;
    createdBy: string;
  },
): Promise<Visit> {
  const { rows } = await runner.query<VisitRow>(
    `INSERT INTO visit
       (clinic_id, hcp_id, territory_id, hco_id, practice_location_id, rep_user_id,
        visit_type, modality, planned_at, objective, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      input.clinicId,
      input.hcpId,
      input.territoryId,
      input.hcoId,
      input.practiceLocationId,
      input.repUserId,
      input.visitType,
      input.modality,
      input.plannedAt,
      input.objective,
      input.createdBy,
    ],
  );
  return mapVisit(rows[0]!);
}

export async function getVisitById(
  clinicId: string,
  id: string,
  runner: Runner = getPool(),
): Promise<Visit | null> {
  const { rows } = await runner.query<VisitRow>(
    `SELECT v.*, h.full_name AS hcp_name, o.name AS hco_name
       FROM visit v
       LEFT JOIN hcp h ON h.id = v.hcp_id
       LEFT JOIN hco o ON o.id = v.hco_id
      WHERE v.id = $1 AND v.clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapVisit(rows[0]) : null;
}

export async function getVisitForUpdate(
  client: PoolClient,
  clinicId: string,
  id: string,
): Promise<Visit | null> {
  const { rows } = await client.query<VisitRow>(
    `SELECT * FROM visit WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
    [id, clinicId],
  );
  return rows[0] ? mapVisit(rows[0]) : null;
}

/**
 * Append-only transition log for a visit (0309).
 *
 * The visit row carries the CURRENT status; this carries how it got there. It
 * is the difference between "this call was a no-access" and "this call was
 * planned, confirmed, then recorded as a no-access at 16:40 by this rep" —
 * which is the version a compliance review actually needs. Refuses UPDATE and
 * DELETE at the database, so the trail cannot be tidied afterwards.
 */
export interface VisitEvent {
  id: string;
  visitId: string;
  fromStatus: Visit['status'] | null;
  toStatus: Visit['status'];
  reason: string | null;
  actorId: string | null;
  occurredAt: string;
}

export async function insertVisitEvent(
  runner: Runner,
  input: {
    clinicId: string;
    visitId: string;
    fromStatus: Visit['status'] | null;
    toStatus: Visit['status'];
    reason: string | null;
    actorId: string | null;
  },
): Promise<void> {
  await runner.query(
    `INSERT INTO visit_event (clinic_id, visit_id, from_status, to_status, reason, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.clinicId,
      input.visitId,
      input.fromStatus,
      input.toStatus,
      input.reason,
      input.actorId,
    ],
  );
}

export async function listVisitEvents(
  clinicId: string,
  visitId: string,
  runner: Runner = getPool(),
): Promise<VisitEvent[]> {
  const { rows } = await runner.query<{
    id: string;
    visit_id: string;
    from_status: Visit['status'] | null;
    to_status: Visit['status'];
    reason: string | null;
    actor_id: string | null;
    occurred_at: string;
  }>(
    `SELECT id::text AS id, visit_id, from_status, to_status, reason, actor_id, occurred_at
       FROM visit_event
      WHERE clinic_id = $1 AND visit_id = $2
      ORDER BY occurred_at, id`,
    [clinicId, visitId],
  );
  return rows.map((row) => ({
    id: row.id,
    visitId: row.visit_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
  }));
}

export interface VisitListFilter {
  repUserId: string | null;
  hcpId: string | null;
  hcoId: string | null;
  territoryIds: string[] | null;
  status: Visit['status'] | null;
  modality: Visit['modality'] | null;
  from: string | null;
  to: string | null;
  limit: number;
}

export async function listVisits(clinicId: string, filter: VisitListFilter): Promise<Visit[]> {
  const { rows } = await getPool().query<VisitRow>(
    `SELECT v.*, h.full_name AS hcp_name, o.name AS hco_name
       FROM visit v
       LEFT JOIN hcp h ON h.id = v.hcp_id
       LEFT JOIN hco o ON o.id = v.hco_id
      WHERE v.clinic_id = $1
        AND ($2::uuid IS NULL OR v.rep_user_id = $2)
        AND ($3::uuid IS NULL OR v.hcp_id = $3)
        AND ($4::uuid[] IS NULL OR v.territory_id = ANY($4))
        AND ($5::text IS NULL OR v.status = $5)
        AND ($6::timestamptz IS NULL OR v.planned_at >= $6)
        AND ($7::timestamptz IS NULL OR v.planned_at < $7)
        AND ($8::uuid IS NULL OR v.hco_id = $8)
        AND ($9::text IS NULL OR v.modality = $9)
      ORDER BY v.planned_at
      LIMIT $10`,
    [
      clinicId,
      filter.repUserId,
      filter.hcpId,
      filter.territoryIds,
      filter.status,
      filter.from,
      filter.to,
      filter.hcoId,
      filter.modality,
      filter.limit,
    ],
  );
  return rows.map(mapVisit);
}

export async function updateVisitStatus(
  client: PoolClient,
  clinicId: string,
  id: string,
  fields: {
    status: Visit['status'];
    startedAt?: string | null;
    endedAt?: string | null;
    outcomeReason?: string | null;
  },
): Promise<Visit> {
  const { rows } = await client.query<VisitRow>(
    `UPDATE visit
        SET status = $3,
            started_at = coalesce($4, started_at),
            ended_at = coalesce($5, ended_at),
            outcome_reason = coalesce($6, outcome_reason),
            updated_at = now()
      WHERE id = $1 AND clinic_id = $2
      RETURNING *`,
    [
      id,
      clinicId,
      fields.status,
      fields.startedAt ?? null,
      fields.endedAt ?? null,
      fields.outcomeReason ?? null,
    ],
  );
  return mapVisit(rows[0]!);
}

// --- Call report ------------------------------------------------------------

export interface CallReport {
  id: string;
  visitId: string;
  /** NULL on an institutional call; `hcoId` carries the subject instead. */
  hcpId: string | null;
  hcoId: string | null;
  repUserId: string;
  summary: string;
  hcpSentiment: 'positive' | 'neutral' | 'negative' | 'unknown';
  nextStep: string | null;
  followUpDate: string | null;
  submittedAt: string;
}

interface CallReportRow {
  id: string;
  visit_id: string;
  hcp_id: string | null;
  hco_id: string | null;
  rep_user_id: string;
  summary: string;
  hcp_sentiment: CallReport['hcpSentiment'];
  next_step: string | null;
  follow_up_date: Date | string | null;
  submitted_at: string;
}

function mapCallReport(row: CallReportRow): CallReport {
  return {
    id: row.id,
    visitId: row.visit_id,
    hcpId: row.hcp_id,
    hcoId: row.hco_id,
    repUserId: row.rep_user_id,
    summary: row.summary,
    hcpSentiment: row.hcp_sentiment,
    nextStep: row.next_step,
    followUpDate: toDateString(row.follow_up_date),
    submittedAt: row.submitted_at,
  };
}

export async function insertCallReport(
  client: PoolClient,
  input: {
    clinicId: string;
    visitId: string;
    hcpId: string | null;
    hcoId: string | null;
    repUserId: string;
    summary: string;
    hcpSentiment: CallReport['hcpSentiment'];
    nextStep: string | null;
    followUpDate: string | null;
  },
): Promise<CallReport> {
  const { rows } = await client.query<CallReportRow>(
    `INSERT INTO call_report
       (clinic_id, visit_id, hcp_id, hco_id, rep_user_id, summary, hcp_sentiment, next_step, follow_up_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      input.clinicId,
      input.visitId,
      input.hcpId,
      input.hcoId,
      input.repUserId,
      input.summary,
      input.hcpSentiment,
      input.nextStep,
      input.followUpDate,
    ],
  );
  return mapCallReport(rows[0]!);
}

export async function getCallReportByVisit(
  clinicId: string,
  visitId: string,
): Promise<CallReport | null> {
  const { rows } = await getPool().query<CallReportRow>(
    `SELECT * FROM call_report WHERE clinic_id = $1 AND visit_id = $2`,
    [clinicId, visitId],
  );
  return rows[0] ? mapCallReport(rows[0]) : null;
}

export async function listCallReportsForHcp(
  clinicId: string,
  hcpId: string,
  limit: number,
): Promise<CallReport[]> {
  const { rows } = await getPool().query<CallReportRow>(
    `SELECT * FROM call_report WHERE clinic_id = $1 AND hcp_id = $2
      ORDER BY submitted_at DESC LIMIT $3`,
    [clinicId, hcpId, limit],
  );
  return rows.map(mapCallReport);
}

export async function insertCallReportProduct(
  client: PoolClient,
  input: {
    clinicId: string;
    callReportId: string;
    medicationId: string | null;
    productLabel: string | null;
    discussionOutcome: string;
    notes: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO call_report_product
       (clinic_id, call_report_id, medication_id, product_label, discussion_outcome, notes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.clinicId,
      input.callReportId,
      input.medicationId,
      input.productLabel,
      input.discussionOutcome,
      input.notes,
    ],
  );
}

export async function insertObjection(
  client: PoolClient,
  input: {
    clinicId: string;
    callReportId: string;
    hcpId: string | null;
    hcoId: string | null;
    medicationId: string | null;
    objectionType: string;
    objectionText: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO visit_objection
       (clinic_id, call_report_id, hcp_id, hco_id, medication_id, objection_type, objection_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.clinicId,
      input.callReportId,
      input.hcpId,
      input.hcoId,
      input.medicationId,
      input.objectionType,
      input.objectionText,
    ],
  );
}

export async function insertCompetitorMention(
  client: PoolClient,
  input: {
    clinicId: string;
    callReportId: string;
    hcpId: string | null;
    hcoId: string | null;
    competitorName: string;
    competitorProduct: string | null;
    context: string | null;
    sentiment: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO call_report_competitor
       (clinic_id, call_report_id, hcp_id, hco_id, competitor_name, competitor_product, context, sentiment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.clinicId,
      input.callReportId,
      input.hcpId,
      input.hcoId,
      input.competitorName,
      input.competitorProduct,
      input.context,
      input.sentiment,
    ],
  );
}

export interface ObjectionSummary {
  id: string;
  objectionType: string;
  objectionText: string;
  medicationId: string | null;
  resolved: boolean;
  createdAt: string;
}

export async function listOpenObjectionsForHcp(
  clinicId: string,
  hcpId: string,
  limit: number,
): Promise<ObjectionSummary[]> {
  const { rows } = await getPool().query<{
    id: string;
    objection_type: string;
    objection_text: string;
    medication_id: string | null;
    resolved: boolean;
    created_at: string;
  }>(
    `SELECT id, objection_type, objection_text, medication_id, resolved, created_at
       FROM visit_objection
      WHERE clinic_id = $1 AND hcp_id = $2 AND NOT resolved
      ORDER BY created_at DESC LIMIT $3`,
    [clinicId, hcpId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    objectionType: r.objection_type,
    objectionText: r.objection_text,
    medicationId: r.medication_id,
    resolved: r.resolved,
    createdAt: r.created_at,
  }));
}

// --- Scientific requests ----------------------------------------------------

export interface ScientificRequest {
  id: string;
  hcpId: string;
  visitId: string | null;
  medicationId: string | null;
  requestedBy: string;
  requestType: string;
  question: string;
  urgency: 'routine' | 'high';
  status: 'open' | 'in_review' | 'answered' | 'closed' | 'rejected';
  dueDate: string | null;
  answerSummary: string | null;
  answerContentId: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
}

interface ScientificRequestRow {
  id: string;
  hcp_id: string;
  visit_id: string | null;
  medication_id: string | null;
  requested_by: string;
  request_type: string;
  question: string;
  urgency: ScientificRequest['urgency'];
  status: ScientificRequest['status'];
  due_date: Date | string | null;
  answer_summary: string | null;
  answer_content_id: string | null;
  answered_by: string | null;
  answered_at: string | null;
  created_at: string;
}

function mapRequest(row: ScientificRequestRow): ScientificRequest {
  return {
    id: row.id,
    hcpId: row.hcp_id,
    visitId: row.visit_id,
    medicationId: row.medication_id,
    requestedBy: row.requested_by,
    requestType: row.request_type,
    question: row.question,
    urgency: row.urgency,
    status: row.status,
    dueDate: toDateString(row.due_date),
    answerSummary: row.answer_summary,
    answerContentId: row.answer_content_id,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at,
    createdAt: row.created_at,
  };
}

export async function insertScientificRequest(
  client: PoolClient,
  input: {
    clinicId: string;
    hcpId: string;
    visitId: string | null;
    callReportId: string | null;
    medicationId: string | null;
    requestedBy: string;
    requestType: string;
    question: string;
    urgency: ScientificRequest['urgency'];
    dueDate: string | null;
  },
): Promise<ScientificRequest> {
  const { rows } = await client.query<ScientificRequestRow>(
    `INSERT INTO scientific_request
       (clinic_id, hcp_id, visit_id, call_report_id, medication_id, requested_by,
        request_type, question, urgency, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      input.clinicId,
      input.hcpId,
      input.visitId,
      input.callReportId,
      input.medicationId,
      input.requestedBy,
      input.requestType,
      input.question,
      input.urgency,
      input.dueDate,
    ],
  );
  return mapRequest(rows[0]!);
}

export async function getScientificRequest(
  clinicId: string,
  id: string,
  runner: Runner = getPool(),
): Promise<ScientificRequest | null> {
  const { rows } = await runner.query<ScientificRequestRow>(
    `SELECT * FROM scientific_request WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapRequest(rows[0]) : null;
}

export async function answerScientificRequest(
  client: PoolClient,
  clinicId: string,
  id: string,
  input: {
    status: ScientificRequest['status'];
    answerSummary: string | null;
    answerContentId: string | null;
    answeredBy: string;
  },
): Promise<ScientificRequest> {
  const { rows } = await client.query<ScientificRequestRow>(
    `UPDATE scientific_request
        SET status = $3,
            answer_summary = $4,
            answer_content_id = $5,
            answered_by = $6,
            answered_at = now(),
            updated_at = now()
      WHERE id = $1 AND clinic_id = $2
      RETURNING *`,
    [id, clinicId, input.status, input.answerSummary, input.answerContentId, input.answeredBy],
  );
  return mapRequest(rows[0]!);
}

export async function listScientificRequests(
  clinicId: string,
  filter: { hcpId: string | null; status: string | null; territoryIds: string[] | null; limit: number },
): Promise<ScientificRequest[]> {
  const { rows } = await getPool().query<ScientificRequestRow>(
    `SELECT sr.* FROM scientific_request sr
      WHERE sr.clinic_id = $1
        AND ($2::uuid IS NULL OR sr.hcp_id = $2)
        AND ($3::text IS NULL OR sr.status = $3)
        AND ($4::uuid[] IS NULL OR EXISTS (
              SELECT 1 FROM hcp_territory ht
               WHERE ht.hcp_id = sr.hcp_id AND ht.territory_id = ANY($4)))
      ORDER BY sr.created_at DESC
      LIMIT $5`,
    [clinicId, filter.hcpId, filter.status, filter.territoryIds, filter.limit],
  );
  return rows.map(mapRequest);
}

// --- Follow-up actions ------------------------------------------------------

export interface FollowUpAction {
  id: string;
  /** NULL when the action is owed to an organisation rather than a person. */
  hcpId: string | null;
  hcoId: string | null;
  visitId: string | null;
  ownerUserId: string;
  action: string;
  dueDate: string;
  status: 'open' | 'done' | 'cancelled';
  completedAt: string | null;
  createdAt: string;
}

interface FollowUpRow {
  id: string;
  hcp_id: string | null;
  hco_id: string | null;
  visit_id: string | null;
  owner_user_id: string;
  action: string;
  due_date: Date | string;
  status: FollowUpAction['status'];
  completed_at: string | null;
  created_at: string;
}

function mapFollowUp(row: FollowUpRow): FollowUpAction {
  return {
    id: row.id,
    hcpId: row.hcp_id,
    hcoId: row.hco_id,
    visitId: row.visit_id,
    ownerUserId: row.owner_user_id,
    action: row.action,
    dueDate: toDateString(row.due_date)!,
    status: row.status,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

export async function insertFollowUp(
  client: PoolClient,
  input: {
    clinicId: string;
    hcpId: string | null;
    hcoId: string | null;
    visitId: string | null;
    callReportId: string | null;
    ownerUserId: string;
    action: string;
    dueDate: string;
    createdBy: string;
  },
): Promise<FollowUpAction> {
  const { rows } = await client.query<FollowUpRow>(
    `INSERT INTO follow_up_action
       (clinic_id, hcp_id, hco_id, visit_id, call_report_id, owner_user_id, action, due_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      input.clinicId,
      input.hcpId,
      input.hcoId,
      input.visitId,
      input.callReportId,
      input.ownerUserId,
      input.action,
      input.dueDate,
      input.createdBy,
    ],
  );
  return mapFollowUp(rows[0]!);
}

export async function completeFollowUp(
  client: PoolClient,
  clinicId: string,
  id: string,
  ownerUserId: string,
): Promise<FollowUpAction | null> {
  const { rows } = await client.query<FollowUpRow>(
    `UPDATE follow_up_action
        SET status = 'done', completed_at = now(), updated_at = now()
      WHERE id = $1 AND clinic_id = $2 AND owner_user_id = $3 AND status = 'open'
      RETURNING *`,
    [id, clinicId, ownerUserId],
  );
  return rows[0] ? mapFollowUp(rows[0]) : null;
}

export async function listFollowUps(
  clinicId: string,
  filter: { ownerUserId: string | null; hcpId: string | null; status: string | null; limit: number },
): Promise<FollowUpAction[]> {
  const { rows } = await getPool().query<FollowUpRow>(
    `SELECT * FROM follow_up_action
      WHERE clinic_id = $1
        AND ($2::uuid IS NULL OR owner_user_id = $2)
        AND ($3::uuid IS NULL OR hcp_id = $3)
        AND ($4::text IS NULL OR status = $4)
      ORDER BY due_date, created_at
      LIMIT $5`,
    [clinicId, filter.ownerUserId, filter.hcpId, filter.status, filter.limit],
  );
  return rows.map(mapFollowUp);
}
