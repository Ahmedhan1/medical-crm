import { getPool } from '../../db/pool.js';
import { AppError } from '../../domain/errors.js';
import { DataClass } from './classification.js';
import type { CohortContribution } from './firewall.js';

/**
 * Governed sources for the intelligence pipeline.
 *
 * A source is the ONLY way data enters the firewall, and there are exactly two
 * kinds:
 *
 *  - `pharma_field` — pharma's own HCP engagement data (objections, scientific
 *    questions, product discussions, competitor mentions). This is commercial
 *    data about professionals that pharma itself generated. Implemented.
 *
 *  - `clinical_governed` — an aggregate-only read over clinical data, owned by
 *    the clinical side and mediated by a contract. NOT IMPLEMENTED HERE, and
 *    deliberately so: `CCR-001` (see `CONTRACT_CHANGE_REQUEST.md`) is still
 *    PROPOSED. Until Agent 1 approves and implements the governed read, this
 *    source refuses every request. Implementing it inside the pharma workstream
 *    — by querying clinical tables directly — is exactly the shortcut the
 *    architecture forbids (§45), so the refusal below is the feature.
 */

export class GovernedSourceUnavailableError extends AppError {
  constructor(message: string, details?: unknown) {
    super(501, 'governed_read_contract_unavailable', message, details);
  }
}

export interface SourceRequest {
  clinicId: string;
  signalType: string;
  periodStart: string;
  periodEnd: string;
  /** Restricts the run to these territories; null means all in the clinic. */
  territoryIds: string[] | null;
}

export interface IntelligenceSource {
  key: 'pharma_field' | 'clinical_governed';
  available: boolean;
  description: string;
  /** Signal types this source can produce. */
  signalTypes: string[];
  fetch(request: SourceRequest): Promise<CohortContribution[]>;
}

/**
 * Signal types derivable from pharma's own field data.
 *
 * Each maps to a SQL query over pharma tables only. The *subject* of every
 * contribution is an HCP — never a patient — so the minimum-cohort threshold
 * protects individual HCPs from being identified through a small aggregate.
 */
export const FIELD_SIGNAL_TYPES = {
  /** Themes HCPs push back on, from recorded objections. */
  HCP_FEEDBACK_THEME: 'hcp_feedback_theme',
  /** What HCPs are asking medical affairs about. */
  SCIENTIFIC_QUESTION_TREND: 'scientific_question_trend',
  /** How product discussions are landing. */
  PRODUCT_INTEREST: 'product_interest',
  /** Competitors being mentioned in the field. */
  COMPETITOR_MENTION: 'competitor_mention',
  /** Supply/availability problems reported by HCPs (an objection sub-theme). */
  AVAILABILITY_SIGNAL: 'availability_signal',
} as const;

interface ContributionRow {
  subject_key: string;
  dimension: string;
  dimension_label: string | null;
  scope_id: string;
  scope_label: string;
  weight: string | number;
}

function toContributions(rows: ContributionRow[]): CohortContribution[] {
  return rows.map((row) => ({
    subjectKey: row.subject_key,
    // Every field contribution is a professional (HCP) observation. It is
    // labelled explicitly so stage 1 has something real to check.
    dataClass: DataClass.HCP_PROFESSIONAL,
    dimension: row.dimension,
    ...(row.dimension_label !== null ? { dimensionLabel: row.dimension_label } : {}),
    scopeId: row.scope_id,
    scopeLabel: row.scope_label,
    weight: typeof row.weight === 'number' ? row.weight : Number(row.weight),
  }));
}

/**
 * The territory a contribution is attributed to. An HCP targeted in several
 * territories contributes to each — the threshold is applied per cohort, so this
 * cannot be used to build a below-threshold slice.
 */
const TERRITORY_JOIN = `
  JOIN hcp_territory ht ON ht.hcp_id = src.hcp_id AND ht.clinic_id = src.clinic_id
  JOIN territory t ON t.id = ht.territory_id`;

const TERRITORY_FILTER = `
  AND ($4::uuid[] IS NULL OR ht.territory_id = ANY($4))`;

async function fetchFieldContributions(
  request: SourceRequest,
): Promise<CohortContribution[]> {
  const params = [request.clinicId, request.periodStart, request.periodEnd, request.territoryIds];

  switch (request.signalType) {
    case FIELD_SIGNAL_TYPES.HCP_FEEDBACK_THEME: {
      const { rows } = await getPool().query<ContributionRow>(
        `SELECT src.hcp_id::text AS subject_key,
                src.objection_type AS dimension,
                src.objection_type AS dimension_label,
                ht.territory_id::text AS scope_id,
                t.name AS scope_label,
                count(*) AS weight
           FROM visit_objection src ${TERRITORY_JOIN}
          WHERE src.clinic_id = $1
            AND src.created_at >= $2::date AND src.created_at < ($3::date + 1)
            ${TERRITORY_FILTER}
          GROUP BY src.hcp_id, src.objection_type, ht.territory_id, t.name`,
        params,
      );
      return toContributions(rows);
    }
    case FIELD_SIGNAL_TYPES.AVAILABILITY_SIGNAL: {
      const { rows } = await getPool().query<ContributionRow>(
        `SELECT src.hcp_id::text AS subject_key,
                coalesce(m.generic_name, 'unspecified') AS dimension,
                coalesce(m.generic_name, 'unspecified') AS dimension_label,
                ht.territory_id::text AS scope_id,
                t.name AS scope_label,
                count(*) AS weight
           FROM visit_objection src ${TERRITORY_JOIN}
           LEFT JOIN medication m ON m.id = src.medication_id
          WHERE src.clinic_id = $1
            AND src.objection_type = 'availability'
            AND src.created_at >= $2::date AND src.created_at < ($3::date + 1)
            ${TERRITORY_FILTER}
          GROUP BY src.hcp_id, m.generic_name, ht.territory_id, t.name`,
        params,
      );
      return toContributions(rows);
    }
    case FIELD_SIGNAL_TYPES.SCIENTIFIC_QUESTION_TREND: {
      const { rows } = await getPool().query<ContributionRow>(
        `SELECT src.hcp_id::text AS subject_key,
                src.request_type AS dimension,
                src.request_type AS dimension_label,
                ht.territory_id::text AS scope_id,
                t.name AS scope_label,
                count(*) AS weight
           FROM scientific_request src ${TERRITORY_JOIN}
          WHERE src.clinic_id = $1
            AND src.created_at >= $2::date AND src.created_at < ($3::date + 1)
            ${TERRITORY_FILTER}
          GROUP BY src.hcp_id, src.request_type, ht.territory_id, t.name`,
        params,
      );
      return toContributions(rows);
    }
    case FIELD_SIGNAL_TYPES.PRODUCT_INTEREST: {
      const { rows } = await getPool().query<ContributionRow>(
        `SELECT src.hcp_id::text AS subject_key,
                crp.discussion_outcome AS dimension,
                coalesce(m.generic_name, crp.product_label) AS dimension_label,
                ht.territory_id::text AS scope_id,
                t.name AS scope_label,
                count(*) AS weight
           FROM call_report src
           JOIN call_report_product crp ON crp.call_report_id = src.id
           ${TERRITORY_JOIN}
           LEFT JOIN medication m ON m.id = crp.medication_id
          WHERE src.clinic_id = $1
            AND src.submitted_at >= $2::date AND src.submitted_at < ($3::date + 1)
            ${TERRITORY_FILTER}
          GROUP BY src.hcp_id, crp.discussion_outcome, m.generic_name, crp.product_label,
                   ht.territory_id, t.name`,
        params,
      );
      return toContributions(rows);
    }
    case FIELD_SIGNAL_TYPES.COMPETITOR_MENTION: {
      const { rows } = await getPool().query<ContributionRow>(
        `SELECT src.hcp_id::text AS subject_key,
                lower(src.competitor_name) AS dimension,
                src.competitor_name AS dimension_label,
                ht.territory_id::text AS scope_id,
                t.name AS scope_label,
                count(*) AS weight
           FROM call_report_competitor src ${TERRITORY_JOIN}
          WHERE src.clinic_id = $1
            AND src.created_at >= $2::date AND src.created_at < ($3::date + 1)
            ${TERRITORY_FILTER}
          GROUP BY src.hcp_id, src.competitor_name, ht.territory_id, t.name`,
        params,
      );
      return toContributions(rows);
    }
    default:
      return [];
  }
}

export const pharmaFieldSource: IntelligenceSource = {
  key: 'pharma_field',
  available: true,
  description:
    "Pharma's own HCP engagement data (objections, scientific requests, product " +
    'discussions, competitor mentions). Subjects are HCPs; no clinical table is read.',
  signalTypes: Object.values(FIELD_SIGNAL_TYPES),
  fetch: fetchFieldContributions,
};

export const clinicalGovernedSource: IntelligenceSource = {
  key: 'clinical_governed',
  available: false,
  description:
    'Aggregate-only governed read over clinical data. Blocked pending CCR-001 ' +
    '(governed clinical read contract) — pharma code must never query clinical tables directly.',
  signalTypes: [],
  async fetch(): Promise<CohortContribution[]> {
    throw new GovernedSourceUnavailableError(
      'The governed clinical read path is not available. Aggregated clinical signals require ' +
        'contract CCR-001 to be approved and implemented by the foundation workstream; pharma ' +
        'code does not and must not read clinical tables directly.',
      { contract: 'CCR-001', status: 'PROPOSED' },
    );
  },
};

const SOURCES: Record<string, IntelligenceSource> = {
  [pharmaFieldSource.key]: pharmaFieldSource,
  [clinicalGovernedSource.key]: clinicalGovernedSource,
};

export function getSource(key: string): IntelligenceSource | null {
  return SOURCES[key] ?? null;
}

export function listSources(): IntelligenceSource[] {
  return Object.values(SOURCES);
}
