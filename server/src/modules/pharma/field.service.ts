import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { hasPermission, requirePermission, type Principal } from '../governance/rbac.js';
import { getHcpById, listHcpSpecialties, listInterests } from '../hcp/hcp.repo.js';
import * as content from './content.repo.js';
import { isUsable } from './content.service.js';
import * as repo from './field.repo.js';
import { assertFreeTextClean } from './guards.js';
import { territoriesForHcp } from './territory.repo.js';
import { assertHcpInScope, territoryScopeFor } from './visibility.js';

/**
 * Medical-representative platform: visit planning, the day's calls, the
 * pre-visit briefing, call reporting, scientific requests and follow-ups.
 *
 * GOVERNANCE: the briefing is the place a "360 view" is most tempting to
 * over-fill. It contains HCP professional data, this company's own engagement
 * history, and approved content — and nothing else. There is no clinical query
 * in this file, and a rep can only reach an HCP inside their territory.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const TEXT = (max: number) => z.string().trim().min(1).max(max);

export const PlanVisitSchema = z.object({
  hcpId: z.string().uuid(),
  plannedAt: z.string().datetime({ offset: true }),
  visitType: z.enum(['detail', 'follow_up', 'scientific', 'courtesy', 'event']).default('detail'),
  territoryId: z.string().uuid().optional(),
  hcoId: z.string().uuid().optional(),
  practiceLocationId: z.string().uuid().optional(),
  objective: z.string().trim().max(1000).optional(),
  /** Managers may plan on behalf of a rep; a rep may only plan for themselves. */
  repUserId: z.string().uuid().optional(),
});

export const CloseVisitSchema = z.object({
  status: z.enum(['confirmed', 'cancelled', 'no_access']),
  reason: z.string().trim().max(500).optional(),
});

export const CallReportSchema = z.object({
  summary: TEXT(4000),
  hcpSentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']).default('unknown'),
  nextStep: z.string().trim().max(1000).optional(),
  followUpDate: DATE.optional(),
  products: z
    .array(
      z.object({
        medicationId: z.string().uuid().optional(),
        productLabel: z.string().trim().max(200).optional(),
        discussionOutcome: z
          .enum(['interested', 'not_interested', 'needs_info', 'objection', 'committed'])
          .default('needs_info'),
        notes: z.string().trim().max(1000).optional(),
      }),
    )
    .max(20)
    .default([]),
  objections: z
    .array(
      z.object({
        objectionType: z.enum([
          'efficacy',
          'safety',
          'cost',
          'availability',
          'guideline',
          'experience',
          'other',
        ]),
        objectionText: TEXT(1000),
        medicationId: z.string().uuid().optional(),
      }),
    )
    .max(20)
    .default([]),
  competitors: z
    .array(
      z.object({
        competitorName: TEXT(160),
        competitorProduct: z.string().trim().max(160).optional(),
        context: z.string().trim().max(1000).optional(),
        sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']).default('unknown'),
      }),
    )
    .max(20)
    .default([]),
  followUps: z
    .array(z.object({ action: TEXT(500), dueDate: DATE }))
    .max(10)
    .default([]),
});

export const ScientificRequestSchema = z.object({
  hcpId: z.string().uuid(),
  visitId: z.string().uuid().optional(),
  medicationId: z.string().uuid().optional(),
  requestType: z
    .enum(['clinical_data', 'safety_info', 'dosing', 'publication', 'formulation', 'other'])
    .default('other'),
  question: TEXT(2000),
  urgency: z.enum(['routine', 'high']).default('routine'),
  dueDate: DATE.optional(),
});

export const AnswerRequestSchema = z.object({
  decision: z.enum(['answer', 'reject', 'close']),
  answerSummary: z.string().trim().max(4000).optional(),
  answerContentId: z.string().uuid().optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Invalid ${what}`, parsed.error.flatten());
  return parsed.data;
}

// --- Visit planning ---------------------------------------------------------

export async function planVisit(principal: Principal, raw: unknown): Promise<repo.Visit> {
  requirePermission(principal, Permission.VISIT_PLAN);
  const input = parse(PlanVisitSchema, raw, 'visit');
  assertFreeTextClean({ objective: input.objective ?? null });
  await assertHcpInScope(principal, input.hcpId);

  const isManager = hasPermission(principal, Permission.TERRITORY_MANAGE);
  const repUserId = input.repUserId ?? principal.userId;
  if (repUserId !== principal.userId && !isManager) {
    throw new ForbiddenError('Only a territory manager can plan a visit for another representative');
  }

  return withTransaction(async (client) => {
    const hcp = await getHcpById(principal.clinicId, input.hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');
    if (hcp.status === 'merged') {
      throw new ConflictError('This HCP record was merged; plan against the surviving record', {
        mergedIntoHcpId: hcp.mergedIntoHcpId,
      });
    }
    const { rows } = await client.query(`SELECT 1 FROM app_user WHERE id = $1 AND clinic_id = $2`, [
      repUserId,
      principal.clinicId,
    ]);
    if (rows.length === 0) throw new NotFoundError('Representative');

    // Default the territory from the HCP's targeting so a visit is always
    // attributable to a territory for later aggregation.
    let territoryId = input.territoryId ?? null;
    if (!territoryId) {
      const territories = await territoriesForHcp(principal.clinicId, input.hcpId);
      territoryId = territories[0]?.territoryId ?? null;
    }

    const visit = await repo.insertVisit(client, {
      clinicId: principal.clinicId,
      hcpId: input.hcpId,
      territoryId,
      hcoId: input.hcoId ?? null,
      practiceLocationId: input.practiceLocationId ?? null,
      repUserId,
      visitType: input.visitType,
      plannedAt: input.plannedAt,
      objective: input.objective ?? null,
      createdBy: principal.userId,
    });

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.VISIT_PLANNED,
      subjectType: 'visit',
      subjectId: visit.id,
      actorId: principal.userId,
      payload: { hcpId: visit.hcpId, visitType: visit.visitType, territoryId },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'visit.plan',
      targetType: 'visit',
      targetId: visit.id,
      metadata: { hcpId: visit.hcpId, repUserId },
    });
    return visit;
  });
}

export interface ListVisitsParams {
  hcpId?: string;
  status?: string;
  from?: string;
  to?: string;
  mineOnly?: boolean;
  limit?: number;
}

export async function listVisits(
  principal: Principal,
  params: ListVisitsParams,
): Promise<repo.Visit[]> {
  requirePermission(principal, Permission.VISIT_READ);
  const scope = await territoryScopeFor(principal);
  if (scope !== null && scope.length === 0) return [];
  // A representative sees their own calls; a manager sees the territory.
  const repUserId = scope === null ? (params.mineOnly ? principal.userId : null) : principal.userId;
  return repo.listVisits(principal.clinicId, {
    repUserId,
    hcpId: params.hcpId ?? null,
    territoryIds: scope,
    status: (params.status as never) ?? null,
    from: params.from ?? null,
    to: params.to ?? null,
    limit: Math.min(Math.max(params.limit ?? 50, 1), 200),
  });
}

/** Today's calls for the signed-in representative, in planned order. */
export async function todaysVisits(principal: Principal): Promise<repo.Visit[]> {
  requirePermission(principal, Permission.VISIT_READ);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return repo.listVisits(principal.clinicId, {
    repUserId: principal.userId,
    hcpId: null,
    territoryIds: null,
    status: null,
    from: start.toISOString(),
    to: end.toISOString(),
    limit: 200,
  });
}

export async function updateVisitStatus(principal: Principal, visitId: string, raw: unknown) {
  requirePermission(principal, Permission.VISIT_PLAN);
  const input = parse(CloseVisitSchema, raw, 'visit status');

  return withTransaction(async (client) => {
    const visit = await repo.getVisitForUpdate(client, principal.clinicId, visitId);
    if (!visit) throw new NotFoundError('Visit');
    await assertVisitOwnership(principal, visit);
    if (visit.status === 'completed') {
      throw new ConflictError('A completed visit cannot change status; it has a call report');
    }

    const after = await repo.updateVisitStatus(client, principal.clinicId, visitId, {
      status: input.status,
      outcomeReason: input.reason ?? null,
    });
    if (input.status === 'cancelled' || input.status === 'no_access') {
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.VISIT_CANCELLED,
        subjectType: 'visit',
        subjectId: visitId,
        actorId: principal.userId,
        payload: { status: input.status },
      });
    }
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'visit.status',
      targetType: 'visit',
      targetId: visitId,
      metadata: { status: input.status },
    });
    return after;
  });
}

async function assertVisitOwnership(principal: Principal, visit: repo.Visit): Promise<void> {
  if (hasPermission(principal, Permission.TERRITORY_MANAGE)) return;
  if (visit.repUserId !== principal.userId) {
    throw new ForbiddenError('This visit belongs to another representative');
  }
}

// --- Pre-visit briefing -----------------------------------------------------

/**
 * Everything the representative needs before walking in — and, deliberately,
 * nothing else. No patient data of any kind participates in this view.
 */
export async function preVisitBriefing(principal: Principal, visitId: string) {
  requirePermission(principal, Permission.VISIT_READ);
  const visit = await repo.getVisitById(principal.clinicId, visitId);
  if (!visit) throw new NotFoundError('Visit');
  await assertHcpInScope(principal, visit.hcpId);

  const hcp = await getHcpById(principal.clinicId, visit.hcpId);
  if (!hcp) throw new NotFoundError('HCP');

  const [specialties, interests, territories, recentCalls, openObjections, openRequests, followUps] =
    await Promise.all([
      listHcpSpecialties(principal.clinicId, visit.hcpId),
      listInterests(principal.clinicId, visit.hcpId),
      territoriesForHcp(principal.clinicId, visit.hcpId),
      repo.listCallReportsForHcp(principal.clinicId, visit.hcpId, 3),
      repo.listOpenObjectionsForHcp(principal.clinicId, visit.hcpId, 10),
      repo.listScientificRequests(principal.clinicId, {
        hcpId: visit.hcpId,
        status: 'open',
        territoryIds: null,
        limit: 10,
      }),
      repo.listFollowUps(principal.clinicId, {
        ownerUserId: null,
        hcpId: visit.hcpId,
        status: 'open',
        limit: 10,
      }),
    ]);

  // Only content that is approved and inside its window today may be taken in.
  const usableContent = await content.listContent(principal.clinicId, {
    jurisdiction: hcp.provenance.jurisdiction,
    medicationId: null,
    contentType: null,
    usableOnly: true,
    onDate: new Date().toISOString().slice(0, 10),
    limit: 20,
  });

  return {
    visit,
    hcp: {
      id: hcp.id,
      fullName: hcp.fullName,
      title: hcp.title,
      preferredLanguage: hcp.preferredLanguage,
      verificationStatus: hcp.provenance.verificationStatus,
      lastVerifiedAt: hcp.provenance.lastVerifiedAt,
      jurisdiction: hcp.provenance.jurisdiction,
    },
    specialties,
    interests,
    territories,
    recentCalls,
    openObjections,
    openScientificRequests: openRequests,
    openFollowUps: followUps,
    approvedContent: usableContent.map((c) => ({
      id: c.id,
      title: c.title,
      version: c.version,
      contentType: c.contentType,
      expiryDate: c.expiryDate,
    })),
    dataBoundary:
      'HCP professional and engagement data only. This briefing contains no patient data by design (§45).',
  };
}

// --- Call report ------------------------------------------------------------

export async function submitCallReport(principal: Principal, visitId: string, raw: unknown) {
  requirePermission(principal, Permission.CALL_REPORT_WRITE);
  const input = parse(CallReportSchema, raw, 'call report');

  // Everything a human typed is screened before it can be stored.
  assertFreeTextClean({ summary: input.summary, nextStep: input.nextStep ?? null });
  input.objections.forEach((o, i) =>
    assertFreeTextClean({ [`objections[${i}].objectionText`]: o.objectionText }),
  );
  input.products.forEach((p, i) => assertFreeTextClean({ [`products[${i}].notes`]: p.notes ?? null }));
  input.competitors.forEach((c, i) =>
    assertFreeTextClean({ [`competitors[${i}].context`]: c.context ?? null }),
  );
  input.followUps.forEach((f, i) => assertFreeTextClean({ [`followUps[${i}].action`]: f.action }));

  return withTransaction(async (client) => {
    const visit = await repo.getVisitForUpdate(client, principal.clinicId, visitId);
    if (!visit) throw new NotFoundError('Visit');
    await assertVisitOwnership(principal, visit);
    if (visit.status === 'cancelled') {
      throw new ConflictError('A cancelled visit cannot carry a call report');
    }

    let report;
    try {
      report = await repo.insertCallReport(client, {
        clinicId: principal.clinicId,
        visitId,
        hcpId: visit.hcpId,
        repUserId: visit.repUserId,
        summary: input.summary,
        hcpSentiment: input.hcpSentiment,
        nextStep: input.nextStep ?? null,
        followUpDate: input.followUpDate ?? null,
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('This visit already has a call report');
      }
      throw err;
    }

    for (const product of input.products) {
      if (!product.medicationId && !product.productLabel) {
        throw new ValidationError('Each discussed product needs a medicationId or a productLabel');
      }
      if (product.medicationId) {
        const { rows } = await client.query(
          `SELECT 1 FROM medication WHERE id = $1 AND clinic_id = $2`,
          [product.medicationId, principal.clinicId],
        );
        if (rows.length === 0) throw new NotFoundError('Medication');
      }
      await repo.insertCallReportProduct(client, {
        clinicId: principal.clinicId,
        callReportId: report.id,
        medicationId: product.medicationId ?? null,
        productLabel: product.productLabel ?? null,
        discussionOutcome: product.discussionOutcome,
        notes: product.notes ?? null,
      });
    }

    for (const objection of input.objections) {
      await repo.insertObjection(client, {
        clinicId: principal.clinicId,
        callReportId: report.id,
        hcpId: visit.hcpId,
        medicationId: objection.medicationId ?? null,
        objectionType: objection.objectionType,
        objectionText: objection.objectionText,
      });
    }

    for (const competitor of input.competitors) {
      await repo.insertCompetitorMention(client, {
        clinicId: principal.clinicId,
        callReportId: report.id,
        hcpId: visit.hcpId,
        competitorName: competitor.competitorName,
        competitorProduct: competitor.competitorProduct ?? null,
        context: competitor.context ?? null,
        sentiment: competitor.sentiment,
      });
    }

    const followUps = [];
    for (const followUp of input.followUps) {
      const created = await repo.insertFollowUp(client, {
        clinicId: principal.clinicId,
        hcpId: visit.hcpId,
        visitId,
        callReportId: report.id,
        ownerUserId: visit.repUserId,
        action: followUp.action,
        dueDate: followUp.dueDate,
        createdBy: principal.userId,
      });
      followUps.push(created);
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.FOLLOW_UP_CREATED,
        subjectType: 'follow_up_action',
        subjectId: created.id,
        actorId: principal.userId,
        payload: { hcpId: visit.hcpId, dueDate: created.dueDate },
      });
    }

    // Submitting the report closes the visit.
    const now = new Date().toISOString();
    await repo.updateVisitStatus(client, principal.clinicId, visitId, {
      status: 'completed',
      startedAt: visit.startedAt ?? now,
      endedAt: now,
    });

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.CALL_REPORT_SUBMITTED,
      subjectType: 'call_report',
      subjectId: report.id,
      actorId: principal.userId,
      payload: {
        visitId,
        hcpId: visit.hcpId,
        sentiment: report.hcpSentiment,
        objections: input.objections.length,
        products: input.products.length,
      },
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.VISIT_COMPLETED,
      subjectType: 'visit',
      subjectId: visitId,
      actorId: principal.userId,
      payload: { hcpId: visit.hcpId, territoryId: visit.territoryId },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'callreport.submit',
      targetType: 'call_report',
      targetId: report.id,
      metadata: { visitId, hcpId: visit.hcpId },
    });

    return { ...report, followUps };
  });
}

export async function getCallReport(principal: Principal, visitId: string) {
  requirePermission(principal, Permission.CALL_REPORT_READ);
  const visit = await repo.getVisitById(principal.clinicId, visitId);
  if (!visit) throw new NotFoundError('Visit');
  await assertHcpInScope(principal, visit.hcpId);
  const report = await repo.getCallReportByVisit(principal.clinicId, visitId);
  if (!report) throw new NotFoundError('Call report');
  return report;
}

// --- Scientific requests ----------------------------------------------------

export async function createScientificRequest(principal: Principal, raw: unknown) {
  requirePermission(principal, Permission.SCIENTIFIC_REQUEST_WRITE);
  const input = parse(ScientificRequestSchema, raw, 'scientific request');
  assertFreeTextClean({ question: input.question });
  await assertHcpInScope(principal, input.hcpId);

  return withTransaction(async (client) => {
    const hcp = await getHcpById(principal.clinicId, input.hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');
    let callReportId: string | null = null;
    if (input.visitId) {
      const visit = await repo.getVisitById(principal.clinicId, input.visitId, client);
      if (!visit) throw new NotFoundError('Visit');
      const report = await repo.getCallReportByVisit(principal.clinicId, input.visitId);
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
    return request;
  });
}

export async function listScientificRequests(
  principal: Principal,
  params: { hcpId?: string; status?: string; limit?: number },
) {
  requirePermission(principal, Permission.SCIENTIFIC_REQUEST_READ);
  const scope = await territoryScopeFor(principal);
  if (scope !== null && scope.length === 0) return [];
  return repo.listScientificRequests(principal.clinicId, {
    hcpId: params.hcpId ?? null,
    status: params.status ?? null,
    territoryIds: scope,
    limit: Math.min(Math.max(params.limit ?? 50, 1), 200),
  });
}

/**
 * Answer a scientific request. Medical affairs only (`scientificrequest:fulfill`)
 * — the representative who raised the question cannot answer it, and an answer
 * must cite approved content or a written summary.
 */
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
  assertFreeTextClean({ answerSummary: input.answerSummary ?? null });

  return withTransaction(async (client) => {
    const request = await repo.getScientificRequest(principal.clinicId, requestId, client);
    if (!request) throw new NotFoundError('Scientific request');
    if (request.status === 'answered' || request.status === 'closed') {
      throw new ConflictError(`This request is already ${request.status}`);
    }

    if (input.answerContentId) {
      const cited = await content.getContentById(principal.clinicId, input.answerContentId, client);
      if (!cited) throw new NotFoundError('Cited content');
      if (!isUsable(cited, new Date().toISOString().slice(0, 10))) {
        throw new ConflictError(
          'Cited content is not approved or is outside its validity window; a scientific answer must cite usable approved content',
        );
      }
    }

    const status =
      input.decision === 'answer' ? 'answered' : input.decision === 'reject' ? 'rejected' : 'closed';
    const after = await repo.answerScientificRequest(client, principal.clinicId, requestId, {
      status,
      answerSummary: input.answerSummary ?? null,
      answerContentId: input.answerContentId ?? null,
      answeredBy: principal.userId,
    });

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.SCIENTIFIC_REQUEST_ANSWERED,
      subjectType: 'scientific_request',
      subjectId: requestId,
      actorId: principal.userId,
      payload: { status, citedContentId: input.answerContentId ?? null },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'scientificrequest.answer',
      targetType: 'scientific_request',
      targetId: requestId,
      metadata: { status },
    });
    return after;
  });
}

// --- Follow-up actions ------------------------------------------------------

export async function listFollowUps(
  principal: Principal,
  params: { hcpId?: string; status?: string; limit?: number },
) {
  requirePermission(principal, Permission.VISIT_READ);
  const scope = await territoryScopeFor(principal);
  return repo.listFollowUps(principal.clinicId, {
    ownerUserId: scope === null ? null : principal.userId,
    hcpId: params.hcpId ?? null,
    status: params.status ?? 'open',
    limit: Math.min(Math.max(params.limit ?? 50, 1), 200),
  });
}

export async function completeFollowUp(principal: Principal, followUpId: string) {
  requirePermission(principal, Permission.CALL_REPORT_WRITE);
  return withTransaction(async (client) => {
    const done = await repo.completeFollowUp(
      client,
      principal.clinicId,
      followUpId,
      principal.userId,
    );
    if (!done) {
      throw new NotFoundError('Open follow-up action owned by you');
    }
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.FOLLOW_UP_COMPLETED,
      subjectType: 'follow_up_action',
      subjectId: done.id,
      actorId: principal.userId,
      payload: { hcpId: done.hcpId },
    });
    return done;
  });
}
