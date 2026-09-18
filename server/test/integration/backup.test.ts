import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import pg from 'pg';
import { config } from '../../src/config/env.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, resetDb } from '../helpers/db.js';
import {
  createBackup,
  verifyBackup,
  restoreBackup,
} from '../../src/modules/backup/backup.service.js';

const SCRATCH_DB = 'medcore_restore_check';

function baseUrl(dbName: string): string {
  const u = new URL(config().databaseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function maintenance(fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: baseUrl('postgres') });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  await maintenance(async (c) => {
    await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [SCRATCH_DB],
    );
    await c.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  }).catch(() => {});
  await rm(config().backup.dir, { recursive: true, force: true }).catch(() => {});
});

describe('backup → reset → restore → verify (recovery round-trip)', () => {
  let sourceMigrations = 0;
  let sourceTables = 0;
  let clinicId = '';
  let patientId = '';

  beforeAll(async () => {
    await resetDb();
    ({ clinicId } = await makeClinic());
    // A representative clinical row to prove real data survives the round-trip.
    const ins = await getPool().query<{ id: string }>(
      `INSERT INTO patient (clinic_id, mrn, full_name, sex)
       VALUES ($1, 'MRN-BK-0001', 'Backup Test Patient', 'male') RETURNING id`,
      [clinicId],
    );
    patientId = ins.rows[0]!.id;

    const m = await getPool().query<{ n: string }>(
      'SELECT count(*)::text n FROM schema_migrations',
    );
    const t = await getPool().query<{ n: string }>(
      `SELECT count(*)::text n FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE'`,
    );
    sourceMigrations = Number(m.rows[0]!.n);
    sourceTables = Number(t.rows[0]!.n);
  });

  it('creates a completed backup with integrity metadata (no PHI)', async () => {
    const run = await createBackup(null, 'manual');
    expect(run.status).toBe('completed');
    expect(run.byteSize).toBeGreaterThan(0);
    expect(run.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.tableCount).toBe(sourceTables);
    expect(run.migrationsApplied).toBe(sourceMigrations);
    // The ledger row must not carry PHI.
    expect(JSON.stringify(run)).not.toMatch(/Backup Test Patient/);
  });

  it('verifies a backup by checksum + archive readability', async () => {
    const run = await createBackup(null, 'manual');
    const v = await verifyBackup(null, run.id);
    expect(v).toEqual({ ok: true, checksumMatches: true, archiveReadable: true });
  });

  it('restores into a fresh database and the data + protections survive', async () => {
    const run = await createBackup(null, 'manual');

    // Simulate disaster: a brand-new empty database.
    await maintenance(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
      await c.query(`CREATE DATABASE ${SCRATCH_DB}`);
    });

    await restoreBackup(baseUrl(SCRATCH_DB), run.id);

    const scratch = new pg.Client({ connectionString: baseUrl(SCRATCH_DB) });
    await scratch.connect();
    try {
      // Migration state preserved.
      const mig = await scratch.query<{ n: string }>(
        'SELECT count(*)::text n FROM schema_migrations',
      );
      expect(Number(mig.rows[0]!.n)).toBe(sourceMigrations);

      // Full schema preserved.
      const tab = await scratch.query<{ n: string }>(
        `SELECT count(*)::text n FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'`,
      );
      expect(Number(tab.rows[0]!.n)).toBe(sourceTables);

      // Representative clinical record preserved.
      const pat = await scratch.query(`SELECT full_name FROM patient WHERE id=$1`, [patientId]);
      expect(pat.rows[0]?.full_name).toBe('Backup Test Patient');

      // RBAC catalog preserved.
      const perms = await scratch.query<{ n: string }>('SELECT count(*)::text n FROM permission');
      expect(Number(perms.rows[0]!.n)).toBeGreaterThan(0);

      // Append-only protections (triggers) survived the restore.
      await expect(scratch.query('DELETE FROM event')).rejects.toThrow(/append-only/);
      await expect(scratch.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);

      // A high-value platform index survived the restore.
      const idx = await scratch.query<{ n: string }>(
        `SELECT count(*)::text n FROM pg_indexes
          WHERE schemaname='public' AND indexname='ix_plat_prescription_patient'`,
      );
      expect(Number(idx.rows[0]!.n)).toBe(1);

      // Every workstream's schema survived the restore (integrated recovery §11):
      // clinical, automation/AI-governance, and pharma/intelligence tables.
      for (const table of [
        'appointment', // clinical scheduling (0105)
        'allergy', // clinical safety (0107)
        'ai_generation', // AI governance/observability (0200)
        'aggregated_signal', // pharma intelligence firewall (0304)
        'backup_run', // platform ledger (0901)
      ]) {
        const t = await scratch.query<{ n: string }>(
          `SELECT count(*)::text n FROM information_schema.tables
            WHERE table_schema='public' AND table_name=$1`,
          [table],
        );
        expect(Number(t.rows[0]!.n), `restored DB missing ${table}`).toBe(1);
      }
    } finally {
      await scratch.end();
    }
  });
});
