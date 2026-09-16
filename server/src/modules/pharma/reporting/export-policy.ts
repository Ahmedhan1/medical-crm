import { ForbiddenError, ValidationError } from '../../../domain/errors.js';
import { Permission } from '../../governance/permissions.js';
import { hasPermission, type Principal } from '../../governance/rbac.js';

/**
 * PHARMA REPORTING — the export policy.
 *
 * An export is the highest-risk read in the platform: it leaves the system, it
 * is rarely re-checked, and a single over-broad column list can undo every
 * authorization decision made upstream. This module is therefore a *registry*
 * rather than a set of ad-hoc queries — a report can only be produced if it is
 * declared here, and a declaration must state, explicitly:
 *
 *   - the permission required to run it,
 *   - what class of data it emits,
 *   - whether it is confined to the caller's territories,
 *   - the exact columns it may contain,
 *   - a hard row cap.
 *
 * Everything is a pure function over the declaration, so the rules are testable
 * without a database and a new report cannot quietly skip one.
 *
 * WHAT THIS DOES NOT DO: it does not render PDFs. Agent 1 owns the platform PDF
 * primitive (`modules/platform/pdf`) and Agent 2 owns the clinical report
 * engine; duplicating either would be a second export framework, which the
 * workstream brief forbids. Pharma exports emit rows (JSON/CSV) and a renderer
 * can be layered on later by reusing the platform primitive.
 */

/**
 * The class of data a report emits. There is deliberately no clinical class:
 * a pharma report that needed one would be a firewall breach, not a new enum
 * member (blueprint §45).
 */
export const ExportDataClass = {
  /** Threshold-gated, de-identified aggregates from the intelligence layer. */
  AGGREGATE: 'aggregate',
  /** Professional facts about HCPs/HCOs — master data, not patient data. */
  HCP_PROFESSIONAL: 'hcp_professional',
  /** This company's own commercial activity: visits, campaigns, content use. */
  COMMERCIAL: 'commercial',
} as const;
export type ExportDataClass = (typeof ExportDataClass)[keyof typeof ExportDataClass];

export type ExportFormat = 'json' | 'csv';

export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
  dataClass: ExportDataClass;
  /** Permission required to run this report at all. */
  permission: Permission;
  /**
   * When true, the rows are confined to the caller's territory scope. Only a
   * report whose subject has no territory dimension may set this false, and the
   * reason must be stated in `territoryExemptReason`.
   */
  territoryScoped: boolean;
  territoryExemptReason?: string;
  /**
   * The ONLY columns this report may emit. Anything a query returns that is not
   * on this list is dropped before the rows leave the service — an allow-list,
   * so adding a column to an underlying table can never silently widen an
   * export.
   */
  columns: readonly string[];
  /** Hard cap on rows; the caller may ask for fewer, never more. */
  maxRows: number;
  /**
   * Aggregate reports must go through the intelligence layer's cohort
   * governance rather than reading rows directly.
   */
  cohortGoverned: boolean;
}

/**
 * Column-name shapes that must never appear in a pharma export, whatever the
 * report declares. This is a belt-and-braces check on top of the allow-list:
 * the allow-list stops unknown columns, and this stops a *declared* column from
 * being a patient field because someone added it to a definition by mistake.
 */
const FORBIDDEN_COLUMN_PATTERNS: readonly RegExp[] = [
  /patient/i,
  /\bmrn\b/i,
  /encounter/i,
  /diagnos/i,
  /prescription/i,
  /clinical_note/i,
  /\ballerg/i,
  /national_?id/i,
  /date_?of_?birth|\bdob\b|birth_?date/i,
  /\bnarrative\b/i,
  /cohort_?size$/i, // exact cohort sizes are the raw material of differencing
];

/** Throw if any declared column is patient-shaped or otherwise forbidden. */
export function assertColumnsPermitted(reportKey: string, columns: readonly string[]): void {
  for (const column of columns) {
    for (const pattern of FORBIDDEN_COLUMN_PATTERNS) {
      if (pattern.test(column)) {
        throw new ValidationError(
          `Report "${reportKey}" declares a forbidden column "${column}". ` +
            'Pharma exports never carry patient-identifiable or re-identifying fields.',
          { reportKey, column },
        );
      }
    }
  }
}

/**
 * The report registry.
 *
 * Kept small and explicit on purpose: every entry is a decision about what may
 * leave the system, and a short list that is understood beats a long one that
 * is not.
 */
export const REPORT_DEFINITIONS: Readonly<Record<string, ReportDefinition>> = Object.freeze({
  hcp_directory: {
    key: 'hcp_directory',
    title: 'HCP directory',
    description:
      'Professional directory of HCPs in the caller’s territories, with verification state.',
    dataClass: ExportDataClass.HCP_PROFESSIONAL,
    permission: Permission.HCP_SEARCH,
    territoryScoped: true,
    columns: [
      'hcpId',
      'fullName',
      'title',
      'professionalCategory',
      'primarySpecialty',
      'verificationStatus',
      'lastVerifiedAt',
      'jurisdiction',
      'source',
    ],
    maxRows: 5000,
    cohortGoverned: false,
  },
  field_activity: {
    key: 'field_activity',
    title: 'Field activity',
    description:
      'This company’s own visit activity: counts and outcomes per HCP, never clinical content.',
    dataClass: ExportDataClass.COMMERCIAL,
    permission: Permission.VISIT_READ,
    territoryScoped: true,
    columns: [
      'territoryCode',
      'territoryName',
      'hcpId',
      'hcpName',
      'visitsPlanned',
      'visitsCompleted',
      'lastVisitAt',
    ],
    maxRows: 5000,
    cohortGoverned: false,
  },
  content_usage: {
    key: 'content_usage',
    title: 'Approved content usage',
    description: 'Which approved content was presented, by channel — commercial engagement only.',
    dataClass: ExportDataClass.COMMERCIAL,
    permission: Permission.CONTENT_READ,
    territoryScoped: true,
    columns: ['contentId', 'title', 'version', 'jurisdiction', 'channel', 'engagements'],
    maxRows: 5000,
    cohortGoverned: false,
  },
  intelligence_signals: {
    key: 'intelligence_signals',
    title: 'Published intelligence signals',
    description:
      'Threshold-gated, de-identified aggregate signals. Carries cohort BANDS, never exact sizes.',
    dataClass: ExportDataClass.AGGREGATE,
    permission: Permission.INTELLIGENCE_SIGNAL_READ,
    territoryScoped: true,
    columns: [
      'signalType',
      'signalKey',
      'scopeType',
      'scopeLabel',
      'jurisdiction',
      'periodStart',
      'periodEnd',
      'value',
      'valueUnit',
      'cohortBand',
      'confidence',
      'source',
      'method',
    ],
    maxRows: 2000,
    cohortGoverned: true,
  },
});

export function getReportDefinition(key: string): ReportDefinition | null {
  return REPORT_DEFINITIONS[key] ?? null;
}

export function listReportDefinitions(): ReportDefinition[] {
  return Object.values(REPORT_DEFINITIONS);
}

/**
 * Validate the whole registry.
 *
 * Called by a test rather than at import time, so a bad definition is a build
 * failure in CI rather than a crash at boot — but it exists so that "the
 * registry is coherent" is an asserted property, not an assumption.
 */
export function assertRegistryValid(): void {
  for (const definition of Object.values(REPORT_DEFINITIONS)) {
    assertColumnsPermitted(definition.key, definition.columns);
    if (definition.columns.length === 0) {
      throw new ValidationError(`Report "${definition.key}" declares no columns`);
    }
    if (definition.maxRows <= 0 || definition.maxRows > 10_000) {
      throw new ValidationError(`Report "${definition.key}" has an unreasonable row cap`);
    }
    if (!definition.territoryScoped && !definition.territoryExemptReason) {
      throw new ValidationError(
        `Report "${definition.key}" opts out of territory scope without stating why`,
      );
    }
    if (definition.dataClass === ExportDataClass.AGGREGATE && !definition.cohortGoverned) {
      throw new ValidationError(
        `Report "${definition.key}" emits aggregates but is not cohort-governed`,
      );
    }
  }
}

/** Authorization for an export. Permission first, then the data-class rule. */
export function assertExportAllowed(principal: Principal, definition: ReportDefinition): void {
  if (!hasPermission(principal, definition.permission)) {
    throw new ForbiddenError(
      `Exporting "${definition.key}" requires ${definition.permission}`,
    );
  }
  // Every pharma export additionally requires the export permission itself, so
  // read access to a screen never silently implies the right to extract it.
  if (!hasPermission(principal, Permission.PHARMA_EXPORT)) {
    throw new ForbiddenError(
      'Exporting pharma data requires the pharma:export permission. Reading a ' +
        'record on screen does not by itself authorise extracting it in bulk.',
    );
  }
}

/** Clamp a requested row count to the report's cap. */
export function effectiveRowLimit(definition: ReportDefinition, requested?: number): number {
  if (requested === undefined) return definition.maxRows;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new ValidationError('limit must be a positive integer');
  }
  return Math.min(requested, definition.maxRows);
}

/**
 * Project rows onto the report's declared columns.
 *
 * The allow-list is applied to the DATA on its way out, not merely to the SQL,
 * so a query that starts returning a new column cannot widen an export by
 * accident. Unknown keys are dropped silently; declared-but-absent keys become
 * `null` so the shape of a row is stable for a CSV header.
 */
export function projectRows(
  definition: ReportDefinition,
  rows: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const projected: Record<string, unknown> = {};
    for (const column of definition.columns) {
      projected[column] = row[column] ?? null;
    }
    return projected;
  });
}

/**
 * Serialise rows as CSV.
 *
 * Hand-rolled rather than taking a dependency: the format needed here is a
 * header plus RFC4180 quoting, which is a dozen lines, and the workstream's
 * dependency policy is to add nothing the platform can already do.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with an apostrophe so a spreadsheet
 * does not execute the cell as a formula — an export that opens in Excel is an
 * injection surface, not just a file.
 */
export function toCsv(
  definition: ReportDefinition,
  rows: ReadonlyArray<Record<string, unknown>>,
): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  const header = definition.columns.join(',');
  const body = rows.map((row) => definition.columns.map((c) => escape(row[c])).join(','));
  return [header, ...body].join('\r\n');
}
