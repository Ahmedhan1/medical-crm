import { getPool, closePool } from './pool.js';
import { config } from '../config/env.js';

/**
 * Reset the target database to an EMPTY schema, using `pg` — no `psql` binary.
 *
 * CI runs the "migrations apply from an empty database" gate inside the Playwright
 * container (which ships Chromium for the PDF regression but NOT the Postgres
 * client), so a `psql -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`
 * step fails with `psql: not found`. This does the identical reset over the
 * shared connection pool, so the empty-migration gate needs no extra binary.
 *
 * It is destructive by design (it drops every object in `public`), so it refuses
 * to run against a production database — the from-empty gate is a test/CI concern
 * only. It targets whatever `config().databaseUrl` resolves to, which is
 * `TEST_DATABASE_URL` when `NODE_ENV=test` (same URL the migrate step uses).
 */
export async function resetSchema(): Promise<void> {
  if (config().nodeEnv === 'production') {
    throw new Error('reset-schema refuses to run with NODE_ENV=production');
  }
  const pool = getPool();
  // Single statement, mirroring the previous psql reset exactly.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

// Allow `tsx src/db/reset-schema.ts` as a CLI entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  resetSchema()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('[reset-schema] public schema reset to empty');
      return closePool();
    })
    .catch(async (err) => {
      // eslint-disable-next-line no-console
      console.error('[reset-schema] failed:', err.message);
      await closePool();
      process.exit(1);
    });
}
