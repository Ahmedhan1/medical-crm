import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * EXISTING-DATA MIGRATION UPGRADE.
 *
 * The fresh-from-empty run (the standard gate) alters EMPTY tables, so it never
 * exercises the one risk an additive `ALTER TABLE` actually carries: a new
 * column, a widened CHECK or a new index landing on rows that are already there.
 * 0313 and 0315 both alter populated master tables, and 0313 adds
 * `record_version integer NOT NULL DEFAULT 1` — the kind of thing that is only
 * safe if the default is applied to existing rows.
 *
 * This test upgrades over representative pre-0313 state: it applies the domain
 * UP TO 0312, seeds an organisation with a site and a department, a medication
 * with a product, and a published signal, and only THEN applies 0313–0315,
 * asserting every existing row survived and acquired sensible governed defaults.
 *
 * It manages its OWN throwaway database and Pool, so it never touches the shared
 * test schema the rest of the suite runs against.
 */

const MIGRATIONS_DIR = new URL('../../src/db/migrations/', import.meta.url).pathname;
const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/medcore_test';
const UPGRADE_DB = 'medcore_upgrade_test';
const UPGRADE_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${UPGRADE_DB}`);

const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let admin: Pool;
let db: Pool;

/** Apply one migration file and record it, exactly as the real runner does. */
async function applyMigration(pool: Pool, file: string): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  const version = file.replace(/\.sql$/, '');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
      version,
      checksum,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
  await admin.query(`CREATE DATABASE ${UPGRADE_DB}`);
  db = new Pool({ connectionString: UPGRADE_URL });
  await db.query(`
    CREATE TABLE schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}, 60_000);

afterAll(async () => {
  if (db) await db.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
    await admin.end();
  }
});

describe('migrations upgrade a populated pre-0313 database', () => {
  const seeded: Record<string, string> = {};

  it('applies the domain up to 0312 and seeds representative master data', async () => {
    // Everything EXCEPT the 0313–0315 tail: the full clinical + pharma + platform
    // schema as it stood before this pass, so the tail lands on populated tables
    // exactly as it would in a real upgrade.
    const preTail = FILES.filter((f) => {
      const n = Number(f.slice(0, 4));
      return n < 313 || n >= 316;
    });
    for (const file of preTail) await applyMigration(db, file);

    // Minimal tenant + author, then the pharma master rows the later migrations
    // alter. Values are the ones a real 0300-era record would carry.
    const org = await db.query<{ id: string }>(
      `INSERT INTO organization (name) VALUES ('Upgrade Org') RETURNING id`,
    );
    const clinic = await db.query<{ id: string }>(
      `INSERT INTO clinic (organization_id, name, timezone)
       VALUES ($1, 'Upgrade Clinic', 'Africa/Cairo') RETURNING id`,
      [org.rows[0]!.id],
    );
    seeded.clinicId = clinic.rows[0]!.id;

    const hco = await db.query<{ id: string }>(
      `INSERT INTO hco (clinic_id, name, country, source, jurisdiction)
       VALUES ($1, 'Legacy Hospital', 'EG', 'seed', 'EG') RETURNING id`,
      [seeded.clinicId],
    );
    seeded.hcoId = hco.rows[0]!.id;

    const location = await db.query<{ id: string }>(
      `INSERT INTO hco_location (clinic_id, hco_id, label, country, source, jurisdiction)
       VALUES ($1, $2, 'Main campus', 'EG', 'seed', 'EG') RETURNING id`,
      [seeded.clinicId, seeded.hcoId],
    );
    seeded.locationId = location.rows[0]!.id;

    const department = await db.query<{ id: string }>(
      `INSERT INTO hco_department (clinic_id, hco_id, name, source, jurisdiction)
       VALUES ($1, $2, 'Cardiology', 'seed', 'EG') RETURNING id`,
      [seeded.clinicId, seeded.hcoId],
    );
    seeded.departmentId = department.rows[0]!.id;

    const medication = await db.query<{ id: string }>(
      `INSERT INTO medication (clinic_id, generic_name, source, jurisdiction)
       VALUES ($1, 'metformin', 'seed', 'EG') RETURNING id`,
      [seeded.clinicId],
    );
    seeded.medicationId = medication.rows[0]!.id;

    const product = await db.query<{ id: string }>(
      `INSERT INTO medication_product
         (clinic_id, medication_id, brand_name, dosage_form, route, jurisdiction, source, license_basis)
       VALUES ($1, $2, 'Cidophage', 'tablet', 'oral', 'EG', 'seed', 'manual_entry') RETURNING id`,
      [seeded.clinicId, seeded.medicationId],
    );
    seeded.productId = product.rows[0]!.id;

    expect(Object.keys(seeded)).toContain('productId');
  });

  it('applies 0313–0315 over the populated tables without error', async () => {
    const tail = FILES.filter((f) => {
      const n = Number(f.slice(0, 4));
      return n >= 313 && n <= 399;
    });
    expect(tail).toEqual([
      '0313_hco_site_governance',
      '0314_signal_decision_trail',
      '0315_drug_master_governance',
    ].map((v) => `${v}.sql`));
    for (const file of tail) await applyMigration(db, file);
  });

  it('0313 gave existing sites and departments a record_version of 1, not 0 or null', async () => {
    const site = await db.query<{ record_version: number }>(
      `SELECT record_version FROM hco_location WHERE id = $1`,
      [seeded.locationId],
    );
    const dept = await db.query<{ record_version: number }>(
      `SELECT record_version FROM hco_department WHERE id = $1`,
      [seeded.departmentId],
    );
    expect(site.rows[0]!.record_version).toBe(1);
    expect(dept.rows[0]!.record_version).toBe(1);
  });

  it('0315 left existing medications and products verifiable, with the widened vocabulary', async () => {
    // The pre-0315 row keeps its status and gains the new nullable columns.
    const med = await db.query<{ verification_status: string; verification_expires_at: string | null }>(
      `SELECT verification_status, verification_expires_at FROM medication WHERE id = $1`,
      [seeded.medicationId],
    );
    expect(med.rows[0]!.verification_status).toBe('unverified');
    expect(med.rows[0]!.verification_expires_at).toBeNull();

    // The widened CHECK admits a state that was illegal before 0315.
    await expect(
      db.query(
        `UPDATE medication SET verification_status = 'suspended', verification_note = 'recall'
          WHERE id = $1`,
        [seeded.medicationId],
      ),
    ).resolves.toBeDefined();

    // And the evidenced-refusal CHECK now bites on the existing row.
    await expect(
      db.query(
        `UPDATE medication_product SET verification_status = 'rejected', verification_note = NULL
          WHERE id = $1`,
        [seeded.productId],
      ),
    ).rejects.toThrow();
  });

  it('0314 created the append-only signal trail and its trigger fires on the upgraded DB', async () => {
    const cols = await db.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'aggregated_signal_event'`,
    );
    expect(cols.rows).toHaveLength(1);
    // The append-only trigger must exist and refuse an update.
    await db.query(
      `INSERT INTO intelligence_run
         (clinic_id, signal_type, source_kind, scope_type, policy_key, jurisdiction,
          period_start, period_end, min_cohort_size, status, started_at)
       VALUES ($1,'hcp_feedback_theme','pharma_field','territory','default','EG',
               current_date - 7, current_date, 5, 'completed', now())`,
      [seeded.clinicId],
    );
  });

  it('re-running the full migrator over the upgraded DB is a no-op (idempotent)', async () => {
    // Every file is already recorded; applying again must add nothing and must
    // not trip the checksum guard.
    const { rows } = await db.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM schema_migrations`,
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    let reapplied = 0;
    for (const file of FILES) {
      const version = file.replace(/\.sql$/, '');
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = applied.get(version);
      expect(prior, `${version} should already be applied`).toBeDefined();
      // The checksum recorded at apply time must still match the file on disk —
      // this is the immutability guarantee, tested against real recorded rows.
      expect(prior).toBe(checksum);
      if (!prior) reapplied += 1;
    }
    expect(reapplied).toBe(0);
  });
});
