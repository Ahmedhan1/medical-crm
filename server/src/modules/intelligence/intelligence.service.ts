import { z } from 'zod';
import { getPool, withTransaction } from '../../db/pool.js';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { audit, auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { hasPermission, requirePermission, type Principal } from '../governance/rbac.js';
import { assertFreeTextClean } from '../pharma/guards.js';
import { JurisdictionSchema } from '../pharma/provenance.js';
import { territoryScopeFor } from '../pharma/visibility.js';
import { applyDisclosureControl } from './disclosure.js';
import {
  ABSOLUTE_MIN_COHORT,
  runFirewall,
  type FirewallRequest,
} from './firewall.js';
import { decideQuery, type QuerySlice } from './query-governance.js';
import {
  assertNotSelfApproval,
  assertTransition as assertSignalTransition,
  isApprovalDecision,
  SIGNAL_LIFECYCLE_STATES,
  SignalDecision,
  SignalLifecycle,
  signalExpiryFrom,
  targetStateFor,
} from './signal-lifecycle.js';
import * as repo from './signals.repo.js';
import { getSource, listSources } from './sources.js';

/**
 * Healthcare intelligence service — STAGE 2 (authorization) plus orchestration.
 *
 * Reading and producing are separate permissions on purpose:
 *  - `intelligence:signal-read` returns already-published, threshold-gated
 *    signals. It is what a pharma user holds.
 *  - `intelligence:publish` runs the pipeline. It is a governance action (the
 *    operator decides what may be derived and published), so a representative
 *    does not hold it.
 *
 * Suppression is recorded, never surfaced as data: an `intelligence_run` row
 * counts suppressed cohorts for the operator's own audit, while the API response
 * reports only how many were suppressed in that run — never which, nor how
 * large they were. Telling a caller "this cohort had 3 members" would leak the
 * very thing the threshold protects.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * A request refused by query governance (budget or narrowing depth).
 *
 * 429 rather than 403: the principal holds the permission, and the same request
 * may succeed once the window rolls forward. The body names the control so an
 * analyst can tell "you may not" from "not this often, this finely".
 */
export class QueryGovernanceError extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super(429, 'intelligence_query_governance', message, details);
  }
}

/**
 * The policy used when an operator has not defined one. Safe by default: the
 * absolute minimum cohort, territory precision, de-identification required.
 */
export const DEFAULT_POLICY_KEY = 'default';

export function defaultPolicy(jurisdiction: string): repo.GovernancePolicy {
  return {
    key: DEFAULT_POLICY_KEY,
    jurisdiction,
    minCohortSize: ABSOLUTE_MIN_COHORT,
    maxPrecision: 'territory',
    requiresDeidentification: true,
    allowedSignalTypes: [],
    // Query governance and disclosure control (0305). These mirror the column
    // defaults, so an operator who never defines a policy is still protected.
    maxQueriesPerWindow: 30,
    queryWindowHours: 24,
    maxNarrowingDepth: 2,
    valueRoundingBase: 5,
    complementarySuppression: true,
  };
}

export const RunPipelineSchema = z.object({
  sourceKind: z.enum(['pharma_field', 'clinical_governed']).default('pharma_field'),
  signalType: z.string().trim().min(2).max(60),
  periodStart: DATE,
  periodEnd: DATE,
  jurisdiction: JurisdictionSchema,
  scopeType: z
    .enum(['territory', 'region', 'country', 'therapeutic_area', 'product', 'global'])
    .default('territory'),
  aggregationLevel: z.enum(['hcp_group', 'territory', 'region', 'country']).default('territory'),
  policyKey: z.string().trim().min(1).max(60).default(DEFAULT_POLICY_KEY),
  territoryIds: z.array(z.string().uuid()).max(100).optional(),
});

export const UpsertPolicySchema = z.object({
  key: z.string().trim().min(1).max(60),
  description: z.string().trim().min(2).max(500),
  jurisdiction: JurisdictionSchema,
  minCohortSize: z.number().int().min(ABSOLUTE_MIN_COHORT).max(1000),
  maxPrecision: z.enum(['territory', 'region', 'country']).default('territory'),
  allowedSignalTypes: z.array(z.string().trim().min(2).max(60)).max(50).default([]),
  // Query governance. The bounds mirror the CHECK constraints in 0305 so the
  // protection cannot be configured away through the API either.
  maxQueriesPerWindow: z.number().int().min(1).max(1000).default(30),
  queryWindowHours: z.number().int().min(1).max(720).default(24),
  maxNarrowingDepth: z.number().int().min(0).max(10).default(2),
  valueRoundingBase: z.number().int().min(1).max(100).default(5),
});

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Invalid ${what}`, parsed.error.flatten());
  return parsed.data;
}

export function describeSources(principal: Principal) {
  requirePermission(principal, Permission.INTELLIGENCE_SIGNAL_READ);
  return listSources().map((s) => ({
    key: s.key,
    available: s.available,
    description: s.description,
    signalTypes: s.signalTypes,
  }));
}

export async function upsertPolicy(principal: Principal, raw: unknown) {
  requirePermission(principal, Permission.INTELLIGENCE_PUBLISH);
  const input = parse(UpsertPolicySchema, raw, 'intelligence policy');
  return withTransaction(async (client) => {
    const policy = await repo.upsertPolicy(client, {
      clinicId: principal.clinicId,
      key: input.key,
      description: input.description,
      jurisdiction: input.jurisdiction,
      minCohortSize: input.minCohortSize,
      maxPrecision: input.maxPrecision,
      allowedSignalTypes: input.allowedSignalTypes,
      maxQueriesPerWindow: input.maxQueriesPerWindow,
      queryWindowHours: input.queryWindowHours,
      maxNarrowingDepth: input.maxNarrowingDepth,
      valueRoundingBase: input.valueRoundingBase,
      createdBy: principal.userId,
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'intelligence.policy.upsert',
      targetType: 'intelligence_policy',
      targetId: policy.key,
      metadata: { minCohortSize: policy.minCohortSize, maxPrecision: policy.maxPrecision },
    });
    return policy;
  });
}

export async function listPolicies(principal: Principal) {
  requirePermission(principal, Permission.INTELLIGENCE_SIGNAL_READ);
  return repo.listPolicies(principal.clinicId);
}

export interface RunOutcome {
  runId: string;
  signalType: string;
  sourceKind: string;
  policyKey: string;
  minCohortSize: number;
  cohortsEvaluated: number;
  cohortsSuppressed: number;
  signalsPublished: number;
  signals: repo.StoredSignal[];
}

/**
 * Run the firewall over a governed source and publish whatever survives it.
 *
 * The order here mirrors the architecture exactly: authorize, resolve the
 * source, resolve the policy, fetch contributions, run the pipeline, persist
 * only allowed signals. A failure at any stage publishes nothing.
 */
export async function runIntelligence(principal: Principal, raw: unknown): Promise<RunOutcome> {
  // Stage 2 — authorization. Producing intelligence is a governance action.
  requirePermission(principal, Permission.INTELLIGENCE_PUBLISH);
  const input = parse(RunPipelineSchema, raw, 'intelligence run');
  if (input.periodEnd < input.periodStart) {
    throw new ValidationError('periodEnd must not be before periodStart');
  }

  const source = getSource(input.sourceKind);
  if (!source) throw new ValidationError(`Unknown intelligence source "${input.sourceKind}"`);

  const policy =
    (await repo.getPolicy(principal.clinicId, input.policyKey)) ??
    defaultPolicy(input.jurisdiction);

  // A run is confined to the caller's territory scope, like every other pharma
  // read — a manager may run clinic-wide, a rep only over their own territories.
  const scope = await territoryScopeFor(principal);
  const territoryIds = input.territoryIds ?? scope;

  // PHASE 29 — query governance, BEFORE any data is fetched. A refused request
  // must not touch the source at all: the point is that the answer is never
  // computed, not that it is computed and withheld.
  const slice: QuerySlice = {
    signalType: input.signalType,
    jurisdiction: input.jurisdiction,
    scopeKeys: [...(territoryIds ?? [])].sort(),
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  };
  const history = await repo.recentAllowedQueries(
    principal.clinicId,
    principal.userId,
    input.signalType,
    policy.queryWindowHours,
  );
  const decision = decideQuery(slice, history, policy);

  if (!decision.allowed) {
    // Record the refusal before returning it, so a principal probing the
    // boundary leaves a trail they cannot erase (the log is append-only).
    await repo.insertQueryLog(getPool(), {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      queryKind: 'run',
      signalType: input.signalType,
      jurisdiction: input.jurisdiction,
      scopeType: input.scopeType,
      scopeKeys: slice.scopeKeys,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      policyKey: policy.key,
      outcome: decision.outcome,
      narrowingDepth: decision.narrowingDepth,
    });
    await audit({
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'intelligence.query.denied',
      outcome: 'denied',
      targetType: 'intelligence_run',
      metadata: {
        signalType: input.signalType,
        outcome: decision.outcome,
        narrowingDepth: decision.narrowingDepth,
      },
    });
    throw new QueryGovernanceError(decision.reason, {
      control: decision.outcome,
      narrowingDepth: decision.narrowingDepth,
      maxNarrowingDepth: policy.maxNarrowingDepth,
      maxQueriesPerWindow: policy.maxQueriesPerWindow,
      queryWindowHours: policy.queryWindowHours,
    });
  }

  // This throws for `clinical_governed` until CCR-001 lands; the refusal is
  // recorded as a denied run so the attempt is visible in the audit trail.
  let contributions;
  try {
    contributions = await source.fetch({
      clinicId: principal.clinicId,
      signalType: input.signalType,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      territoryIds: territoryIds ?? null,
    });
  } catch (err) {
    await audit({
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'intelligence.run.denied',
      outcome: 'denied',
      targetType: 'intelligence_run',
      metadata: {
        sourceKind: input.sourceKind,
        signalType: input.signalType,
        reason: (err as Error).message.slice(0, 200),
      },
    });
    throw err;
  }

  const request: FirewallRequest = {
    signalType: input.signalType,
    scopeType: input.scopeType,
    aggregationLevel: input.aggregationLevel,
    jurisdiction: input.jurisdiction,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    source: source.key,
    sourceVersion: null,
    method:
      `distinct-HCP cohort counts over ${source.key} for ` +
      `${input.periodStart}..${input.periodEnd}, de-identified and threshold-gated`,
  };

  const firewalled = runFirewall(contributions, request, policy);

  // PHASE 28 — disclosure control on what survived the threshold: complementary
  // suppression, cohort banding and value rounding. It can only remove or blur.
  const result = applyDisclosureControl(firewalled.signals, firewalled.suppressed, policy);
  const cohortsEvaluated = firewalled.cohortsEvaluated;

  return withTransaction(async (client) => {
    const run = await repo.insertRun(client, {
      clinicId: principal.clinicId,
      sourceKind: input.sourceKind,
      signalType: input.signalType,
      scopeType: input.scopeType,
      jurisdiction: input.jurisdiction,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      policyKey: policy.key,
      minCohortSize: Math.max(policy.minCohortSize, ABSOLUTE_MIN_COHORT),
      status: 'completed',
      cohortsEvaluated,
      cohortsSuppressed: result.suppressed.length,
      signalsPublished: result.signals.length,
      denialReason: null,
      requestedBy: principal.userId,
    });

    // The allowed query joins the principal's history only once the run has
    // actually happened, and in the same transaction as the run itself.
    await repo.insertQueryLog(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      queryKind: 'run',
      signalType: input.signalType,
      jurisdiction: input.jurisdiction,
      scopeType: input.scopeType,
      scopeKeys: slice.scopeKeys,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      policyKey: policy.key,
      outcome: 'allowed',
      narrowingDepth: decision.narrowingDepth,
    });

    const stored: repo.StoredSignal[] = [];
    for (const signal of result.signals) {
      const saved = await repo.upsertSignal(
        client,
        principal.clinicId,
        run.id,
        signal,
        principal.userId,
      );
      stored.push(saved.signal);
      // Both outcomes are lifecycle transitions and neither left a trace
      // before: a first computation produces a draft, and a re-computation
      // supersedes whatever review the previous number had earned.
      await repo.insertSignalEvent(client, {
        clinicId: principal.clinicId,
        signalId: saved.signal.id,
        eventType: saved.inserted ? 'generated' : 'superseded',
        fromStatus: saved.previousStatus,
        toStatus: SignalLifecycle.DRAFT,
        reason: null,
        detail: { runId: run.id },
        // A run is operated by a person, so unlike an expiry it is attributed.
        actorId: principal.userId,
      });
    }

    for (const signal of stored) {
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.INTELLIGENCE_SIGNAL_PUBLISHED,
        subjectType: 'aggregated_signal',
        subjectId: signal.id,
        actorId: principal.userId,
        payload: {
          signalType: signal.signalType,
          scopeType: signal.scopeType,
          cohortBand: signal.cohortBand,
          policyKey: signal.policyKey,
        },
      });
    }
    if (result.suppressed.length > 0) {
      // The count is a fact about governance working; the cohorts themselves
      // are not recorded here, precisely because they are below threshold.
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.INTELLIGENCE_COHORT_SUPPRESSED,
        subjectType: 'intelligence_run',
        subjectId: run.id,
        actorId: principal.userId,
        payload: {
          suppressedCount: result.suppressed.length,
          reasons: [...new Set(result.suppressed.map((s) => s.reason))],
        },
      });
    }
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.INTELLIGENCE_RUN_COMPLETED,
      subjectType: 'intelligence_run',
      subjectId: run.id,
      actorId: principal.userId,
      payload: {
        signalType: input.signalType,
        sourceKind: input.sourceKind,
        published: stored.length,
        suppressed: result.suppressed.length,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'intelligence.run',
      targetType: 'intelligence_run',
      targetId: run.id,
      metadata: {
        sourceKind: input.sourceKind,
        signalType: input.signalType,
        published: stored.length,
        suppressed: result.suppressed.length,
        minCohortSize: Math.max(policy.minCohortSize, ABSOLUTE_MIN_COHORT),
      },
    });

    return {
      runId: run.id,
      signalType: input.signalType,
      sourceKind: input.sourceKind,
      policyKey: policy.key,
      minCohortSize: Math.max(policy.minCohortSize, ABSOLUTE_MIN_COHORT),
      cohortsEvaluated,
      cohortsSuppressed: result.suppressed.length,
      signalsPublished: stored.length,
      signals: stored,
    };
  });
}

export interface ListSignalsParams {
  signalType?: string;
  scopeType?: string;
  scopeId?: string;
  jurisdiction?: string;
  from?: string;
  to?: string;
  /**
   * Governance principals only. Restricted to the effective states they are
   * allowed to see; a consumer's request for anything but `published` is
   * refused rather than silently narrowed, so nobody mistakes an empty list for
   * an absence of drafts.
   */
  lifecycleStatus?: string;
  limit?: number;
}

/**
 * The states each kind of principal may read.
 *
 * A CONSUMER (`intelligence:signal-read`) sees exactly `published` — that is
 * what "published" means. A GOVERNANCE principal (`intelligence:publish`) also
 * sees the states that exist for them to act on. Nobody, at any level, reads
 * through this path into anything but an aggregate.
 */
const CONSUMER_VISIBLE: readonly SignalLifecycle[] = [SignalLifecycle.PUBLISHED];

/** Which trail entry each decision writes. */
const DECISION_EVENT: Record<SignalDecision, repo.SignalEvent['eventType']> = {
  [SignalDecision.SUBMIT_REVIEW]: 'submitted',
  [SignalDecision.APPROVE]: 'approved',
  [SignalDecision.REJECT]: 'rejected',
  [SignalDecision.PUBLISH]: 'published',
  [SignalDecision.WITHDRAW]: 'withdrawn',
};
const GOVERNANCE_VISIBLE: readonly SignalLifecycle[] = SIGNAL_LIFECYCLE_STATES;

/**
 * Read published signals. Every returned row carries its governance envelope
 * (source, period, scope, jurisdiction, cohort size, threshold, confidence,
 * method, provenance) so a consumer can never mistake a signal for a fact about
 * an individual.
 */
export async function listSignals(principal: Principal, params: ListSignalsParams) {
  requirePermission(principal, Permission.INTELLIGENCE_SIGNAL_READ);

  // A representative sees signals for their own territories only; a manager
  // sees the clinic. Territory-scoped signals carry the territory id as scope.
  const scope = await territoryScopeFor(principal);

  const governance = hasPermission(principal, Permission.INTELLIGENCE_PUBLISH);
  const allowedStates = governance ? GOVERNANCE_VISIBLE : CONSUMER_VISIBLE;
  let statuses = allowedStates;
  if (params.lifecycleStatus) {
    if (!allowedStates.includes(params.lifecycleStatus as SignalLifecycle)) {
      // Refused, not narrowed: a consumer asking for drafts must be told no,
      // not handed an empty list they could read as "there are none".
      throw new ForbiddenError(
        `You may only read signals in state(s): ${allowedStates.join(', ')}`,
      );
    }
    statuses = [params.lifecycleStatus as SignalLifecycle];
  }

  const signals = await repo.listSignals(principal.clinicId, {
    signalType: params.signalType ?? null,
    scopeType: params.scopeType ?? null,
    scopeId: params.scopeId ?? null,
    jurisdiction: params.jurisdiction ?? null,
    from: params.from ?? null,
    to: params.to ?? null,
    lifecycleStatuses: statuses,
    limit: Math.min(Math.max(params.limit ?? 100, 1), 500),
  });
  const visible =
    scope === null
      ? signals
      : signals.filter((s) => s.scopeType !== 'territory' || (s.scopeId && scope.includes(s.scopeId)));

  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'intelligence.signals.read',
    targetType: 'aggregated_signal',
    metadata: {
      signalType: params.signalType ?? null,
      returned: visible.length,
    },
  });
  return visible;
}

/**
 * The principal's own query-budget position.
 *
 * Exposed so an analyst can see why a request will be refused before making it,
 * rather than discovering the boundary by probing it — probing is exactly the
 * behaviour the control exists to discourage. It reports only the caller's own
 * usage, never another principal's.
 */
export async function queryBudget(principal: Principal, policyKey = DEFAULT_POLICY_KEY) {
  requirePermission(principal, Permission.INTELLIGENCE_PUBLISH);
  const policy =
    (await repo.getPolicy(principal.clinicId, policyKey)) ?? defaultPolicy('XX');
  const usage = await repo.queryBudgetUsage(
    principal.clinicId,
    principal.userId,
    policy.queryWindowHours,
  );
  return {
    policyKey: policy.key,
    windowHours: policy.queryWindowHours,
    maxQueriesPerWindow: policy.maxQueriesPerWindow,
    used: usage.used,
    remaining: Math.max(policy.maxQueriesPerWindow - usage.used, 0),
    deniedInWindow: usage.denied,
    maxNarrowingDepth: policy.maxNarrowingDepth,
  };
}

export async function listRuns(principal: Principal, limit = 20) {
  requirePermission(principal, Permission.INTELLIGENCE_PUBLISH);
  return repo.listRuns(principal.clinicId, Math.min(Math.max(limit, 1), 100));
}

// --- the governed signal lifecycle (migration 0311) --------------------------

export const SignalDecisionSchema = z.object({
  decision: z.enum(['submit_review', 'approve', 'reject', 'publish', 'withdraw']),
  /** Required for `reject` and `withdraw`; an unexplained retraction is not reviewable. */
  reason: z.string().trim().min(4).max(2000).optional(),
  /**
   * Shelf life of a published claim, in days. Bounded: an aggregate over a
   * period decays, and the lifecycle does not allow an unbounded window to be
   * implied — only a shorter one to be chosen.
   */
  validForDays: z.number().int().min(1).max(365).optional(),
});

/**
 * Move a signal through its lifecycle.
 *
 * All five decisions sit behind `intelligence:publish` — the permission that
 * already means "accountable for what this workstream asserts". Separation of
 * duties is NOT expressed as a second permission but as an identity rule: the
 * principal whose run produced a signal may not be the one who approves it,
 * enforced here and again by `signal_no_self_approval` in the schema, so a
 * direct write cannot get around it.
 *
 * Nothing here touches the firewall. The pipeline decides whether a number is
 * SAFE to publish; this decides whether the claim is TRUE ENOUGH to publish.
 * A signal that the firewall suppressed never becomes a draft in the first
 * place, so no decision on this path can resurrect one.
 */
export async function decideSignal(principal: Principal, signalId: string, raw: unknown) {
  requirePermission(principal, Permission.INTELLIGENCE_PUBLISH);
  const parsed = SignalDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid signal decision', parsed.error.flatten());
  }
  const input = parsed.data;
  assertFreeTextClean({ reason: input.reason ?? null });
  const decision = input.decision as SignalDecision;
  const to = targetStateFor(decision);

  return withTransaction(async (client) => {
    const signal = await repo.getSignalForUpdate(client, principal.clinicId, signalId);
    if (!signal) throw new NotFoundError('Signal');

    // Decide against the EFFECTIVE status: a lapsed claim is `expired` even if
    // no sweep has run, so it cannot be published a second time by racing one.
    const from = signal.effectiveStatus;
    assertSignalTransition(from, to, input.reason ?? null);
    if (isApprovalDecision(decision)) {
      assertNotSelfApproval(signal.generatedBy, principal.userId);
    }

    const now = new Date().toISOString();
    const submitting = to === SignalLifecycle.IN_REVIEW;
    const next = await repo.applySignalDecision(client, principal.clinicId, signalId, {
      // WHO put the claim in front of a reviewer. These two columns existed
      // from 0311 and nothing ever wrote them: the previous value was read and
      // written straight back, so they always held NULL.
      reviewedBy: submitting ? principal.userId : signal.reviewedBy,
      reviewedAt: submitting ? now : signal.reviewedAt,
      lifecycleStatus: to,
      reviewNote: to === SignalLifecycle.REJECTED ? (input.reason ?? null) : signal.reviewNote,
      // An approval is attributed or it is not an approval. Re-entering review
      // clears it, so a revised claim cannot inherit the old acceptance.
      approvedBy: submitting ? null : to === SignalLifecycle.APPROVED ? principal.userId : signal.approvedBy,
      approvedAt: submitting ? null : to === SignalLifecycle.APPROVED ? now : signal.approvedAt,
      publishedBy: to === SignalLifecycle.PUBLISHED ? principal.userId : signal.publishedBy,
      publishedAt: to === SignalLifecycle.PUBLISHED ? now : signal.publishedAt,
      // A withdrawal is NOT erased by the next decision. Clearing it on
      // re-submission destroyed the record of why a live claim had been pulled
      // at exactly the moment that reason matters most; it is superseded only
      // by a later withdrawal.
      withdrawnBy: to === SignalLifecycle.WITHDRAWN ? principal.userId : signal.withdrawnBy,
      withdrawnAt: to === SignalLifecycle.WITHDRAWN ? now : signal.withdrawnAt,
      withdrawalReason:
        to === SignalLifecycle.WITHDRAWN ? (input.reason ?? null) : signal.withdrawalReason,
      expiresAt:
        to === SignalLifecycle.PUBLISHED ? signalExpiryFrom(input.validForDays) : null,
    });

    await repo.insertSignalEvent(client, {
      clinicId: principal.clinicId,
      signalId,
      eventType: DECISION_EVENT[decision],
      fromStatus: from,
      toStatus: to,
      reason: input.reason ?? null,
      // Shape only: the claim's value and cohort size never enter the trail.
      detail: { expiresAt: next.expiresAt },
      actorId: principal.userId,
    });

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.INTELLIGENCE_SIGNAL_LIFECYCLE_CHANGED,
      subjectType: 'aggregated_signal',
      subjectId: signalId,
      actorId: principal.userId,
      // Shape only: the signal's VALUE never travels in an event payload.
      payload: { from, to, decision, expiresAt: next.expiresAt },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'intelligence.signal.decision',
      targetType: 'aggregated_signal',
      targetId: signalId,
      metadata: { from, to, decision },
    });
    return next;
  });
}

/**
 * Persist the lapse of signals whose shelf life has passed.
 *
 * Reads already DERIVE expiry, so this only makes the stored value agree with
 * what consumers are already shown. Nothing depends on it having run — which is
 * the point: a missed background job cannot leave a stale claim on display.
 */
export async function sweepSignalExpiry(principal: Principal, limit = 500) {
  requirePermission(principal, Permission.INTELLIGENCE_PUBLISH);
  const bounded = Math.min(Math.max(limit, 1), 1000);

  const expired = await withTransaction(async (client) => {
    const due = await repo.expiredSignalRows(client, principal.clinicId, bounded);
    const count = await repo.markSignalsExpired(
      client,
      principal.clinicId,
      due.map((s) => s.id),
    );
    for (const signal of due) {
      await repo.insertSignalEvent(client, {
        clinicId: principal.clinicId,
        signalId: signal.id,
        eventType: 'expired',
        fromStatus: signal.lifecycleStatus,
        toStatus: SignalLifecycle.EXPIRED,
        reason: null,
        detail: { expiresAt: signal.expiresAt },
        // No actor. An expiry is the system observing a clock, not a decision
        // by whoever happened to run the sweep.
        actorId: null,
      });
    }
    return count;
  });

  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'intelligence.signal.sweep',
    targetType: 'aggregated_signal',
    metadata: { expired },
  });
  return { expired };
}

/**
 * A signal's decision trail (0314).
 *
 * Restricted to `intelligence:publish`: the trail names the people who reviewed,
 * approved, published and retracted a claim, which is governance information
 * about colleagues rather than the claim itself. A consumer gets the claim.
 */
export async function signalHistory(principal: Principal, signalId: string) {
  requirePermission(principal, Permission.INTELLIGENCE_PUBLISH);
  const signal = await repo.getSignalById(principal.clinicId, signalId);
  if (!signal) throw new NotFoundError('Signal');
  return repo.listSignalEvents(principal.clinicId, signalId);
}

/** One signal, if this principal is allowed to see it in its current state. */
export async function getSignal(principal: Principal, signalId: string) {
  requirePermission(principal, Permission.INTELLIGENCE_SIGNAL_READ);
  const signal = await repo.getSignalById(principal.clinicId, signalId);
  if (!signal) throw new NotFoundError('Signal');
  if (
    signal.effectiveStatus !== SignalLifecycle.PUBLISHED &&
    !hasPermission(principal, Permission.INTELLIGENCE_PUBLISH)
  ) {
    // Not-found rather than forbidden: to a consumer, an unpublished signal
    // does not exist, and saying "forbidden" would confirm that one is being
    // prepared for this exact scope and period.
    throw new NotFoundError('Signal');
  }
  return signal;
}
