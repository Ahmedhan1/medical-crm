import { getPool, type PoolClient } from '../../db/pool.js';
import { toDateString } from '../pharma/dates.js';
import { cohortBand as bandFor, type PublishedSignal } from './disclosure.js';
import type { FirewallPolicy } from './firewall.js';

type Runner = Pick<PoolClient, 'query'>;

export interface StoredSignal {
  id: string;
  signalType: string;
  signalKey: string;
  signalLabel: string | null;
  scopeType: string;
  scopeId: string | null;
  scopeLabel: string | null;
  jurisdiction: string;
  aggregationLevel: string;
  periodStart: string;
  periodEnd: string;
  value: number;
  valueUnit: string;
  valueRoundingBase: number;
  /**
   * The published form of the cohort size. The exact count is deliberately NOT
   * part of this shape: exact counts are what a differencing attack subtracts.
   * It remains in the `aggregated_signal.cohort_size` column for the operator's
   * own audit and for the 0304 threshold CHECKs.
   */
  cohortBand: string;
  minCohortSize: number;
  confidence: number;
  source: string;
  sourceVersion: string | null;
  method: string;
  provenance: Record<string, unknown>;
  policyKey: string;
  policyStatus: string;
  deidentified: boolean;
  generatedAt: string;
  publishedAt: string;
}

interface SignalRow {
  id: string;
  signal_type: string;
  signal_key: string;
  signal_label: string | null;
  scope_type: string;
  scope_id: string | null;
  scope_label: string | null;
  jurisdiction: string;
  aggregation_level: string;
  period_start: Date | string;
  period_end: Date | string;
  value: string;
  value_unit: string;
  value_rounding_base: number;
  cohort_band: string | null;
  cohort_size: number;
  min_cohort_size: number;
  confidence: string;
  source: string;
  source_version: string | null;
  method: string;
  provenance: Record<string, unknown>;
  policy_key: string;
  policy_status: string;
  deidentified: boolean;
  generated_at: string;
  published_at: string;
}

function mapSignal(row: SignalRow): StoredSignal {
  return {
    id: row.id,
    signalType: row.signal_type,
    signalKey: row.signal_key,
    signalLabel: row.signal_label,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    scopeLabel: row.scope_label,
    jurisdiction: row.jurisdiction,
    aggregationLevel: row.aggregation_level,
    periodStart: toDateString(row.period_start)!,
    periodEnd: toDateString(row.period_end)!,
    value: Number(row.value),
    valueUnit: row.value_unit,
    valueRoundingBase: row.value_rounding_base,
    // Older rows (pre-0305) have no band; derive one rather than leaking the
    // exact count through the API.
    cohortBand: row.cohort_band ?? bandFor(row.cohort_size, row.min_cohort_size),
    minCohortSize: row.min_cohort_size,
    confidence: Number(row.confidence),
    source: row.source,
    sourceVersion: row.source_version,
    method: row.method,
    provenance: row.provenance,
    policyKey: row.policy_key,
    policyStatus: row.policy_status,
    deidentified: row.deidentified,
    generatedAt: row.generated_at,
    publishedAt: row.published_at,
  };
}

// --- Policy -----------------------------------------------------------------

interface PolicyRow {
  key: string;
  jurisdiction: string;
  min_cohort_size: number;
  max_precision: FirewallPolicy['maxPrecision'];
  requires_deidentification: boolean;
  allowed_signal_types: string[];
  max_queries_per_window: number;
  query_window_hours: number;
  max_narrowing_depth: number;
  value_rounding_base: number;
  complementary_suppression: boolean;
}

/**
 * A policy as the service needs it: the firewall's thresholds plus the
 * disclosure-control and query-governance knobs added in migration 0305.
 */
export interface GovernancePolicy extends FirewallPolicy {
  maxQueriesPerWindow: number;
  queryWindowHours: number;
  maxNarrowingDepth: number;
  valueRoundingBase: number;
  complementarySuppression: boolean;
}

function mapPolicy(row: PolicyRow): GovernancePolicy {
  return {
    key: row.key,
    jurisdiction: row.jurisdiction,
    minCohortSize: row.min_cohort_size,
    maxPrecision: row.max_precision,
    requiresDeidentification: row.requires_deidentification,
    allowedSignalTypes: row.allowed_signal_types,
    maxQueriesPerWindow: row.max_queries_per_window,
    queryWindowHours: row.query_window_hours,
    maxNarrowingDepth: row.max_narrowing_depth,
    valueRoundingBase: row.value_rounding_base,
    complementarySuppression: row.complementary_suppression,
  };
}

const POLICY_COLUMNS = `key, jurisdiction, min_cohort_size, max_precision,
            requires_deidentification, allowed_signal_types, max_queries_per_window,
            query_window_hours, max_narrowing_depth, value_rounding_base,
            complementary_suppression`;

export async function getPolicy(
  clinicId: string,
  key: string,
  runner: Runner = getPool(),
): Promise<GovernancePolicy | null> {
  const { rows } = await runner.query<PolicyRow>(
    `SELECT ${POLICY_COLUMNS}
       FROM intelligence_policy
      WHERE clinic_id = $1 AND key = $2 AND is_active`,
    [clinicId, key],
  );
  return rows[0] ? mapPolicy(rows[0]) : null;
}

export async function upsertPolicy(
  client: PoolClient,
  input: {
    clinicId: string;
    key: string;
    description: string;
    jurisdiction: string;
    minCohortSize: number;
    maxPrecision: FirewallPolicy['maxPrecision'];
    allowedSignalTypes: string[];
    maxQueriesPerWindow: number;
    queryWindowHours: number;
    maxNarrowingDepth: number;
    valueRoundingBase: number;
    createdBy: string;
  },
): Promise<GovernancePolicy> {
  const { rows } = await client.query<PolicyRow>(
    `INSERT INTO intelligence_policy
       (clinic_id, key, description, jurisdiction, min_cohort_size, max_precision,
        allowed_signal_types, max_queries_per_window, query_window_hours,
        max_narrowing_depth, value_rounding_base, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (clinic_id, key) DO UPDATE
       SET description = EXCLUDED.description,
           jurisdiction = EXCLUDED.jurisdiction,
           min_cohort_size = EXCLUDED.min_cohort_size,
           max_precision = EXCLUDED.max_precision,
           allowed_signal_types = EXCLUDED.allowed_signal_types,
           max_queries_per_window = EXCLUDED.max_queries_per_window,
           query_window_hours = EXCLUDED.query_window_hours,
           max_narrowing_depth = EXCLUDED.max_narrowing_depth,
           value_rounding_base = EXCLUDED.value_rounding_base,
           updated_at = now()
     RETURNING ${POLICY_COLUMNS}`,
    [
      input.clinicId,
      input.key,
      input.description,
      input.jurisdiction,
      input.minCohortSize,
      input.maxPrecision,
      input.allowedSignalTypes,
      input.maxQueriesPerWindow,
      input.queryWindowHours,
      input.maxNarrowingDepth,
      input.valueRoundingBase,
      input.createdBy,
    ],
  );
  return mapPolicy(rows[0]!);
}

export async function listPolicies(clinicId: string) {
  const { rows } = await getPool().query<PolicyRow & { description: string }>(
    `SELECT ${POLICY_COLUMNS}, description
       FROM intelligence_policy
      WHERE clinic_id = $1 AND is_active
      ORDER BY key`,
    [clinicId],
  );
  return rows.map((row) => ({ ...mapPolicy(row), description: row.description }));
}

// --- Runs -------------------------------------------------------------------

export async function insertRun(
  client: PoolClient,
  input: {
    clinicId: string;
    sourceKind: string;
    signalType: string;
    scopeType: string;
    jurisdiction: string;
    periodStart: string;
    periodEnd: string;
    policyKey: string;
    minCohortSize: number;
    status: 'completed' | 'denied' | 'failed';
    cohortsEvaluated: number;
    cohortsSuppressed: number;
    signalsPublished: number;
    denialReason: string | null;
    requestedBy: string;
  },
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO intelligence_run
       (clinic_id, source_kind, signal_type, scope_type, jurisdiction, period_start, period_end,
        policy_key, min_cohort_size, status, cohorts_evaluated, cohorts_suppressed,
        signals_published, denial_reason, requested_by, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
     RETURNING id`,
    [
      input.clinicId,
      input.sourceKind,
      input.signalType,
      input.scopeType,
      input.jurisdiction,
      input.periodStart,
      input.periodEnd,
      input.policyKey,
      input.minCohortSize,
      input.status,
      input.cohortsEvaluated,
      input.cohortsSuppressed,
      input.signalsPublished,
      input.denialReason,
      input.requestedBy,
    ],
  );
  return rows[0]!;
}

export async function listRuns(clinicId: string, limit: number) {
  const { rows } = await getPool().query<{
    id: string;
    source_kind: string;
    signal_type: string;
    status: string;
    cohorts_evaluated: number;
    cohorts_suppressed: number;
    signals_published: number;
    min_cohort_size: number;
    period_start: Date | string;
    period_end: Date | string;
    started_at: string;
  }>(
    `SELECT id, source_kind, signal_type, status, cohorts_evaluated, cohorts_suppressed,
            signals_published, min_cohort_size, period_start, period_end, started_at
       FROM intelligence_run
      WHERE clinic_id = $1
      ORDER BY started_at DESC
      LIMIT $2`,
    [clinicId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    sourceKind: r.source_kind,
    signalType: r.signal_type,
    status: r.status,
    cohortsEvaluated: r.cohorts_evaluated,
    cohortsSuppressed: r.cohorts_suppressed,
    signalsPublished: r.signals_published,
    minCohortSize: r.min_cohort_size,
    periodStart: toDateString(r.period_start)!,
    periodEnd: toDateString(r.period_end)!,
    startedAt: r.started_at,
  }));
}

// --- Signals ----------------------------------------------------------------

/**
 * Persist an allowed signal. Re-running a period replaces the previous value
 * for the same (type, key, scope, period) rather than accumulating duplicates.
 */
export async function upsertSignal(
  client: PoolClient,
  clinicId: string,
  runId: string,
  signal: PublishedSignal,
  generatedBy: string,
): Promise<StoredSignal> {
  const { rows } = await client.query<SignalRow>(
    `INSERT INTO aggregated_signal
       (clinic_id, run_id, signal_type, signal_key, signal_label, scope_type, scope_id, scope_label,
        jurisdiction, aggregation_level, period_start, period_end, value, value_unit, cohort_size,
        min_cohort_size, confidence, source, source_version, method, provenance, policy_key,
        generated_by, cohort_band, value_rounding_base)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT (clinic_id, signal_type, signal_key, scope_type, scope_id, period_start, period_end)
       DO UPDATE SET run_id = EXCLUDED.run_id,
                     value = EXCLUDED.value,
                     cohort_size = EXCLUDED.cohort_size,
                     cohort_band = EXCLUDED.cohort_band,
                     value_rounding_base = EXCLUDED.value_rounding_base,
                     min_cohort_size = EXCLUDED.min_cohort_size,
                     confidence = EXCLUDED.confidence,
                     provenance = EXCLUDED.provenance,
                     method = EXCLUDED.method,
                     generated_at = now(),
                     published_at = now()
     RETURNING *`,
    [
      clinicId,
      runId,
      signal.signalType,
      signal.signalKey,
      signal.signalLabel,
      signal.scopeType,
      signal.scopeId,
      signal.scopeLabel,
      signal.jurisdiction,
      signal.aggregationLevel,
      signal.periodStart,
      signal.periodEnd,
      signal.value,
      signal.valueUnit,
      signal.cohortSize,
      signal.minCohortSize,
      signal.confidence,
      signal.source,
      signal.sourceVersion,
      signal.method,
      JSON.stringify(signal.provenance),
      signal.policyKey,
      generatedBy,
      signal.cohortBand,
      signal.valueRoundingBase,
    ],
  );
  return mapSignal(rows[0]!);
}

// --- Query governance log (migration 0305) ----------------------------------

export interface QueryLogEntry {
  signalType: string;
  jurisdiction: string;
  scopeKeys: string[];
  periodStart: string;
  periodEnd: string;
}

/**
 * The principal's ALLOWED runs for this signal type inside the rolling window.
 * Refused attempts are excluded on purpose: a rejected probe must not deepen the
 * narrowing chain, or a principal could lock themselves out with failures.
 */
export async function recentAllowedQueries(
  clinicId: string,
  actorId: string,
  signalType: string,
  windowHours: number,
  runner: Runner = getPool(),
): Promise<QueryLogEntry[]> {
  const { rows } = await runner.query<{
    signal_type: string;
    jurisdiction: string;
    scope_keys: string[];
    period_start: Date | string;
    period_end: Date | string;
  }>(
    `SELECT signal_type, jurisdiction, scope_keys, period_start, period_end
       FROM intelligence_query_log
      WHERE clinic_id = $1
        AND actor_id = $2
        AND signal_type = $3
        AND query_kind = 'run'
        AND outcome = 'allowed'
        AND created_at >= now() - make_interval(hours => $4::int)
      ORDER BY created_at DESC
      LIMIT 500`,
    [clinicId, actorId, signalType, windowHours],
  );
  return rows.map((r) => ({
    signalType: r.signal_type,
    jurisdiction: r.jurisdiction,
    scopeKeys: r.scope_keys,
    periodStart: toDateString(r.period_start)!,
    periodEnd: toDateString(r.period_end)!,
  }));
}

export async function insertQueryLog(
  runner: Runner,
  input: {
    clinicId: string;
    actorId: string;
    queryKind: 'run' | 'read';
    signalType: string;
    jurisdiction: string;
    scopeType: string;
    scopeKeys: string[];
    periodStart: string;
    periodEnd: string;
    policyKey: string;
    outcome: 'allowed' | 'denied_budget' | 'denied_narrowing';
    narrowingDepth: number;
  },
): Promise<void> {
  await runner.query(
    `INSERT INTO intelligence_query_log
       (clinic_id, actor_id, query_kind, signal_type, jurisdiction, scope_type, scope_keys,
        period_start, period_end, policy_key, outcome, narrowing_depth)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      input.clinicId,
      input.actorId,
      input.queryKind,
      input.signalType,
      input.jurisdiction,
      input.scopeType,
      input.scopeKeys,
      input.periodStart,
      input.periodEnd,
      input.policyKey,
      input.outcome,
      input.narrowingDepth,
    ],
  );
}

/** Budget usage for a principal, for the transparency endpoint. */
export async function queryBudgetUsage(
  clinicId: string,
  actorId: string,
  windowHours: number,
): Promise<{ used: number; denied: number }> {
  const { rows } = await getPool().query<{ used: string; denied: string }>(
    `SELECT count(*) FILTER (WHERE outcome = 'allowed')::text AS used,
            count(*) FILTER (WHERE outcome <> 'allowed')::text AS denied
       FROM intelligence_query_log
      WHERE clinic_id = $1 AND actor_id = $2 AND query_kind = 'run'
        AND created_at >= now() - make_interval(hours => $3::int)`,
    [clinicId, actorId, windowHours],
  );
  return { used: Number(rows[0]!.used), denied: Number(rows[0]!.denied) };
}

export interface SignalFilter {
  signalType: string | null;
  scopeType: string | null;
  scopeId: string | null;
  jurisdiction: string | null;
  from: string | null;
  to: string | null;
  limit: number;
}

export async function listSignals(
  clinicId: string,
  filter: SignalFilter,
): Promise<StoredSignal[]> {
  const { rows } = await getPool().query<SignalRow>(
    `SELECT * FROM aggregated_signal
      WHERE clinic_id = $1
        AND ($2::text IS NULL OR signal_type = $2)
        AND ($3::text IS NULL OR scope_type = $3)
        AND ($4::text IS NULL OR scope_id = $4)
        AND ($5::text IS NULL OR jurisdiction = $5)
        AND ($6::date IS NULL OR period_end >= $6)
        AND ($7::date IS NULL OR period_start <= $7)
      ORDER BY period_start DESC, signal_type, value DESC
      LIMIT $8`,
    [
      clinicId,
      filter.signalType,
      filter.scopeType,
      filter.scopeId,
      filter.jurisdiction,
      filter.from,
      filter.to,
      filter.limit,
    ],
  );
  return rows.map(mapSignal);
}
