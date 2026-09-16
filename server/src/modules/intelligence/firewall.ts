import { createHash, randomBytes } from 'node:crypto';
import { ValidationError } from '../../domain/errors.js';
import { assertClassPermittedForPharma, type DataClass } from './classification.js';

/**
 * THE INTELLIGENCE FIREWALL (blueprint §24–25, GOVERNANCE.md).
 *
 *   classification -> authorization -> de-identification -> aggregation
 *   -> minimum-cohort threshold -> policy validation -> allowed signal
 *
 * Everything in this module is a pure function over in-memory values: no
 * database, no principal, no I/O. That is deliberate — the rules can be
 * exhaustively unit-tested, and a caller cannot "helpfully" skip a stage,
 * because the only way to obtain a signal is to run `runFirewall`, which
 * performs the stages in order and returns nothing for anything that fails one.
 *
 * Authorization (stage 2) happens in the service before these functions are
 * called, because it needs the principal; the pipeline still re-checks
 * classification itself so a mis-wired caller cannot bypass stage 1.
 */

export type ScopeType =
  | 'territory'
  | 'region'
  | 'country'
  | 'therapeutic_area'
  | 'product'
  | 'global';

export type AggregationLevel = 'hcp_group' | 'territory' | 'region' | 'country';

/** One observation entering the pipeline. */
export interface CohortContribution {
  /**
   * Identifies the *subject* of the observation, used only to count distinct
   * members of a cohort. It is hashed with a per-run salt and discarded before
   * aggregation, so it never reaches a stored signal.
   */
  subjectKey: string;
  /** What kind of subject this is. Stage 1 refuses anything patient-level. */
  dataClass: DataClass;
  /** The dimension being measured, e.g. an objection theme or a product. */
  dimension: string;
  dimensionLabel?: string;
  scopeId: string;
  scopeLabel: string;
  /** Observation weight; defaults to 1 (one occurrence). */
  weight?: number;
}

export interface FirewallPolicy {
  key: string;
  jurisdiction: string;
  /** Cohorts smaller than this are suppressed. Never below `ABSOLUTE_MIN_COHORT`. */
  minCohortSize: number;
  /** The finest scope a signal may describe. */
  maxPrecision: 'territory' | 'region' | 'country';
  requiresDeidentification: boolean;
  /** Empty means "any signal type"; otherwise an allow-list. */
  allowedSignalTypes: string[];
}

/**
 * The floor for any cohort, mirrored by a CHECK constraint on
 * `aggregated_signal.min_cohort_size`. A policy may be stricter; nothing may be
 * more permissive, in code or in data.
 */
export const ABSOLUTE_MIN_COHORT = 5;

const PRECISION_RANK: Record<string, number> = {
  territory: 1,
  hcp_group: 1,
  region: 2,
  country: 3,
  therapeutic_area: 3,
  product: 3,
  global: 4,
};

/** Separator for grouping keys; not valid inside a dimension or scope id. */
const GROUP_KEY_SEPARATOR = '|::|';

export interface FirewallRequest {
  signalType: string;
  scopeType: ScopeType;
  aggregationLevel: AggregationLevel;
  jurisdiction: string;
  periodStart: string;
  periodEnd: string;
  source: string;
  sourceVersion?: string | null;
  method: string;
}

export interface AllowedSignal {
  signalType: string;
  signalKey: string;
  signalLabel: string | null;
  scopeType: ScopeType;
  scopeId: string;
  scopeLabel: string;
  jurisdiction: string;
  aggregationLevel: AggregationLevel;
  periodStart: string;
  periodEnd: string;
  value: number;
  valueUnit: 'count';
  cohortSize: number;
  minCohortSize: number;
  confidence: number;
  source: string;
  sourceVersion: string | null;
  method: string;
  provenance: Record<string, unknown>;
  policyKey: string;
}

export interface SuppressedCohort {
  signalKey: string;
  scopeId: string;
  cohortSize: number;
  reason: 'below_min_cohort' | 'policy_precision' | 'policy_signal_type' | 'policy_jurisdiction';
}

export interface FirewallResult {
  signals: AllowedSignal[];
  suppressed: SuppressedCohort[];
  cohortsEvaluated: number;
}

/** STAGE 3 — de-identification. */
interface DeidentifiedContribution {
  subjectHash: string;
  dimension: string;
  dimensionLabel: string | null;
  scopeId: string;
  scopeLabel: string;
  weight: number;
}

/**
 * Replace the subject key with a hash under a salt generated for this run and
 * never stored. Two runs therefore produce unlinkable hashes, so stored output
 * cannot be joined back to a subject even by this system.
 */
export function deidentify(
  contributions: CohortContribution[],
  salt: string,
): DeidentifiedContribution[] {
  return contributions.map((c) => ({
    subjectHash: createHash('sha256').update(`${salt}:${c.subjectKey}`).digest('hex'),
    dimension: c.dimension,
    dimensionLabel: c.dimensionLabel ?? null,
    scopeId: c.scopeId,
    scopeLabel: c.scopeLabel,
    weight: c.weight ?? 1,
  }));
}

/** A cohort: distinct subjects sharing a (dimension, scope) pair. */
interface Cohort {
  dimension: string;
  dimensionLabel: string | null;
  scopeId: string;
  scopeLabel: string;
  /** Distinct subjects — this is what the threshold is applied to. */
  cohortSize: number;
  /** Total observations (a subject may contribute more than once). */
  observations: number;
}

/** STAGE 4 — aggregation into cohorts keyed by (dimension, scope). */
export function aggregate(contributions: DeidentifiedContribution[]): Cohort[] {
  const groups = new Map<
    string,
    {
      cohort: Omit<Cohort, 'cohortSize' | 'observations'>;
      subjects: Set<string>;
      observations: number;
    }
  >();
  for (const c of contributions) {
    const key = `${c.dimension}${GROUP_KEY_SEPARATOR}${c.scopeId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        cohort: {
          dimension: c.dimension,
          dimensionLabel: c.dimensionLabel,
          scopeId: c.scopeId,
          scopeLabel: c.scopeLabel,
        },
        subjects: new Set(),
        observations: 0,
      };
      groups.set(key, group);
    }
    group.subjects.add(c.subjectHash);
    group.observations += c.weight;
  }
  return [...groups.values()].map((g) => ({
    ...g.cohort,
    cohortSize: g.subjects.size,
    observations: g.observations,
  }));
}

/**
 * Confidence for an aggregate built from `cohortSize` distinct subjects.
 *
 * A saturating function of sample size — NOT a statistical confidence interval,
 * and it is labelled as such in every signal's provenance. It exists so a
 * consumer can tell a signal from five HCPs apart from one from fifty, and it is
 * capped below 1 because a field-reported aggregate is never certain.
 */
export function confidenceForCohort(cohortSize: number): number {
  const scaled = cohortSize / (cohortSize + 10);
  return Math.min(0.95, Math.round(scaled * 100) / 100);
}

/** STAGE 6 — policy validation (signal type, jurisdiction, precision). */
export function validatePolicy(
  request: FirewallRequest,
  policy: FirewallPolicy,
): SuppressedCohort['reason'] | null {
  if (
    policy.allowedSignalTypes.length > 0 &&
    !policy.allowedSignalTypes.includes(request.signalType)
  ) {
    return 'policy_signal_type';
  }
  if (policy.jurisdiction !== request.jurisdiction) return 'policy_jurisdiction';
  const requested = PRECISION_RANK[request.scopeType] ?? 0;
  const allowed = PRECISION_RANK[policy.maxPrecision] ?? 0;
  if (requested < allowed) return 'policy_precision';
  return null;
}

/**
 * Run the whole pipeline. The only way to produce a signal.
 *
 * Returns `signals: []` — not an error — when everything is suppressed: "no
 * cohort is large enough" must be indistinguishable from "there is nothing
 * here", or the absence of a signal becomes information about small cohorts.
 */
export function runFirewall(
  contributions: CohortContribution[],
  request: FirewallRequest,
  policy: FirewallPolicy,
): FirewallResult {
  // Stage 1 — classification. Any patient-class contribution aborts the entire
  // run; it is not silently filtered out, because its presence means an upstream
  // source is wired incorrectly and every result from that source is suspect.
  for (const contribution of contributions) {
    assertClassPermittedForPharma(contribution.dataClass);
  }

  if (!policy.requiresDeidentification) {
    // Defensive: the schema forbids storing such a policy, so reaching this
    // means the policy was constructed in memory and must not be honoured.
    throw new ValidationError('An intelligence policy must require de-identification');
  }
  const minCohortSize = Math.max(policy.minCohortSize, ABSOLUTE_MIN_COHORT);

  // Stage 6, applied up front where it concerns the request as a whole: a
  // disallowed request yields nothing at all, not a filtered subset.
  const policyFailure = validatePolicy(request, policy);

  // Stage 3 — de-identification under a per-run salt that is never persisted.
  const salt = randomBytes(32).toString('hex');
  const deidentified = deidentify(contributions, salt);

  // Stage 4 — aggregation.
  const cohorts = aggregate(deidentified);

  const signals: AllowedSignal[] = [];
  const suppressed: SuppressedCohort[] = [];

  for (const cohort of cohorts) {
    if (policyFailure) {
      suppressed.push({
        signalKey: cohort.dimension,
        scopeId: cohort.scopeId,
        cohortSize: cohort.cohortSize,
        reason: policyFailure,
      });
      continue;
    }
    // Stage 5 — minimum cohort threshold.
    if (cohort.cohortSize < minCohortSize) {
      suppressed.push({
        signalKey: cohort.dimension,
        scopeId: cohort.scopeId,
        cohortSize: cohort.cohortSize,
        reason: 'below_min_cohort',
      });
      continue;
    }
    // Stage 7 — allowed signal, carrying its full governance envelope.
    signals.push({
      signalType: request.signalType,
      signalKey: cohort.dimension,
      signalLabel: cohort.dimensionLabel,
      scopeType: request.scopeType,
      scopeId: cohort.scopeId,
      scopeLabel: cohort.scopeLabel,
      jurisdiction: request.jurisdiction,
      aggregationLevel: request.aggregationLevel,
      periodStart: request.periodStart,
      periodEnd: request.periodEnd,
      value: cohort.observations,
      valueUnit: 'count',
      cohortSize: cohort.cohortSize,
      minCohortSize,
      confidence: confidenceForCohort(cohort.cohortSize),
      source: request.source,
      sourceVersion: request.sourceVersion ?? null,
      method: request.method,
      provenance: {
        pipeline: [
          'classification',
          'authorization',
          'deidentification',
          'aggregation',
          'min_cohort_threshold',
          'policy_validation',
        ],
        deidentification: 'sha256 over a per-run salt that is not persisted',
        confidenceModel: 'saturating function of distinct-subject count; not a statistical CI',
        observationCount: cohort.observations,
      },
      policyKey: policy.key,
    });
  }

  return { signals, suppressed, cohortsEvaluated: cohorts.length };
}
