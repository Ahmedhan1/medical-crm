import pg from 'pg';
import { config } from '../config/env.js';

/**
 * Single shared connection pool. Postgres runs on the local MEDCORE box, so a
 * modest pool is appropriate for a small-clinic deployment.
 *
 * `pg` returns numeric/bigint columns as strings by default to avoid precision
 * loss; we keep that behaviour and convert explicitly at the edges where needed.
 */
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config().databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Surface pool-level errors instead of crashing the process silently.
    pool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[db] idle client error', err);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Run a function inside a single transaction, committing on success and
 * rolling back on any thrown error. This is the ONLY approved way to perform
 * multi-statement writes so that a clinical action and its audit/event rows are
 * always written atomically (all-or-nothing).
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure — original error is more useful */
    }
    throw err;
  } finally {
    client.release();
  }
}
