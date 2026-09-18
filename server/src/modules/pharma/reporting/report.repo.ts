import { getPool, type PoolClient } from '../../../db/pool.js';
import { toDateString } from '../dates.js';

type Runner = Pick<PoolClient, 'query'>;

/**
 * Report queries.
 *
 * Every query takes `territoryIds` and applies it IN SQL rather than filtering
 * afterwards: territory scope is an authorization boundary, and a boundary
 * enforced after the rows are already in memory is one refactor away from being
 * forgotten. `null` means the caller is clinic-wide (a steward or manager);
 * an EMPTY array means "no territories" and every query then returns nothing —
 * a representative with no assignment exports nothing, not everything.
 *
 * GOVERNANCE: no query here touches a clinical table. The static scan in
 * `pharma-firewall.test.ts` enforces that.
 */

export interface ReportFilters {
  from?: string | null;
  to?: string | null;
  jurisdiction?: string | null;
  signalType?: string | null;
}

/** Shared guard: a scoped caller with no territories gets an empty result. */
function scopedToNothing(territoryIds: string[] | null): boolean {
  return territoryIds !== null && territoryIds.length === 0;
}

export async function hcpDirectory(
  clinicId: string,
  territoryIds: string[] | null,
  limit: number,
  runner: Runner = getPool(),
): Promise<Array<Record<string, unknown>>> {
  if (scopedToNothing(territoryIds)) return [];
  const { rows } = await runner.query<{
    hcp_id: string;
    full_name: string;
    title: string | null;
    professional_category: string;
    primary_specialty: string | null;
    verification_status: string;
    last_verified_at: string | null;
    jurisdiction: string;
    source: string;
  }>(
    `SELECT h.id AS hcp_id,
            h.full_name,
            h.title,
            h.professional_category,
            s.display_name AS primary_specialty,
            pharma_effective_verification(h.verification_status, h.verification_expires_at)
              AS verification_status,
            h.last_verified_at,
            h.jurisdiction,
            h.source
       FROM hcp h
       LEFT JOIN specialty s ON s.id = h.primary_specialty_id
      WHERE h.clinic_id = $1
        AND h.status <> 'merged'
        AND ($2::uuid[] IS NULL OR EXISTS (
              SELECT 1 FROM hcp_territory ht
               WHERE ht.hcp_id = h.id AND ht.territory_id = ANY($2)))
      ORDER BY h.full_name
      LIMIT $3`,
    [clinicId, territoryIds, limit],
  );
  return rows.map((r) => ({
    hcpId: r.hcp_id,
    fullName: r.full_name,
    title: r.title,
    professionalCategory: r.professional_category,
    primarySpecialty: r.primary_specialty,
    verificationStatus: r.verification_status,
    lastVerifiedAt: r.last_verified_at,
    jurisdiction: r.jurisdiction,
    source: r.source,
  }));
}

/**
 * Directory of organisations.
 *
 * Territory-scoped through the organisation's SITES: a scoped rep sees the
 * organisations that have at least one `hco_location` in a territory assigned to
 * them — the places they would actually call at — while a clinic-wide principal
 * (null scope) sees every organisation. An empty scope yields nothing, never
 * everything. Merged organisations are excluded, exactly as merged HCPs are from
 * the HCP directory: a resolved-away identity is not a directory entry.
 *
 * Verification is DERIVED so a lapsed attestation exports as `expired`, and no
 * column here is patient-shaped — an organisation has no patients.
 */
export async function hcoDirectory(
  clinicId: string,
  territoryIds: string[] | null,
  limit: number,
  runner: Runner = getPool(),
): Promise<Array<Record<string, unknown>>> {
  if (scopedToNothing(territoryIds)) return [];
  const { rows } = await runner.query<{
    hco_id: string;
    name: string;
    hco_type: string;
    ownership_type: string;
    operating_status: string;
    country: string;
    city: string | null;
    verification_status: string;
    jurisdiction: string;
    source: string;
  }>(
    `SELECT o.id AS hco_id,
            o.name,
            o.hco_type,
            o.ownership_type,
            o.operating_status,
            o.country,
            o.city,
            pharma_effective_verification(o.verification_status, o.verification_expires_at)
              AS verification_status,
            o.jurisdiction,
            o.source
       FROM hco o
      WHERE o.clinic_id = $1
        AND o.operating_status <> 'merged'
        AND ($2::uuid[] IS NULL OR EXISTS (
              SELECT 1 FROM hco_location l
               WHERE l.hco_id = o.id AND l.territory_id = ANY($2)))
      ORDER BY o.name
      LIMIT $3`,
    [clinicId, territoryIds, limit],
  );
  return rows.map((r) => ({
    hcoId: r.hco_id,
    name: r.name,
    hcoType: r.hco_type,
    ownershipType: r.ownership_type,
    operatingStatus: r.operating_status,
    country: r.country,
    city: r.city,
    verificationStatus: r.verification_status,
    jurisdiction: r.jurisdiction,
    source: r.source,
  }));
}

export async function fieldActivity(
  clinicId: string,
  territoryIds: string[] | null,
  filters: ReportFilters,
  limit: number,
  runner: Runner = getPool(),
): Promise<Array<Record<string, unknown>>> {
  if (scopedToNothing(territoryIds)) return [];
  const { rows } = await runner.query<{
    territory_code: string | null;
    territory_name: string | null;
    hcp_id: string;
    hcp_name: string;
    visits_planned: string;
    visits_completed: string;
    last_visit_at: string | null;
  }>(
    `SELECT t.code AS territory_code,
            t.name AS territory_name,
            h.id AS hcp_id,
            h.full_name AS hcp_name,
            count(*)::text AS visits_planned,
            count(*) FILTER (WHERE v.status = 'completed')::text AS visits_completed,
            max(v.planned_at) AS last_visit_at
       FROM visit v
       JOIN hcp h ON h.id = v.hcp_id
       LEFT JOIN territory t ON t.id = v.territory_id
      WHERE v.clinic_id = $1
        AND ($2::uuid[] IS NULL OR v.territory_id = ANY($2))
        AND ($3::date IS NULL OR v.planned_at >= $3)
        AND ($4::date IS NULL OR v.planned_at < ($4::date + 1))
      GROUP BY t.code, t.name, h.id, h.full_name
      ORDER BY t.code NULLS LAST, h.full_name
      LIMIT $5`,
    [clinicId, territoryIds, filters.from ?? null, filters.to ?? null, limit],
  );
  return rows.map((r) => ({
    territoryCode: r.territory_code,
    territoryName: r.territory_name,
    hcpId: r.hcp_id,
    hcpName: r.hcp_name,
    visitsPlanned: Number(r.visits_planned),
    visitsCompleted: Number(r.visits_completed),
    lastVisitAt: r.last_visit_at,
  }));
}

export async function contentUsage(
  clinicId: string,
  territoryIds: string[] | null,
  filters: ReportFilters,
  limit: number,
  runner: Runner = getPool(),
): Promise<Array<Record<string, unknown>>> {
  if (scopedToNothing(territoryIds)) return [];
  const { rows } = await runner.query<{
    content_id: string;
    title: string;
    version: string;
    jurisdiction: string;
    channel: string;
    engagements: string;
  }>(
    `SELECT c.id AS content_id, c.title, c.version, c.jurisdiction,
            e.channel, count(*)::text AS engagements
       FROM content_engagement e
       JOIN approved_content c ON c.id = e.content_id
      WHERE e.clinic_id = $1
        AND ($2::uuid[] IS NULL OR EXISTS (
              SELECT 1 FROM hcp_territory ht
               WHERE ht.hcp_id = e.hcp_id AND ht.territory_id = ANY($2)))
        AND ($3::date IS NULL OR e.occurred_at >= $3)
        AND ($4::date IS NULL OR e.occurred_at < ($4::date + 1))
      GROUP BY c.id, c.title, c.version, c.jurisdiction, e.channel
      ORDER BY count(*) DESC, c.title
      LIMIT $5`,
    [clinicId, territoryIds, filters.from ?? null, filters.to ?? null, limit],
  );
  return rows.map((r) => ({
    contentId: r.content_id,
    title: r.title,
    version: r.version,
    jurisdiction: r.jurisdiction,
    channel: r.channel,
    engagements: Number(r.engagements),
  }));
}

/**
 * Published intelligence signals.
 *
 * Three governance properties are enforced here, in SQL:
 *  1. Only signals whose EFFECTIVE lifecycle status is `published` are eligible
 *     (0311). Effective, not stored: a claim whose shelf life has passed must
 *     drop out of exports the moment it lapses, not when a sweep next runs.
 *     A draft, a rejected claim and a withdrawn one are all equally ineligible.
 *  2. `cohort_band` is selected, never `cohort_size`. The exact size stays in
 *     the table for the operator's audit and is the raw material of a
 *     differencing attack, so it must not reach an export.
 *  3. A territory-scoped caller only sees territory-scoped signals for their own
 *     territories; coarser scopes (region/country/global) are visible to them
 *     because those are, by construction, aggregates over more than their patch.
 */
export async function intelligenceSignals(
  clinicId: string,
  territoryIds: string[] | null,
  filters: ReportFilters,
  limit: number,
  runner: Runner = getPool(),
): Promise<Array<Record<string, unknown>>> {
  if (scopedToNothing(territoryIds)) return [];
  const { rows } = await runner.query<{
    signal_type: string;
    signal_key: string;
    scope_type: string;
    scope_label: string | null;
    jurisdiction: string;
    period_start: Date | string;
    period_end: Date | string;
    value: string;
    value_unit: string;
    cohort_band: string | null;
    confidence: string;
    source: string;
    method: string;
  }>(
    `SELECT signal_type, signal_key, scope_type, scope_label, jurisdiction,
            period_start, period_end, value, value_unit, cohort_band,
            confidence, source, method
       FROM aggregated_signal
      WHERE clinic_id = $1
        AND pharma_effective_signal_status(lifecycle_status, expires_at) = 'published'
        AND ($2::uuid[] IS NULL
             OR scope_type <> 'territory'
             OR scope_id = ANY(SELECT unnest($2)::text))
        AND ($3::date IS NULL OR period_end >= $3)
        AND ($4::date IS NULL OR period_start <= $4)
        AND ($5::text IS NULL OR jurisdiction = $5)
        AND ($6::text IS NULL OR signal_type = $6)
      ORDER BY period_start DESC, signal_type, signal_key
      LIMIT $7`,
    [
      clinicId,
      territoryIds,
      filters.from ?? null,
      filters.to ?? null,
      filters.jurisdiction ?? null,
      filters.signalType ?? null,
      limit,
    ],
  );
  return rows.map((r) => ({
    signalType: r.signal_type,
    signalKey: r.signal_key,
    scopeType: r.scope_type,
    scopeLabel: r.scope_label,
    jurisdiction: r.jurisdiction,
    periodStart: toDateString(r.period_start),
    periodEnd: toDateString(r.period_end),
    value: Number(r.value),
    valueUnit: r.value_unit,
    cohortBand: r.cohort_band,
    confidence: Number(r.confidence),
    source: r.source,
    method: r.method,
  }));
}

/** Append-only receipt written BEFORE rows are returned to the caller. */
export async function insertExportLog(
  runner: Runner,
  input: {
    clinicId: string;
    actorId: string;
    reportKey: string;
    dataClass: string;
    format: string;
    filters: Record<string, unknown>;
    territoryIds: string[];
    rowCount: number;
    rowLimit: number;
    truncated: boolean;
  },
): Promise<void> {
  await runner.query(
    `INSERT INTO pharma_export_log
       (clinic_id, actor_id, report_key, data_class, format, filters, territory_ids,
        row_count, row_limit, truncated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.clinicId,
      input.actorId,
      input.reportKey,
      input.dataClass,
      input.format,
      JSON.stringify(input.filters),
      input.territoryIds,
      input.rowCount,
      input.rowLimit,
      input.truncated,
    ],
  );
}
