import { describe, expect, it } from 'vitest';
import {
  assertColumnsPermitted,
  assertExportAllowed,
  assertRegistryValid,
  effectiveRowLimit,
  ExportDataClass,
  getReportDefinition,
  listReportDefinitions,
  projectRows,
  REPORT_DEFINITIONS,
  toCsv,
  type ReportDefinition,
} from '../../src/modules/pharma/reporting/export-policy.js';
import { Permission } from '../../src/modules/governance/permissions.js';
import type { Principal } from '../../src/modules/governance/rbac.js';

function principal(...permissions: string[]): Principal {
  return {
    userId: 'u1',
    clinicId: 'c1',
    username: 'tester',
    roles: [],
    permissions: new Set(permissions),
  } as unknown as Principal;
}

const definition = REPORT_DEFINITIONS.hcp_directory!;

describe('export policy — the registry is coherent', () => {
  it('validates every declared report', () => {
    expect(() => assertRegistryValid()).not.toThrow();
  });

  it('declares a permission, a row cap and columns for every report', () => {
    for (const report of listReportDefinitions()) {
      expect(report.permission, report.key).toBeTruthy();
      expect(report.columns.length, report.key).toBeGreaterThan(0);
      expect(report.maxRows, report.key).toBeGreaterThan(0);
    }
  });

  it('confines every report to territory scope, or states why not', () => {
    for (const report of listReportDefinitions()) {
      expect(
        report.territoryScoped || Boolean(report.territoryExemptReason),
        `${report.key} must be territory-scoped or explain its exemption`,
      ).toBe(true);
    }
  });

  it('marks every aggregate report as cohort-governed', () => {
    for (const report of listReportDefinitions()) {
      if (report.dataClass === ExportDataClass.AGGREGATE) {
        expect(report.cohortGoverned, report.key).toBe(true);
      }
    }
  });

  it('returns null for an unknown report rather than improvising one', () => {
    expect(getReportDefinition('everything')).toBeNull();
  });
});

describe('export policy — forbidden columns', () => {
  it('rejects patient-shaped columns', () => {
    for (const column of [
      'patientId',
      'patient_name',
      'mrn',
      'encounterId',
      'diagnosis',
      'prescriptionId',
      'clinical_note',
      'nationalId',
      'dateOfBirth',
      'allergy',
      'narrative',
    ]) {
      expect(() => assertColumnsPermitted('probe', [column]), column).toThrow(/forbidden column/i);
    }
  });

  it('rejects an exact cohort size — the raw material of a differencing attack', () => {
    expect(() => assertColumnsPermitted('probe', ['cohortSize'])).toThrow(/forbidden column/i);
    // …while the banded form stays permitted.
    expect(() => assertColumnsPermitted('probe', ['cohortBand'])).not.toThrow();
  });

  it('allows ordinary professional and commercial columns', () => {
    expect(() =>
      assertColumnsPermitted('probe', ['hcpId', 'fullName', 'territoryCode', 'visitsCompleted']),
    ).not.toThrow();
  });

  it('no registered report emits an exact cohort size', () => {
    for (const report of listReportDefinitions()) {
      expect(report.columns, report.key).not.toContain('cohortSize');
    }
  });
});

describe('export policy — authorization', () => {
  it('requires BOTH the report permission and pharma:export', () => {
    // Reading a record on screen must not imply the right to extract it in bulk.
    expect(() => assertExportAllowed(principal(Permission.HCP_SEARCH), definition)).toThrow(
      /pharma:export/,
    );
    expect(() => assertExportAllowed(principal(Permission.PHARMA_EXPORT), definition)).toThrow(
      /requires hcp:search/,
    );
    expect(() =>
      assertExportAllowed(principal(Permission.HCP_SEARCH, Permission.PHARMA_EXPORT), definition),
    ).not.toThrow();
  });

  it('refuses a principal holding neither', () => {
    expect(() => assertExportAllowed(principal(), definition)).toThrow();
  });
});

describe('export policy — row limits', () => {
  it('defaults to the report cap', () => {
    expect(effectiveRowLimit(definition)).toBe(definition.maxRows);
  });

  it('clamps a request above the cap rather than honouring it', () => {
    expect(effectiveRowLimit(definition, 999_999)).toBe(definition.maxRows);
  });

  it('honours a smaller request', () => {
    expect(effectiveRowLimit(definition, 10)).toBe(10);
  });

  it('refuses a nonsensical limit', () => {
    expect(() => effectiveRowLimit(definition, 0)).toThrow();
    expect(() => effectiveRowLimit(definition, -5)).toThrow();
    expect(() => effectiveRowLimit(definition, 1.5)).toThrow();
  });
});

describe('export policy — column projection', () => {
  const probe: ReportDefinition = {
    key: 'probe',
    title: 'probe',
    description: 'probe',
    dataClass: ExportDataClass.COMMERCIAL,
    permission: Permission.VISIT_READ,
    territoryScoped: true,
    columns: ['a', 'b'],
    maxRows: 10,
    cohortGoverned: false,
  };

  it('drops any column the report did not declare', () => {
    // The allow-list is applied to the DATA on its way out, so a query that
    // starts returning a new column cannot widen an export by accident.
    const rows = projectRows(probe, [{ a: 1, b: 2, patientId: 'p-123', secret: 'x' }]);
    expect(rows[0]).toEqual({ a: 1, b: 2 });
    expect(JSON.stringify(rows)).not.toContain('p-123');
  });

  it('fills a declared-but-absent column with null so row shape is stable', () => {
    expect(projectRows(probe, [{ a: 1 }])[0]).toEqual({ a: 1, b: null });
  });
});

describe('export policy — CSV serialisation', () => {
  const probe: ReportDefinition = {
    key: 'probe',
    title: 'probe',
    description: 'probe',
    dataClass: ExportDataClass.COMMERCIAL,
    permission: Permission.VISIT_READ,
    territoryScoped: true,
    columns: ['name', 'note'],
    maxRows: 10,
    cohortGoverned: false,
  };

  it('writes a header and quotes separators, quotes and newlines', () => {
    const csv = toCsv(probe, [{ name: 'a,b', note: 'say "hi"' }, { name: 'x\ny', note: null }]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('name,note');
    expect(lines[1]).toBe('"a,b","say ""hi"""');
    expect(csv).toContain('"x\ny"');
  });

  it('neutralises spreadsheet formula injection', () => {
    // An export that opens in Excel is an injection surface, not just a file.
    const csv = toCsv(probe, [{ name: '=cmd|calc', note: '+1' }, { name: '@x', note: '-2' }]);
    expect(csv).toContain("'=cmd|calc");
    expect(csv).toContain("'+1");
    expect(csv).toContain("'@x");
    expect(csv).toContain("'-2");
  });

  it('emits an empty cell for null rather than the string "null"', () => {
    expect(toCsv(probe, [{ name: null, note: undefined }])).toBe('name,note\r\n,');
  });
});
