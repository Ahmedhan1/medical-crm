// Global test setup: ensure the schema exists once before the suite runs and
// the pool is closed afterwards. Individual tests reset data via resetDb().
import { afterAll, beforeAll } from 'vitest';
import { closePool } from '../../src/db/pool.js';
import { migrateFresh } from './db.js';

beforeAll(async () => {
  await migrateFresh();
});

afterAll(async () => {
  await closePool();
});
