import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPool } from '../../src/db/pool.js';

/**
 * ARCHITECTURE GOVERNANCE — executable platform invariants (Agent 1).
 *
 * These tests exist to prevent architectural drift as Agents 2–4 keep expanding
 * their domains. Each asserts a platform rule from `docs/platform/PLATFORM-ROADMAP.md`
 * and `AGENTS.md`. A violation (a tenant table with no `clinic_id`, an un-vetted
 * dependency, a mis-numbered migration, an append-only regression) fails CI here
 * rather than being caught only in review.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, '..', '..');
const MIGRATIONS_DIR = join(SERVER_ROOT, 'src', 'db', 'migrations');

describe('governance — tenant isolation', () => {
  // Tables that legitimately have no clinic_id. Anything else must be tenant
  // scoped. Adding to this list is a deliberate governance decision.
  const GLOBAL_TABLES = new Set([
    'organization', // above the clinic boundary
    'clinic', // the tenant boundary itself
    'permission', // global RBAC catalog
    'role',
    'role_permission',
    'user_role', // scoped via user
    'session', // scoped via user
    'schema_migrations', // infra
    'automation_offset', // global processing cursor (Agent 3, review F-09)
    'backup_run', // instance-level backup ledger (Agent 1, platform) — whole-DB scope
  ]);

  it('every non-global base table carries clinic_id', async () => {
    const { rows } = await getPool().query<{ table_name: string }>(
      `SELECT t.table_name
         FROM information_schema.tables t
        WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema='public' AND c.table_name=t.table_name
               AND c.column_name='clinic_id')
        ORDER BY 1`,
    );
    const offenders = rows.map((r) => r.table_name).filter((t) => !GLOBAL_TABLES.has(t));
    expect(offenders, `tenant tables missing clinic_id: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('governance — dependency allowlist', () => {
  // Runtime dependencies require a documented decision (PLATFORM-ROADMAP.md).
  // playwright-core (Apache-2.0): drives the bundled Chromium for the optional
  // Arabic/RTL PDF renderer (docs/platform/PDF-ARABIC.md). Browser binary is
  // managed externally; the npm package is JS only.
  const ALLOWED_RUNTIME_DEPS = new Set(['fastify', 'pg', 'qrcode', 'zod', 'playwright-core']);

  it('adds no runtime dependency outside the approved allowlist', () => {
    const pkg = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    const unapproved = deps.filter((d) => !ALLOWED_RUNTIME_DEPS.has(d));
    expect(unapproved, `unapproved runtime deps: ${unapproved.join(', ')}`).toEqual([]);
  });
});

describe('governance — migration integrity', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

  // Reserved ranges from AGENTS.md / PLATFORM-ROADMAP.md.
  const RANGES: Array<[number, number, string]> = [
    [1, 99, 'foundation'],
    [100, 199, 'clinical'],
    [200, 299, 'automation'],
    [300, 399, 'pharma'],
    [900, 999, 'platform cross-cutting'],
  ];

  it('every migration is well-named NNNN_snake_case.sql', () => {
    for (const f of files) {
      expect(f, `bad migration name: ${f}`).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  it('migration numbers are unique and within a reserved range', () => {
    const seen = new Set<number>();
    for (const f of files) {
      const n = Number(f.slice(0, 4));
      expect(seen.has(n), `duplicate migration number ${n}`).toBe(false);
      seen.add(n);
      const inRange = RANGES.some(([lo, hi]) => n >= lo && n <= hi);
      expect(inRange, `migration ${f} is outside every reserved range`).toBe(true);
    }
  });
});

describe('governance — append-only platform invariants', () => {
  it('event rejects UPDATE and DELETE', async () => {
    await expect(getPool().query('DELETE FROM event')).rejects.toThrow(/append-only/);
    await expect(getPool().query('UPDATE event SET type = type')).rejects.toThrow(/append-only/);
  });

  it('audit_log rejects UPDATE and DELETE', async () => {
    await expect(getPool().query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(getPool().query('UPDATE audit_log SET action = action')).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('governance — performance indexes (F-01)', () => {
  it('the high-value platform indexes from 0900 are present', async () => {
    const { rows } = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'ix_plat_%'`,
    );
    const names = new Set(rows.map((r) => r.indexname));
    // A representative subset spanning both query axes; if the migration is
    // dropped or renamed, this fails.
    for (const expected of [
      'ix_plat_treatment_response_patient',
      'ix_plat_prescription_patient',
      'ix_plat_qr_token_clinic',
      'ix_plat_hcp_revision_clinic',
    ]) {
      expect(names.has(expected), `missing index ${expected}`).toBe(true);
    }
  });
});
