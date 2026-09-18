import { describe, expect, it, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db.js';
import { getPool } from '../../src/db/pool.js';
import { seedAdmin } from '../../src/seed-admin.js';

/**
 * Production admin bootstrap: creates exactly one admin with a generated one-time
 * password, and is idempotent (never creates a second admin or resets a password).
 */
describe('seedAdmin (installer bootstrap)', () => {
  beforeEach(async () => {
    await resetDb();
    // resetDb re-seeds RBAC and truncates users, giving us an empty user table.
    await getPool().query('TRUNCATE app_user CASCADE');
  });

  it('creates one ADMIN with a strong generated password on a fresh box', async () => {
    const r = await seedAdmin();
    expect(r.created).toBe(true);
    if (!r.created) return;
    expect(r.username).toBe('admin');
    expect(r.password.length).toBeGreaterThanOrEqual(20);

    const { rows } = await getPool().query(
      `SELECT r.key FROM app_user u
         JOIN user_role ur ON ur.user_id = u.id
         JOIN role r ON r.id = ur.role_id
        WHERE u.username = 'admin'`,
    );
    expect(rows.map((x) => x.key)).toContain('ADMIN');
  });

  it('is idempotent — a second run makes no changes', async () => {
    await seedAdmin();
    const before = await getPool().query('SELECT count(*)::int AS n FROM app_user');
    const second = await seedAdmin();
    const after = await getPool().query('SELECT count(*)::int AS n FROM app_user');
    expect(second.created).toBe(false);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
