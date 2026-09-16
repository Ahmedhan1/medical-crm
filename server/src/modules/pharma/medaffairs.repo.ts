import { getPool, type PoolClient } from '../../db/pool.js';
import { toDateString } from './dates.js';

type Runner = Pick<PoolClient, 'query'>;

/**
 * MEDICAL AFFAIRS repository — scientific (medical-information) requests
 * (migrations 0302 / 0310).
 *
 * A scientific request is a question a healthcare professional asked and the
 * company's answer to it. That answer is a regulated communication, so the
 * record carries who it was assigned to, what kind of question it is, the
 * service level it is held to, whether it was escalated, and an append-only
 * trail of everything that happened to it.
 *
 * GOVERNANCE (§45): the request is about a MEDICINE, never about a patient. The
 * question text is screened for identifier-shaped tokens before it is stored
 * (`guards.ts`), and no statement here touches a clinical table.
 */

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
  // --- 0310: triage, service level and escalation ---------------------------
  assignedTo: string | null;
  assignedBy: string | null;
  assignedAt: string | null;
  inquiryCategory: string;
  priority: 'routine' | 'high' | 'critical';
  slaDueAt: string | null;
  sourceChannel: string;
  escalationLevel: number;
  escalatedAt: string | null;
  escalatedBy: string | null;
  escalationReason: string | null;
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
  assigned_to: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  inquiry_category: string;
  priority: ScientificRequest['priority'];
  sla_due_at: string | null;
  source_channel: string;
  escalation_level: number;
  escalated_at: string | null;
  escalated_by: string | null;
  escalation_reason: string | null;
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
    assignedTo: row.assigned_to,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
    inquiryCategory: row.inquiry_category,
    priority: row.priority,
    slaDueAt: row.sla_due_at,
    sourceChannel: row.source_channel,
    escalationLevel: row.escalation_level,
    escalatedAt: row.escalated_at,
    escalatedBy: row.escalated_by,
    escalationReason: row.escalation_reason,
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
    inquiryCategory: string;
    priority: ScientificRequest['priority'];
    slaDueAt: string;
    sourceChannel: string;
  },
): Promise<ScientificRequest> {
  const { rows } = await client.query<ScientificRequestRow>(
    `INSERT INTO scientific_request
       (clinic_id, hcp_id, visit_id, call_report_id, medication_id, requested_by,
        request_type, question, urgency, due_date,
        inquiry_category, priority, sla_due_at, source_channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
      input.inquiryCategory,
      input.priority,
      input.slaDueAt,
      input.sourceChannel,
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

/** Row-locking read: every state change serialises against concurrent triage. */
export async function getScientificRequestForUpdate(
  client: PoolClient,
  clinicId: string,
  id: string,
): Promise<ScientificRequest | null> {
  const { rows } = await client.query<ScientificRequestRow>(
    `SELECT * FROM scientific_request WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
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

export async function assignScientificRequest(
  client: PoolClient,
  clinicId: string,
  id: string,
  input: {
    assignedTo: string | null;
    assignedBy: string;
    status: ScientificRequest['status'];
    priority: ScientificRequest['priority'] | null;
    slaDueAt: string | null;
    inquiryCategory: string | null;
  },
): Promise<ScientificRequest> {
  const { rows } = await client.query<ScientificRequestRow>(
    `UPDATE scientific_request
        SET assigned_to = $3,
            assigned_by = $4,
            assigned_at = CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END,
            status = $5,
            priority = coalesce($6, priority),
            sla_due_at = coalesce($7, sla_due_at),
            inquiry_category = coalesce($8, inquiry_category),
            updated_at = now()
      WHERE id = $1 AND clinic_id = $2
      RETURNING *`,
    [
      id,
      clinicId,
      input.assignedTo,
      input.assignedBy,
      input.status,
      input.priority,
      input.slaDueAt,
      input.inquiryCategory,
    ],
  );
  return mapRequest(rows[0]!);
}

export async function escalateScientificRequest(
  client: PoolClient,
  clinicId: string,
  id: string,
  input: { escalatedBy: string; reason: string },
): Promise<ScientificRequest> {
  const { rows } = await client.query<ScientificRequestRow>(
    `UPDATE scientific_request
        SET escalation_level = escalation_level + 1,
            escalated_at = now(),
            escalated_by = $3,
            escalation_reason = $4,
            updated_at = now()
      WHERE id = $1 AND clinic_id = $2
      RETURNING *`,
    [id, clinicId, input.escalatedBy, input.reason],
  );
  return mapRequest(rows[0]!);
}

export async function closeScientificRequest(
  client: PoolClient,
  clinicId: string,
  id: string,
  status: ScientificRequest['status'],
): Promise<ScientificRequest> {
  const { rows } = await client.query<ScientificRequestRow>(
    `UPDATE scientific_request SET status = $3, updated_at = now()
      WHERE id = $1 AND clinic_id = $2
      RETURNING *`,
    [id, clinicId, status],
  );
  return mapRequest(rows[0]!);
}

export interface RequestListFilter {
  hcpId: string | null;
  status: string | null;
  assignedTo: string | null;
  inquiryCategory: string | null;
  priority: string | null;
  /** Only requests whose service level has already been missed. */
  breachedOnly: boolean;
  territoryIds: string[] | null;
  limit: number;
}

export async function listScientificRequests(
  clinicId: string,
  filter: RequestListFilter,
  runner: Runner = getPool(),
): Promise<ScientificRequest[]> {
  // An empty territory scope means "nothing", never "everything".
  if (filter.territoryIds !== null && filter.territoryIds.length === 0) return [];
  const { rows } = await runner.query<ScientificRequestRow>(
    `SELECT sr.* FROM scientific_request sr
      WHERE sr.clinic_id = $1
        AND ($2::uuid IS NULL OR sr.hcp_id = $2)
        AND ($3::text IS NULL OR sr.status = $3)
        AND ($4::uuid[] IS NULL OR EXISTS (
              SELECT 1 FROM hcp_territory ht
               WHERE ht.hcp_id = sr.hcp_id AND ht.territory_id = ANY($4)))
        AND ($5::uuid IS NULL OR sr.assigned_to = $5)
        AND ($6::text IS NULL OR sr.inquiry_category = $6)
        AND ($7::text IS NULL OR sr.priority = $7)
        AND (NOT $8::boolean
             OR (sr.status IN ('open', 'in_review')
                 AND sr.sla_due_at IS NOT NULL
                 AND sr.sla_due_at < now()))
      ORDER BY sr.created_at DESC
      LIMIT $9`,
    [
      clinicId,
      filter.hcpId,
      filter.status,
      filter.territoryIds,
      filter.assignedTo,
      filter.inquiryCategory,
      filter.priority,
      filter.breachedOnly,
      filter.limit,
    ],
  );
  return rows.map(mapRequest);
}

// --- the append-only trail ---------------------------------------------------

export interface RequestEvent {
  id: string;
  requestId: string;
  eventType:
    | 'created'
    | 'assigned'
    | 'status_changed'
    | 'escalated'
    | 'answered'
    | 'closed'
    | 'reopened';
  fromStatus: ScientificRequest['status'] | null;
  toStatus: ScientificRequest['status'] | null;
  reason: string | null;
  detail: Record<string, unknown>;
  actorId: string | null;
  occurredAt: string;
}

export async function insertRequestEvent(
  runner: Runner,
  input: {
    clinicId: string;
    requestId: string;
    eventType: RequestEvent['eventType'];
    fromStatus: ScientificRequest['status'] | null;
    toStatus: ScientificRequest['status'] | null;
    reason: string | null;
    detail?: Record<string, unknown>;
    actorId: string | null;
  },
): Promise<void> {
  await runner.query(
    `INSERT INTO scientific_request_event
       (clinic_id, request_id, event_type, from_status, to_status, reason, detail, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.clinicId,
      input.requestId,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.reason,
      JSON.stringify(input.detail ?? {}),
      input.actorId,
    ],
  );
}

export async function listRequestEvents(
  clinicId: string,
  requestId: string,
  runner: Runner = getPool(),
): Promise<RequestEvent[]> {
  const { rows } = await runner.query<{
    id: string;
    request_id: string;
    event_type: RequestEvent['eventType'];
    from_status: ScientificRequest['status'] | null;
    to_status: ScientificRequest['status'] | null;
    reason: string | null;
    detail: Record<string, unknown>;
    actor_id: string | null;
    occurred_at: string;
  }>(
    `SELECT id::text AS id, request_id, event_type, from_status, to_status,
            reason, detail, actor_id, occurred_at
       FROM scientific_request_event
      WHERE clinic_id = $1 AND request_id = $2
      ORDER BY occurred_at, id`,
    [clinicId, requestId],
  );
  return rows.map((row) => ({
    id: row.id,
    requestId: row.request_id,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    detail: row.detail,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
  }));
}
