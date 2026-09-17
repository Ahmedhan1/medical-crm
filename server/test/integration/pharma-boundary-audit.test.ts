import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pharmaPermissions } from '../../src/modules/governance/permissions.pharma.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { PharmaEventType } from '../../src/domain/events.pharma.js';

/**
 * CROSS-DOMAIN BOUNDARY AUDIT, from the Pharma side.
 *
 * Agents 2 and 3 own the clinical and AI code; Agent 4 owns the boundary
 * ASSERTIONS about it. These are static, repo-wide checks, so the audit is a
 * property the build enforces rather than a reading someone took once. If a
 * future clinical or AI change crosses the line, this suite fails in Agent 4's
 * own tests and the finding is raised as a CCR rather than discovered later.
 *
 * Nothing here modifies Agent-2 or Agent-3 code; it only reads it.
 */

const SRC = new URL('../../src/', import.meta.url).pathname;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.sql')) out.push(full);
  }
  return out;
}

const ALL_FILES = walk(SRC);
const read = (f: string) => readFileSync(f, 'utf8');

/** Table names created by the pharma migration range. */
const PHARMA_TABLES = (() => {
  const names = new Set<string>();
  for (const file of ALL_FILES.filter((f) => /migrations\/03\d\d_/.test(f))) {
    for (const match of read(file).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)) {
      names.add(match[1]!);
    }
  }
  return [...names];
})();

/** Table names created by the clinical migration range. */
const CLINICAL_TABLES = (() => {
  const names = new Set<string>();
  for (const file of ALL_FILES.filter((f) => /migrations\/01\d\d_/.test(f))) {
    for (const match of read(file).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)) {
      names.add(match[1]!);
    }
  }
  return [...names];
})();

/**
 * Route files are matched by their EXACT basename. An earlier prefix match on
 * `rep` also caught `reports.routes.ts`, which is Agent 2's clinical reporting —
 * classifying a clinical file as pharma would have made this whole suite lie.
 */
const PHARMA_ROUTE_FILES = new Set([
  'hcp.routes.ts',
  'hco.routes.ts',
  'rep.routes.ts',
  'intelligence.routes.ts',
  'medication.routes.ts',
  'pharma-content.routes.ts',
  'pharma-reporting.routes.ts',
  'pharma.feature.ts',
]);
const PHARMA_MODULES = ALL_FILES.filter(
  (f) =>
    /modules\/(pharma|hcp|drug|intelligence)\//.test(f) ||
    PHARMA_ROUTE_FILES.has(f.slice(f.lastIndexOf('/') + 1)),
);
const FOREIGN_MODULES = ALL_FILES.filter((f) =>
  /modules\/(ai|automation|clinical|messaging|workflow)\//.test(f),
);

/** `FROM x`, `JOIN x`, `INTO x`, `UPDATE x`, `DELETE FROM x` for any table in `tables`. */
function accessPattern(tables: string[]): RegExp {
  return new RegExp(
    `\\b(from|join|into|update|delete\\s+from)\\s+"?(${tables.join('|')})\\b`,
    'i',
  );
}

describe('boundary — the audit set is not stale', () => {
  it('covers every route file the pharma feature registers', () => {
    const feature = read(join(SRC, 'http/features/pharma.feature.ts'));
    const registered = [...feature.matchAll(/from '\.\.\/routes\/([\w.-]+)\.js'/g)].map(
      (m) => `${m[1]!}.ts`,
    );
    expect(registered.length).toBeGreaterThan(4);
    for (const file of registered) {
      expect(PHARMA_ROUTE_FILES.has(file), `${file} is registered but not audited`).toBe(true);
    }
    // And the derivation tracks the registrations, so a new route cannot slip in.
    expect(registered.length).toBe((feature.match(/app\.register\(/g) ?? []).length);
  });

  it('classifies a meaningful number of files on each side', () => {
    expect(PHARMA_MODULES.length).toBeGreaterThan(20);
    expect(FOREIGN_MODULES.length).toBeGreaterThan(20);
    // No file may be on both sides, or a violation could hide in the overlap.
    const foreign = new Set(FOREIGN_MODULES);
    for (const file of PHARMA_MODULES) expect(foreign.has(file), file).toBe(false);
  });
});

describe('boundary — Pharma cannot reach Clinical', () => {
  it('no pharma file contains a statement against a clinical table', () => {
    const pattern = accessPattern(CLINICAL_TABLES);
    expect(CLINICAL_TABLES.length).toBeGreaterThan(10);
    for (const file of PHARMA_MODULES) {
      const offending = read(file)
        .split('\n')
        .filter((line) => !/^\s*(--|\*|\/\/|\/\*)/.test(line))
        .filter((line) => pattern.test(line));
      expect(offending, `${file}:\n${offending.join('\n')}`).toEqual([]);
    }
  });

  it('no pharma file imports a clinical, AI, automation or messaging module', () => {
    for (const file of PHARMA_MODULES) {
      const imports = [...read(file).matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const specifier of imports) {
        expect(
          /\/(clinical|ai|automation|messaging|workflow)\//.test(specifier),
          `${file} imports ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it('the FHIR mappers are not reachable over HTTP at all', () => {
    // They map Patient, Encounter, Observation, MedicationRequest and more. No
    // route file references them, so today they cannot be an access path for
    // anyone — pharma included. Recorded for Agent 2: when FHIR endpoints do
    // land, no pharma permission may appear in their authorization.
    const routeFiles = ALL_FILES.filter((f) => /http\/(routes|features)\//.test(f));
    for (const file of routeFiles) {
      expect(read(file).toLowerCase(), `${file} references fhir`).not.toContain('fhir');
    }
  });

  it('no pharma role holds a clinical permission, and no clinical role holds a pharma one', () => {
    const pharmaRoles = [
      RoleKey.PHARMA_REP,
      RoleKey.PHARMA_DATA_STEWARD,
      RoleKey.MEDICAL_AFFAIRS,
      RoleKey.PHARMA_MANAGER,
    ];
    const pharmaPrefixes = [
      'hcp:', 'hco:', 'medication:', 'territory:', 'visit:', 'callreport:',
      'scientificrequest:', 'content:', 'segment:', 'campaign:', 'intelligence:', 'pharma:',
    ];
    for (const role of pharmaRoles) {
      const grants = (pharmaPermissions.roleGrants[role] ?? []) as string[];
      expect(grants.length).toBeGreaterThan(0);
      for (const permission of grants) {
        expect(
          pharmaPrefixes.some((prefix) => permission.startsWith(prefix)),
          `${role} holds non-pharma permission ${permission}`,
        ).toBe(true);
      }
    }
    // And the reverse: the other workstreams' grant files never name a pharma
    // permission, so a clinical or AI role cannot inherit one.
    for (const file of ALL_FILES.filter((f) => /permissions\.(clinical|automation|platform)\.ts$/.test(f))) {
      for (const prefix of pharmaPrefixes) {
        expect(read(file), `${file} grants ${prefix}*`).not.toContain(`'${prefix}`);
      }
    }
  });
});

describe('boundary — Clinical, AI and automation cannot reach Pharma', () => {
  it('no clinical, AI, automation or messaging file queries a pharma table', () => {
    const pattern = accessPattern(PHARMA_TABLES);
    expect(PHARMA_TABLES.length).toBeGreaterThan(30);
    for (const file of FOREIGN_MODULES) {
      const offending = read(file)
        .split('\n')
        .filter((line) => !/^\s*(--|\*|\/\/|\/\*)/.test(line))
        .filter((line) => pattern.test(line));
      expect(offending, `${file}:\n${offending.join('\n')}`).toEqual([]);
    }
  });

  it('no AI tool or automation action can mutate pharma state', () => {
    // The whole executable surface: AI kernel tool ids and automation action
    // handler types. A pharma-shaped entry here would be an autonomous path
    // into this workstream.
    const toolIds = new Set<string>();
    for (const file of ALL_FILES.filter((f) => /modules\/ai\/kernel\//.test(f))) {
      for (const m of read(file).matchAll(/\bid: '([a-z0-9._-]+)'/g)) toolIds.add(m[1]!);
    }
    const actionTypes = new Set<string>();
    for (const file of ALL_FILES.filter((f) => /modules\/automation\/actions\.ts$/.test(f))) {
      for (const m of read(file).matchAll(/\btype: '([a-z0-9._-]+)'/g)) actionTypes.add(m[1]!);
    }
    expect(toolIds.size).toBeGreaterThan(0);
    expect(actionTypes.size).toBeGreaterThan(0);
    const pharmaish = /(hcp|hco|pharma|medication|territory|visit|call.?report|signal|intelligence|segment|campaign|scientific)/i;
    for (const id of [...toolIds, ...actionTypes]) {
      expect(pharmaish.test(id), `executable surface exposes ${id}`).toBe(false);
    }
  });
});

describe('boundary — what Pharma puts on the shared bus (CCR-011)', () => {
  it('no pharma event payload key is patient-shaped or free text', () => {
    // Automation can bind a rule to any event type (`automation_rule.event_type`
    // is unconstrained), so what pharma PUTS on the bus is the real boundary.
    const keys = new Set<string>();
    for (const file of PHARMA_MODULES) {
      for (const block of read(file).matchAll(/payload: \{([^}]*)\}/g)) {
        for (const m of block[1]!.matchAll(/([a-zA-Z][a-zA-Z0-9]*)\s*:/g)) keys.add(m[1]!);
      }
    }
    expect(keys.size).toBeGreaterThan(10);
    const forbidden = /(patient|mrn|nationalid|encounter|diagnosis|allerg|prescription|summary|question|body|text|note)/i;
    for (const key of keys) {
      expect(forbidden.test(key), `pharma event payload carries "${key}"`).toBe(false);
    }
  });

  it('every pharma event type is namespaced to this workstream', () => {
    const allowed =
      /^(HCP|HCO|MEDICATION|TERRITORY|VISIT|CALL_REPORT|SCIENTIFIC_REQUEST|CONTENT|SEGMENT|CAMPAIGN|INTELLIGENCE|FIELD_REP|FOLLOW_UP|OBJECTION|COMPETITOR)_/;
    for (const type of Object.values(PharmaEventType)) {
      expect(allowed.test(type), `${type} is not clearly a pharma event`).toBe(true);
    }
  });
});

describe('boundary — CCR-004 stays fail-closed', () => {
  it('the governed clinical source is declared unavailable and throws', () => {
    const sources = read(join(SRC, 'modules/intelligence/sources.ts'));
    expect(sources).toContain('available: false');
    expect(sources).toContain('GovernedSourceUnavailableError');
    // No handler: an unavailable source has nothing to execute.
    expect(sources).not.toMatch(/clinicalGovernedSource[\s\S]{0,400}?fetch:\s*async/);
  });

  it('nothing in the pharma tree names a clinical table as a source', () => {
    const sources = read(join(SRC, 'modules/intelligence/sources.ts'));
    const pattern = accessPattern(CLINICAL_TABLES);
    const offending = sources
      .split('\n')
      .filter((line) => !/^\s*(--|\*|\/\/|\/\*)/.test(line))
      .filter((line) => pattern.test(line));
    expect(offending).toEqual([]);
  });
});
