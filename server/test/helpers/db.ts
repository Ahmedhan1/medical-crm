import { getPool, withTransaction } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createClinic,
  createUser,
  seedAccessControl,
} from '../../src/seed.js';
import type { RoleKey } from '../../src/modules/governance/permissions.js';
import { login } from '../../src/modules/auth/auth.service.js';

/** Drop everything and re-run migrations so the schema is pristine. */
export async function migrateFresh(): Promise<void> {
  const pool = getPool();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations();
}

/** Truncate all mutable data between tests but keep the schema + RBAC seed. */
export async function resetDb(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    TRUNCATE
      audit_log, event, qr_token, encounter, session,
      patient, user_role, app_user, role_permission, role, permission,
      clinic, organization
    RESTART IDENTITY CASCADE;
  `);
  await withTransaction((client) => seedAccessControl(client));
}

export interface TestClinicContext {
  clinicId: string;
  organizationId: string;
}

export async function makeClinic(name = 'Test Clinic'): Promise<TestClinicContext> {
  return withTransaction((client) => createClinic(client, `${name} Org`, name));
}

export interface TestUser {
  userId: string;
  username: string;
  password: string;
  token: string;
}

/** Create a user with a role and log them in, returning a bearer token. */
export async function makeUser(
  clinicId: string,
  username: string,
  role: RoleKey,
  password = 'password12345',
): Promise<TestUser> {
  const userId = await withTransaction((client) =>
    createUser(client, clinicId, username, username, password, role),
  );
  const result = await login(clinicId, username, password);
  return { userId, username, password, token: result.token };
}
