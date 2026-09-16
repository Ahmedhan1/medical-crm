import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { hasPermission, requirePermission, type Principal } from '../governance/rbac.js';
import { getHcoById } from '../hcp/hco.repo.js';
import { getHcpById, listHcpSpecialties, listInterests } from '../hcp/hcp.repo.js';
import * as content from './content.repo.js';
import { isUsable } from './content.service.js';
import * as repo from './field.repo.js';
import * as medaffairs from './medaffairs.repo.js';
import { today } from './dates.js';
import { assertFreeTextClean } from './guards.js';
import { subordinateUserIds } from './hierarchy.js';
import { territoriesForHcp } from './territory.repo.js';
import { assertHcpInScope, territoryScopeFor } from './visibility.js';
import {
  assertVisitTransition,
  VISIT_MODALITIES,
  type VisitStatus,
} from './visit-lifecycle.js';

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

export const PlanVisitSchema = z
  .object({
    /** Omitted for an INSTITUTIONAL call, which has an organisation as subject. */
    hcpId: z.string().uuid().optional(),
    plannedAt: z.string().datetime({ offset: true }),
    visitType: z.enum(['detail', 'follow_up', 'scientific', 'courtesy', 'event']).default('detail'),
    /** HOW the call happens, independent of why. Compliance reporting needs both. */
    modality: z.enum(VISIT_MODALITIES as unknown as [string, ...string[]]).default('face_to_face'),
    territoryId: z.string().uuid().optional(),
    hcoId: z.string().uuid().optional(),
    practiceLocationId: z.string().uuid().optional(),
    objective: z.string().trim().max(1000).optional(),
    /** Managers may plan on behalf of a rep; a rep may only plan for themselves. */
    repUserId: z.string().uuid().optional(),
  })
  // Mirrors the `visit_has_subject` CHECK: a call with neither a professional
  // nor an organisation is not a call, it is a diary entry.
  .refine((v) => v.hcpId !== undefined || v.hcoId !== undefined, {
    message: 'A visit needs a subject: provide hcpId, hcoId, or both',
    path: ['hcpId'],
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
  // Territory scope applies to the professional. An institutional call has no
  // professional subject, so it is scoped by the organisation's territory below.
  if (input.hcpId) await assertHcpInScope(principal, input.hcpId);

  const isManager = hasPermission(principal, Permission.TERRITORY_MANAGE);
  const repUserId = input.repUserId ?? principal.userId;
  if (repUserId !== principal.userId && !isManager) {
    throw new ForbiddenError('Only a territory manager can plan a visit for another representative');
  }

  return withTransaction(async (client) => {
    if (input.hcpId) {
      const hcp = await getHcpById(principal.clinicId, input.hcpId, client);
      if (!hcp) throw new NotFoundError('HCP');
      if (hcp.status === 'merged') {
        throw new ConflictError('This HCP record was merged; plan against the surviving record', {
          mergedIntoHcpId: hcp.mergedIntoHcpId,
        });
      }
    }
    if (input.hcoId) {
      const { rows: hco } = await client.query<{ operating_status: string }>(
        `SELECT operating_status FROM hco WHERE id = $1 AND clinic_id = $2`,
        [input.hcoId, principal.clinicId],
      );
      if (hco.length === 0) throw new NotFoundError('HCO');
      if (hco[0]!.operating_status === 'merged') {
        throw new ConflictError(
          'This organisation record was merged; plan against the surviving record',
        );
      }
    }
    const { rows } = await client.query(`SELECT 1 FROM app_user WHERE id = $1 AND clinic_id = $2`, [
      repUserId,
      principal.clinicId,
    ]);
    if (rows.length === 0) throw new NotFoundError('Representative');

    // Default the territory so a visit is always attributable to one for later
    // aggregation: from the HCP's targeting, or — for an institutional call —
    // from the organisation's own sites.
    let territoryId = input.territoryId ?? null;
    if (!territoryId && input.hcpId) {
      const territories = await territoriesForHcp(principal.clinicId, input.hcpId);
      territoryId = territories[0]?.territoryId ?? null;
    }
    if (!territoryId && input.hcoId) {
      const { rows: sites } = await client.query<{ territory_id: string }>(
        `SELECT territory_id FROM hco_location
          WHERE clinic_id = $1 AND hco_id = $2 AND territory_id IS NOT NULL
          ORDER BY is_primary DESC
          LIMIT 1`,
        [principal.clinicId, input.hcoId],
      );
      territoryId = sites[0]?.territory_id ?? null;
    }

    const visit = await repo.insertVisit(client, {
      clinicId: principal.clinicId,
      hcpId: input.hcpId ?? null,
      territoryId,
      hcoId: input.hcoId ?? null,
      practiceLocationId: input.practiceLocationId ?? null,
      repUserId,
      visitType: input.visitType,
      modality: input.modality as repo.Visit['modality'],
      plannedAt: input.plannedAt,
      objective: input.objective ?? null,
      createdBy: principal.userId,
    });

    await repo.insertVisitEvent(client, {
      clinicId: principal.clinicId,
      visitId: visit.id,
      fromStatus: null,
      toStatus: visit.status,
      reason: null,
      actorId: principal.userId,
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
  hcoId?: string;
  status?: string;
  modality?: string;
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
  // A representative sees their own calls; a clinic-wide principal sees all of
  // them (or only their own, on request).
  const repUserId = scope === null ? (params.mineOnly ? principal.userId : null) : principal.userId;
  // For a scoped principal OWNERSHIP is the scope, and it is the stronger one:
  // every visit returned is already theirs. Also filtering by territory could
  // only subtract from that — and did, silently hiding an institutional call
  // whose organisation has no sited location, i.e. a rep's own work.
  return repo.listVisits(principal.clinicId, {
    repUserId,
    hcpId: params.hcpId ?? null,
    hcoId: params.hcoId ?? null,
    territoryIds: null,
    status: (params.status as never) ?? null,
    modality: (params.modality as never) ?? null,
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
    hcoId: null,
    territoryIds: null,
    status: null,
    modality: null,
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
    // The whole rule set — legal edges, terminal states and "a negative outcome
    // must say why" — lives in `visit-lifecycle.ts`, so no caller can invent a
    // path between states and every edge is unit-testable without a database.
    assertVisitTransition(
      visit.status as VisitStatus,
      input.status as VisitStatus,
      input.reason ?? null,
    );

    const after = await repo.updateVisitStatus(client, principal.clinicId, visitId, {
      status: input.status,
      outcomeReason: input.reason ?? null,
    });
    await repo.insertVisitEvent(client, {
      clinicId: principal.clinicId,
      visitId,
      fromStatus: visit.status,
      toStatus: input.status,
      reason: input.reason ?? null,
      actorId: principal.userId,
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

/**
 * May this principal act on this visit?
 *
 * Three ways in, in order of how specific they are:
 *  1. it is their own call;
 *  2. the representative reports to them, directly or indirectly — the field
 *     hierarchy from `field_rep_profile`, walked with cycle and depth guards in
 *     `hierarchy.ts`. This is what lets a district manager supervise their own
 *     people WITHOUT a clinic-wide grant;
 *  3. they hold `territory:manage` — deliberately clinic-wide, because that
 *     permission owns the territory model itself. It is granted to
 *     PHARMA_MANAGER and never to a representative, and the trade-off is
 *     recorded in `docs/agent-state/agent-4.md` rather than left implicit.
 */
async function assertVisitOwnership(principal: Principal, visit: repo.Visit): Promise<void> {
  if (visit.repUserId === principal.userId) return;
  if (hasPermission(principal, Permission.TERRITORY_MANAGE)) return;
  const reports = await subordinateUserIds(principal.clinicId, principal.userId);
  if (reports.includes(visit.repUserId)) return;
  throw new ForbiddenError('This visit belongs to another representative');
}

/**
 * The status trail of a visit (0309).
 *
 * Scoped exactly like the visit itself — own call, a report's call, or a
 * `territory:manage` holder — so the history cannot be used to learn about
 * another representative's day.
 */
export async function visitHistory(
  principal: Principal,
  visitId: string,
): Promise<repo.VisitEvent[]> {
  requirePermission(principal, Permission.VISIT_READ);
  const visit = await repo.getVisitById(principal.clinicId, visitId);
  if (!visit) throw new NotFoundError('Visit');
  await assertVisitOwnership(principal, visit);
  return repo.listVisitEvents(principal.clinicId, visitId);
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
  const hcpId = visit.hcpId;
  if (hcpId) await assertHcpInScope(principal, hcpId);

  const hcp = hcpId ? await getHcpById(principal.clinicId, hcpId) : null;
  if (hcpId && !hcp) throw new NotFoundError('HCP');

  // An INSTITUTIONAL call has no professional subject, so the per-HCP sections
  // are empty rather than absent: the briefing keeps one shape, and a caller
  // never has to branch on which kind of call it is opening.
  const [specialties, interests, territories, recentCalls, openObjections, openRequests, followUps] =
    hcpId
      ? await Promise.all([
          listHcpSpecialties(principal.clinicId, hcpId),
          listInterests(principal.clinicId, hcpId),
          territoriesForHcp(principal.clinicId, hcpId),
          repo.listCallReportsForHcp(principal.clinicId, hcpId, 3),
          repo.listOpenObjectionsForHcp(principal.clinicId, hcpId, 10),
          medaffairs.listScientificRequests(principal.clinicId, {
            hcpId,
            status: 'open',
            assignedTo: null,
            inquiryCategory: null,
            priority: null,
            breachedOnly: false,
            territoryIds: null,
            limit: 10,
          }),
          repo.listFollowUps(principal.clinicId, {
            ownerUserId: null,
            hcpId,
            status: 'open',
            limit: 10,
          }),
        ])
      : ([[], [], [], [], [], [], []] as const);

  // Only content that is approved and inside its window today may be taken in.
  // With no professional subject the jurisdiction comes from the organisation's
  // own record, never guessed.
  let jurisdiction = hcp?.provenance.jurisdiction ?? null;
  if (!jurisdiction && visit.hcoId) {
    const hco = await getHcoById(principal.clinicId, visit.hcoId);
    jurisdiction = hco?.provenance.jurisdiction ?? null;
  }
  const usableContent = jurisdiction
    ? await content.listContent(principal.clinicId, {
        jurisdiction,
        medicationId: null,
        contentType: null,
        usableOnly: true,
        onDate: today(),
        limit: 20,
      })
    : [];

  return {
    visit,
    hcp: hcp
      ? {
          id: hcp.id,
          fullName: hcp.fullName,
          title: hcp.title,
          preferredLanguage: hcp.preferredLanguage,
          verificationStatus: hcp.provenance.verificationStatus,
          lastVerifiedAt: hcp.provenance.lastVerifiedAt,
          jurisdiction: hcp.provenance.jurisdiction,
        }
      : null,
    specialties,
    interests,
    territories,
    recentCalls,
    openObjections,
    openScientificRequests: openRequests,
    openFollowUps: followUps,
    statusHistory: await repo.listVisitEvents(principal.clinicId, visitId),
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
        hcoId: visit.hcoId,
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
        hcoId: visit.hcoId,
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
        hcoId: visit.hcoId,
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
        hcoId: visit.hcoId,
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

    // Submitting the report closes the visit. The lifecycle decides whether
    // that is legal, and the transition joins the same append-only trail as
    // every other one — a call that completed by being reported must not be
    // invisible in its own history.
    assertVisitTransition(visit.status as VisitStatus, 'completed', null);
    const now = new Date().toISOString();
    await repo.updateVisitStatus(client, principal.clinicId, visitId, {
      status: 'completed',
      startedAt: visit.startedAt ?? now,
      endedAt: now,
    });
    await repo.insertVisitEvent(client, {
      clinicId: principal.clinicId,
      visitId,
      fromStatus: visit.status,
      toStatus: 'completed',
      reason: null,
      actorId: principal.userId,
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
  if (visit.hcpId) await assertHcpInScope(principal, visit.hcpId);
  const report = await repo.getCallReportByVisit(principal.clinicId, visitId);
  if (!report) throw new NotFoundError('Call report');
  return report;
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
