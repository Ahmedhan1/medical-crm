import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { getPool, closePool, withTransaction } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Minimal, explicit forward-only migration runner.
 *
 * - Migrations are `.sql` files named `NNNN_description.sql`, applied in order.
 * - Each is applied inside a transaction; a failure rolls that migration back
 *   so the database is never left half-migrated (blueprint §36).
 * - A checksum is stored so an already-applied migration cannot be edited
 *   silently (tamper-evidence for the schema itself).
 */
export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));

  const newlyApplied: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const version = file.replace(/\.sql$/, '');

    const prior = applied.get(version);
    if (prior) {
      if (prior !== checksum) {
        throw new Error(
          `Migration ${version} has changed since it was applied. ` +
            `Applied migrations are immutable — create a new migration instead.`,
        );
      }
      continue;
    }

    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [version, checksum],
      );
    });
    newlyApplied.push(version);
  }
  return newlyApplied;
}

// Allow `tsx src/db/migrate.ts` as a CLI entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then((applied) => {
      if (applied.length === 0) {
        // eslint-disable-next-line no-console
        console.log('[migrate] database already up to date');
      } else {
        // eslint-disable-next-line no-console
        console.log(`[migrate] applied: ${applied.join(', ')}`);
      }
      return closePool();
    })
    .catch(async (err) => {
      // eslint-disable-next-line no-console
      console.error('[migrate] failed:', err.message);
      await closePool();
      process.exit(1);
    });
}
