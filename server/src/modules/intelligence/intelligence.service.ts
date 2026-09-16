import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { audit, auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { JurisdictionSchema } from '../pharma/provenance.js';
import { territoryScopeFor } from '../pharma/visibility.js';
import {
  ABSOLUTE_MIN_COHORT,
  runFirewall,
  type FirewallPolicy,
  type FirewallRequest,
} from './firewall.js';
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
 * The policy used when an operator has not defined one. Safe by default: the
 * absolute minimum cohort, territory precision, de-identification required.
 */
export const DEFAULT_POLICY_KEY = 'default';

export function defaultPolicy(jurisdiction: string): FirewallPolicy {
  return {
    key: DEFAULT_POLICY_KEY,
    jurisdiction,
    minCohortSize: ABSOLUTE_MIN_COHORT,
    maxPrecision: 'territory',
    requiresDeidentification: true,
    allowedSignalTypes: [],
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

  const result = runFirewall(contributions, request, policy);

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
      cohortsEvaluated: result.cohortsEvaluated,
      cohortsSuppressed: result.suppressed.length,
      signalsPublished: result.signals.length,
      denialReason: null,
      requestedBy: principal.userId,
    });

    const stored: repo.StoredSignal[] = [];
    for (const signal of result.signals) {
      stored.push(await repo.upsertSignal(client, principal.clinicId, run.id, signal, principal.userId));
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
          cohortSize: signal.cohortSize,
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
      cohortsEvaluated: result.cohortsEvaluated,
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
  limit?: number;
}

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
  const signals = await repo.listSignals(principal.clinicId, {
    signalType: params.signalType ?? null,
    scopeType: params.scopeType ?? null,
    scopeId: params.scopeId ?? null,
    jurisdiction: params.jurisdiction ?? null,
    from: params.from ?? null,
    to: params.to ?? null,
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

export async function listRuns(principal: Principal, limit = 20) {
  requirePermission(principal, Permission.INTELLIGENCE_PUBLISH);
  return repo.listRuns(principal.clinicId, Math.min(Math.max(limit, 1), 100));
}
