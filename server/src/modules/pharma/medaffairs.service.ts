import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { hasPermission, requirePermission, type Principal } from '../governance/rbac.js';
import { assertHcpOpen, getHcpById } from '../hcp/hcp.repo.js';
import * as content from './content.repo.js';
import { isUsable } from './content.service.js';
import { today } from './dates.js';
import * as field from './field.repo.js';
import { assertFreeTextClean } from './guards.js';
import * as repo from './medaffairs.repo.js';
import {
  assertAnswerable,
  assertEscalatable,
  assertRequestTransition,
  edgeRequiresReason,
  isBreached,
  slaDueAt,
  type RequestPriority,
  RequestStatus,
} from './request-lifecycle.js';
import { assertHcpInScope, territoryScopeFor } from './visibility.js';

/**
 * MEDICAL AFFAIRS — the scientific (medical-information) request lifecycle
 * (migrations 0302 / 0310).
 *
 * The field asks; medical affairs answers. Four rules govern that exchange, and
 * all four are enforced here rather than at the call sites:
 *
 *  1. **Separation of duties.** The person who raised a question never answers
 *     it. A representative answering their own question would be making an
 *     unreviewed medical claim on the company's behalf — the whole reason the
 *     question is routed to medical affairs at all.
 *  2. **An answer cites something real.** It carries a written summary or
 *     approved content that is inside its validity window today. Expired
 *     content is not an answer.
 *  3. **A refusal says why.** Declining to answer a clinician is a decision
 *     someone must be able to review.
 *  4. **Everything is remembered.** Every assignment, transition, escalation
 *     and answer lands in `scientific_request_event`, which refuses UPDATE and
 *     DELETE at the database.
 *
 * GOVERNANCE (§45): a scientific request is about a MEDICINE. The question text
 * is screened for patient-identifier-shaped tokens before it is stored, and no
 * query here reaches a clinical table. Urgency travels; patient data does not.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const INQUIRY_CATEGORY = z.enum([
  'unclassified',
  'efficacy',
  'safety',
  'dosing_administration',
  'pharmacology',
  'interactions',
  'special_population',
  'formulation_stability',
  'regulatory',
  'health_economics',
  'other',
]);

const PRIORITY = z.enum(['routine', 'high', 'critical']);

const SOURCE_CHANNEL = z.enum([
  'field_visit',
  'email',
  'phone',
  'congress',
  'web_form',
  'medical_information_line',
  'other',
]);

export const ScientificRequestSchema = z.object({
  hcpId: z.string().uuid(),
  visitId: z.string().uuid().optional(),
  medicationId: z.string().uuid().optional(),
  requestType: z
    .enum(['efficacy', 'safety', 'dosing', 'interaction', 'availability', 'other'])
    .default('other'),
  question: z.string().trim().min(5).max(4000),
  urgency: z.enum(['routine', 'high']).default('routine'),
  /**
   * The medical classification of the question, distinct from `requestType`
   * (which is what the rep saw) and defaulting to `unclassified` — medical
   * affairs classifies it at triage rather than the system guessing.
   */
  inquiryCategory: INQUIRY_CATEGORY.default('unclassified'),
  priority: PRIORITY.default('routine'),
  sourceChannel: SOURCE_CHANNEL.default('field_visit'),
  dueDate: DATE.optional(),
});

export const TriageRequestSchema = z.object({
  /** `null` hands the request back to the queue — a legitimate un-assignment. */
  assignedTo: z.string().uuid().nullable(),
  inquiryCategory: INQUIRY_CATEGORY.optional(),
  priority: PRIORITY.optional(),
  note: z.string().trim().max(1000).optional(),
});

export const AnswerRequestSchema = z.object({
  decision: z.enum(['answer', 'reject', 'close']).default('answer'),
  answerSummary: z.string().trim().min(5).max(8000).optional(),
  answerContentId: z.string().uuid().optional(),
  /** Required when declining: an unexplained refusal is not reviewable. */
  reason: z.string().trim().min(4).max(1000).optional(),
});

export const EscalateRequestSchema = z.object({
  reason: z.string().trim().min(4).max(1000),
});

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Invalid ${what}`, parsed.error.flatten());
  return parsed.data;
}

/** The request plus whether it has missed its service level, computed on read. */
function withSla(request: repo.ScientificRequest) {
  return {
    ...request,
    slaBreached: isBreached(request.status as RequestStatus, request.slaDueAt),
  };
}

// --- raising a request -------------------------------------------------------

export async function createScientificRequest(principal: Principal, raw: unknown) {
  requirePermission(principal, Permission.SCIENTIFIC_REQUEST_WRITE);
  const input = parse(ScientificRequestSchema, raw, 'scientific request');
  assertFreeTextClean({ question: input.question });
  await assertHcpInScope(principal, input.hcpId);

  return withTransaction(async (client) => {
    const hcp = await getHcpById(principal.clinicId, input.hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');
    // Targeting, engagement and enquiries all attach NEW state to an identity;
    // a merged record has been resolved away and must not acquire any.
    assertHcpOpen(hcp);
    let callReportId: string | null = null;
    if (input.visitId) {
      const visit = await field.getVisitById(principal.clinicId, input.visitId, client);
      if (!visit) throw new NotFoundError('Visit');
      const report = await field.getCallReportByVisit(principal.clinicId, input.visitId);
      callReportId = report?.id ?? null;
    }

    const request = await repo.insertScientificRequest(client, {
      clinicId: principal.clinicId,
      hcpId: input.hcpId,
      visitId: input.visitId ?? null,
      callReportId,
      medicationId: input.medicationId ?? null,
      requestedBy: principal.userId,
      requestType: input.requestType,
      question: input.question,
      urgency: input.urgency,
      dueDate: input.dueDate ?? null,
      inquiryCategory: input.inquiryCategory,
      priority: input.priority,
      // The clock starts when the question is asked, not when someone picks it
      // up — otherwise an unattended queue would never breach its own SLA.
      slaDueAt: slaDueAt(input.priority as RequestPriority),
      sourceChannel: input.sourceChannel,
    });

    await repo.insertRequestEvent(client, {
      clinicId: principal.clinicId,
      requestId: request.id,
      eventType: 'created',
      fromStatus: null,
      toStatus: request.status,
      reason: null,
      detail: { priority: request.priority, sourceChannel: request.sourceChannel },
      actorId: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.SCIENTIFIC_REQUEST_CREATED,
      subjectType: 'scientific_request',
      subjectId: request.id,
      actorId: principal.userId,
      payload: {
        hcpId: input.hcpId,
        requestType: input.requestType,
        urgency: input.urgency,
        priority: request.priority,
        medicationId: input.medicationId ?? null,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'scientificrequest.create',
      targetType: 'scientific_request',
      targetId: request.id,
      metadata: { hcpId: input.hcpId, requestType: input.requestType },
    });
    return withSla(request);
  });
}

// --- reading -----------------------------------------------------------------

export const ListRequestQuerySchema = z.object({
  hcpId: z.string().uuid().optional(),
  status: z.enum(['open', 'in_review', 'answered', 'closed', 'rejected']).optional(),
  assignedTo: z.string().uuid().optional(),
  /** `me` resolves to the caller, so a queue view needs no id round-trip. */
  mine: z.coerce.boolean().optional(),
  inquiryCategory: INQUIRY_CATEGORY.optional(),
  priority: PRIORITY.optional(),
  breachedOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function listScientificRequests(principal: Principal, rawQuery: unknown) {
  requirePermission(principal, Permission.SCIENTIFIC_REQUEST_READ);
  const query = parse(ListRequestQuerySchema, rawQuery ?? {}, 'scientific request query');
  const scope = await territoryScopeFor(principal);
  if (scope !== null && scope.length === 0) return [];

  const requests = await repo.listScientificRequests(principal.clinicId, {
    hcpId: query.hcpId ?? null,
    status: query.status ?? null,
    assignedTo: query.mine ? principal.userId : (query.assignedTo ?? null),
    inquiryCategory: query.inquiryCategory ?? null,
    priority: query.priority ?? null,
    breachedOnly: query.breachedOnly ?? false,
    territoryIds: scope,
    limit: query.limit,
  });
  return requests.map(withSla);
}

export async function getScientificRequestDetail(principal: Principal, requestId: string) {
  requirePermission(principal, Permission.SCIENTIFIC_REQUEST_READ);
  const request = await repo.getScientificRequest(principal.clinicId, requestId);
  if (!request) throw new NotFoundError('Scientific request');
  await assertHcpInScope(principal, request.hcpId);
  const events = await repo.listRequestEvents(principal.clinicId, requestId);
  return { request: withSla(request), events };
}

// --- triage ------------------------------------------------------------------

/**
 * Assign a request, classify it and set its priority.
 *
 * Triage belongs to medical affairs (`scientificrequest:fulfill`): deciding who
 * answers a clinical question, and how urgently, is part of answering it. The
 * assignee must hold the same permission — routing a medical question to
 * someone who cannot answer it is not an assignment, it is a dead end.
 */
export async function triageScientificRequest(
  principal: Principal,
  requestId: string,
  raw: unknown,
) {
  requirePermission(principal, Permission.SCIENTIFIC_REQUEST_FULFILL);
  const input = parse(TriageRequestSchema, raw, 'triage');
  assertFreeTextClean({ note: input.note ?? null });

  return withTransaction(async (client) => {
    const request = await repo.getScientificRequestForUpdate(client, principal.clinicId, requestId);
    if (!request) throw new NotFoundError('Scientific request');

    const from = request.status as RequestStatus;
    // A finished request is out of triage: re-assigning an answered or closed
    // one would imply it is still open work.
    if (from === RequestStatus.ANSWERED || from === RequestStatus.CLOSED || from === RequestStatus.REJECTED) {
      throw new ConflictError(`A "${from}" request is no longer in triage`, { status: from });
    }
    // Assigning moves a queued request into review; handing it back returns it
    // to the queue. Both edges go through the same rule set as every other.
    const to = input.assignedTo ? RequestStatus.IN_REVIEW : RequestStatus.OPEN;
    if (from !== to) assertRequestTransition(from, to, input.note ?? null);

    if (input.assignedTo) {
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM app_user u
             JOIN user_role ur ON ur.user_id = u.id
             JOIN role_permission rp ON rp.role_id = ur.role_id
            WHERE u.id = $1 AND u.clinic_id = $2 AND rp.permission_key = $3
         ) AS ok`,
        [input.assignedTo, principal.clinicId, Permission.SCIENTIFIC_REQUEST_FULFILL],
      );
      if (!rows[0]!.ok) {
        throw new ValidationError(
          'The assignee cannot answer scientific requests; assign it to medical affairs.',
          { field: 'assignedTo' },
        );
      }
    }

    // A re-prioritised request gets a NEW service level measured from now: the
    // commitment changed, so the clock it is held to has to change with it.
    const priority = (input.priority ?? null) as RequestPriority | null;
    const updated = await repo.assignScientificRequest(client, principal.clinicId, requestId, {
      assignedTo: input.assignedTo,
      assignedBy: principal.userId,
      status: to,
      priority,
      slaDueAt: priority ? slaDueAt(priority) : null,
      inquiryCategory: input.inquiryCategory ?? null,
    });

    await repo.insertRequestEvent(client, {
      clinicId: principal.clinicId,
      requestId,
      eventType: 'assigned',
      fromStatus: from,
      toStatus: to,
      reason: input.note ?? null,
      detail: {
        assignedTo: input.assignedTo,
        priority: updated.priority,
        inquiryCategory: updated.inquiryCategory,
      },
      actorId: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.SCIENTIFIC_REQUEST_ASSIGNED,
      subjectType: 'scientific_request',
      subjectId: requestId,
      actorId: principal.userId,
      payload: { assignedTo: input.assignedTo, priority: updated.priority },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'scientificrequest.triage',
      targetType: 'scientific_request',
      targetId: requestId,
      metadata: { assignedTo: input.assignedTo, priority: updated.priority },
    });
    return withSla(updated);
  });
}

// --- answering ---------------------------------------------------------------

export async function answerScientificRequest(
  principal: Principal,
  requestId: string,
  raw: unknown,
) {
  requirePermission(principal, Permission.SCIENTIFIC_REQUEST_FULFILL);
  const input = parse(AnswerRequestSchema, raw, 'answer');
  if (input.decision === 'answer' && !input.answerSummary && !input.answerContentId) {
    throw new ValidationError('An answer must provide answerSummary or cite answerContentId');
  }
  assertFreeTextClean({
    answerSummary: input.answerSummary ?? null,
    reason: input.reason ?? null,
  });

  return withTransaction(async (client) => {
    const request = await repo.getScientificRequestForUpdate(client, principal.clinicId, requestId);
    if (!request) throw new NotFoundError('Scientific request');

    const from = request.status as RequestStatus;
    const to =
      input.decision === 'answer'
        ? RequestStatus.ANSWERED
        : input.decision === 'reject'
          ? RequestStatus.REJECTED
          : RequestStatus.CLOSED;
    assertRequestTransition(from, to, input.reason ?? null);
    // Separation of duties: checked for an ANSWER, not for a close — closing
    // your own withdrawn question is administration, answering it is not.
    if (to === RequestStatus.ANSWERED) {
      assertAnswerable(from, request.requestedBy, principal.userId);
    }

    if (input.answerContentId) {
      const cited = await content.getContentById(principal.clinicId, input.answerContentId, client);
      if (!cited) throw new NotFoundError('Cited content');
      if (!isUsable(cited, today())) {
        throw new ConflictError(
          'Cited content is not approved or is outside its validity window; a scientific answer must cite usable approved content',
        );
      }
    }

    // A bare close of an ALREADY-decided request writes no answer fields: the
    // decision of record is already there and must not be overwritten. A close
    // of a live request now carries a reason (see `edgeRequiresReason`), and
    // that reason IS the decision, so it is recorded like one.
    const houseKeepingClose =
      to === RequestStatus.CLOSED &&
      !input.answerSummary &&
      !input.answerContentId &&
      !edgeRequiresReason(from, to);
    const after = houseKeepingClose
      ? await repo.closeScientificRequest(client, principal.clinicId, requestId, to)
      : await repo.answerScientificRequest(client, principal.clinicId, requestId, {
          status: to,
          answerSummary: input.answerSummary ?? input.reason ?? null,
          answerContentId: input.answerContentId ?? null,
          answeredBy: principal.userId,
        });

    await repo.insertRequestEvent(client, {
      clinicId: principal.clinicId,
      requestId,
      eventType: to === RequestStatus.ANSWERED ? 'answered' : 'status_changed',
      fromStatus: from,
      toStatus: to,
      reason: input.reason ?? null,
      detail: { citedContentId: input.answerContentId ?? null },
      actorId: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.SCIENTIFIC_REQUEST_ANSWERED,
      subjectType: 'scientific_request',
      subjectId: requestId,
      actorId: principal.userId,
      payload: { status: to, citedContentId: input.answerContentId ?? null },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'scientificrequest.answer',
      targetType: 'scientific_request',
      targetId: requestId,
      metadata: { status: to },
    });
    return withSla(after);
  });
}

// --- escalation --------------------------------------------------------------

/**
 * Escalate a request whose service level has been missed.
 *
 * Open to anyone who may READ the request — the representative waiting on the
 * answer is exactly the person who notices it is late, and making escalation a
 * medical-affairs-only action would mean the team that missed the SLA is the
 * only team that can say so.
 */
export async function escalateScientificRequest(
  principal: Principal,
  requestId: string,
  raw: unknown,
) {
  requirePermission(principal, Permission.SCIENTIFIC_REQUEST_READ);
  const input = parse(EscalateRequestSchema, raw, 'escalation');
  assertFreeTextClean({ reason: input.reason });

  return withTransaction(async (client) => {
    const request = await repo.getScientificRequestForUpdate(client, principal.clinicId, requestId);
    if (!request) throw new NotFoundError('Scientific request');
    await assertHcpInScope(principal, request.hcpId);
    // Escalation is not a mood: only a live request that has actually missed
    // its commitment may be escalated, or the signal means nothing.
    assertEscalatable(request.status as RequestStatus, request.slaDueAt);

    const updated = await repo.escalateScientificRequest(client, principal.clinicId, requestId, {
      escalatedBy: principal.userId,
      reason: input.reason,
    });

    await repo.insertRequestEvent(client, {
      clinicId: principal.clinicId,
      requestId,
      eventType: 'escalated',
      fromStatus: request.status,
      toStatus: request.status,
      reason: input.reason,
      detail: { escalationLevel: updated.escalationLevel },
      actorId: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.SCIENTIFIC_REQUEST_ESCALATED,
      subjectType: 'scientific_request',
      subjectId: requestId,
      actorId: principal.userId,
      payload: { escalationLevel: updated.escalationLevel, slaDueAt: updated.slaDueAt },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'scientificrequest.escalate',
      targetType: 'scientific_request',
      targetId: requestId,
      metadata: { escalationLevel: updated.escalationLevel },
    });
    return withSla(updated);
  });
}

// --- the medical-information queue ------------------------------------------

/**
 * The medical-affairs workload: what is unassigned, what is mine, what has
 * already missed its service level.
 *
 * Counts only — no question text — so the queue can be watched without every
 * viewer reading every clinician's enquiry.
 */
export async function medicalInformationQueue(principal: Principal) {
  requirePermission(principal, Permission.SCIENTIFIC_REQUEST_READ);
  if (!hasPermission(principal, Permission.SCIENTIFIC_REQUEST_FULFILL)) {
    throw new ForbiddenError('The medical-information queue belongs to medical affairs');
  }

  const [open, mine, breached] = await Promise.all([
    repo.listScientificRequests(principal.clinicId, {
      hcpId: null,
      status: 'open',
      assignedTo: null,
      inquiryCategory: null,
      priority: null,
      breachedOnly: false,
      territoryIds: null,
      limit: 200,
    }),
    repo.listScientificRequests(principal.clinicId, {
      hcpId: null,
      status: null,
      assignedTo: principal.userId,
      inquiryCategory: null,
      priority: null,
      breachedOnly: false,
      territoryIds: null,
      limit: 200,
    }),
    repo.listScientificRequests(principal.clinicId, {
      hcpId: null,
      status: null,
      assignedTo: null,
      inquiryCategory: null,
      priority: null,
      breachedOnly: true,
      territoryIds: null,
      limit: 200,
    }),
  ]);

  const byCategory: Record<string, number> = {};
  for (const request of [...open, ...mine]) {
    byCategory[request.inquiryCategory] = (byCategory[request.inquiryCategory] ?? 0) + 1;
  }

  return {
    unassigned: open.filter((r) => r.assignedTo === null).length,
    assignedToMe: mine.filter((r) => r.status === 'open' || r.status === 'in_review').length,
    breached: breached.length,
    escalated: breached.filter((r) => r.escalationLevel > 0).length,
    byCategory,
    asOf: new Date().toISOString(),
  };
}
