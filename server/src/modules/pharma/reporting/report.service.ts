import { z } from 'zod';
import { getPool } from '../../../db/pool.js';
import { NotFoundError, ValidationError } from '../../../domain/errors.js';
import { audit } from '../../governance/audit.js';
import { Permission } from '../../governance/permissions.js';
import { requirePermission, type Principal } from '../../governance/rbac.js';
import { JurisdictionSchema } from '../provenance.js';
import { territoryScopeFor } from '../visibility.js';
import {
  assertExportAllowed,
  effectiveRowLimit,
  getReportDefinition,
  listReportDefinitions,
  projectRows,
  toCsv,
  type ExportFormat,
  type ReportDefinition,
} from './export-policy.js';
import * as repo from './report.repo.js';

/**
 * Governed pharma reporting.
 *
 * The order of operations is the whole design, and it is deliberate:
 *
 *   authorize → resolve territory scope → query IN SCOPE → cap → project
 *   through the column allow-list → write the audit receipt → return
 *
 * Authorization happens before anything is read. Territory scope is pushed into
 * SQL, not applied to rows already in memory. The column allow-list is applied
 * to the DATA, so a query that starts returning a new column cannot widen an
 * export. The receipt is written before the rows are handed over, so an export
 * cannot happen without a record of it.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const RunReportSchema = z.object({
  format: z.enum(['json', 'csv']).default('json'),
  limit: z.number().int().min(1).max(10_000).optional(),
  from: DATE.optional(),
  to: DATE.optional(),
  jurisdiction: JurisdictionSchema.optional(),
  signalType: z.string().trim().min(2).max(60).optional(),
});

export interface ReportResult {
  reportKey: string;
  title: string;
  dataClass: string;
  format: ExportFormat;
  columns: readonly string[];
  rowCount: number;
  rowLimit: number;
  truncated: boolean;
  /** Present for `json`. */
  rows?: Array<Record<string, unknown>>;
  /** Present for `csv`. */
  csv?: string;
  governance: string;
}

/** The catalogue a caller may run. Read access alone is enough to SEE it. */
export function listReports(principal: Principal) {
  requirePermission(principal, Permission.PHARMA_EXPORT);
  return listReportDefinitions().map((definition) => ({
    key: definition.key,
    title: definition.title,
    description: definition.description,
    dataClass: definition.dataClass,
    permission: definition.permission,
    territoryScoped: definition.territoryScoped,
    columns: definition.columns,
    maxRows: definition.maxRows,
    cohortGoverned: definition.cohortGoverned,
  }));
}

async function fetchRows(
  definition: ReportDefinition,
  clinicId: string,
  territoryIds: string[] | null,
  filters: repo.ReportFilters,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  switch (definition.key) {
    case 'hcp_directory':
      return repo.hcpDirectory(clinicId, territoryIds, limit);
    case 'field_activity':
      return repo.fieldActivity(clinicId, territoryIds, filters, limit);
    case 'content_usage':
      return repo.contentUsage(clinicId, territoryIds, filters, limit);
    case 'intelligence_signals':
      return repo.intelligenceSignals(clinicId, territoryIds, filters, limit);
    default:
      // Unreachable: the registry and this switch are covered by a test that
      // asserts every registered report has an implementation.
      throw new ValidationError(`Report "${definition.key}" has no implementation`);
  }
}

export async function runReport(
  principal: Principal,
  reportKey: string,
  raw: unknown,
): Promise<ReportResult> {
  const definition = getReportDefinition(reportKey);
  // An unknown report is "not found", never improvised.
  if (!definition) throw new NotFoundError('Report');

  // 1. Authorize BEFORE reading anything: the report's own permission plus
  //    `pharma:export`, because seeing a record on screen is not the same right
  //    as extracting it in bulk.
  assertExportAllowed(principal, definition);

  const parsed = RunReportSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ValidationError('Invalid report request', parsed.error.flatten());
  }
  const input = parsed.data;
  if (input.from && input.to && input.to < input.from) {
    throw new ValidationError('"to" must not be before "from"');
  }

  // 2. Territory scope. `null` = clinic-wide (steward/manager); an empty array
  //    means a representative with no assignment, who exports nothing.
  const scope = definition.territoryScoped ? await territoryScopeFor(principal) : null;

  // 3. Cap, then query in scope.
  const limit = effectiveRowLimit(definition, input.limit);
  const filters: repo.ReportFilters = {
    from: input.from ?? null,
    to: input.to ?? null,
    jurisdiction: input.jurisdiction ?? null,
    signalType: input.signalType ?? null,
  };
  // One row over the cap, purely to detect truncation honestly.
  const fetched = await fetchRows(definition, principal.clinicId, scope, filters, limit + 1);
  const truncated = fetched.length > limit;
  const capped = truncated ? fetched.slice(0, limit) : fetched;

  // 4. Project through the column allow-list. Applied to the DATA, so a query
  //    returning an extra column cannot silently widen the export.
  const rows = projectRows(definition, capped);

  // 5. The receipt, written before the rows are returned. Append-only, and it
  //    records the filter SHAPE and counts — never row content.
  await repo.insertExportLog(getPool(), {
    clinicId: principal.clinicId,
    actorId: principal.userId,
    reportKey: definition.key,
    dataClass: definition.dataClass,
    format: input.format,
    filters: {
      from: filters.from,
      to: filters.to,
      jurisdiction: filters.jurisdiction,
      signalType: filters.signalType,
    },
    territoryIds: scope ?? [],
    rowCount: rows.length,
    rowLimit: limit,
    truncated,
  });
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'pharma.export',
    targetType: 'pharma_report',
    targetId: definition.key,
    metadata: {
      format: input.format,
      rowCount: rows.length,
      truncated,
      territoryScoped: definition.territoryScoped,
    },
  });

  const result: ReportResult = {
    reportKey: definition.key,
    title: definition.title,
    dataClass: definition.dataClass,
    format: input.format,
    columns: definition.columns,
    rowCount: rows.length,
    rowLimit: limit,
    truncated,
    governance:
      'Territory-scoped, column-allow-listed and audited. Aggregate reports carry ' +
      'cohort BANDS, never exact sizes. No patient-level data is exportable (§45).',
  };
  if (input.format === 'csv') result.csv = toCsv(definition, rows);
  else result.rows = rows;
  return result;
}

/** An operator's view of who exported what. Publisher-level permission only. */
export async function listExportLog(principal: Principal, limit = 50) {
  requirePermission(principal, Permission.PHARMA_EXPORT);
  const capped = Math.min(Math.max(limit, 1), 500);
  const { rows } = await getPool().query<{
    report_key: string;
    data_class: string;
    format: string;
    actor_id: string | null;
    row_count: number;
    row_limit: number;
    truncated: boolean;
    created_at: string;
  }>(
    `SELECT report_key, data_class, format, actor_id, row_count, row_limit, truncated, created_at
       FROM pharma_export_log
      WHERE clinic_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [principal.clinicId, capped],
  );
  return rows.map((r) => ({
    reportKey: r.report_key,
    dataClass: r.data_class,
    format: r.format,
    actorId: r.actor_id,
    rowCount: r.row_count,
    rowLimit: r.row_limit,
    truncated: r.truncated,
    createdAt: r.created_at,
  }));
}
