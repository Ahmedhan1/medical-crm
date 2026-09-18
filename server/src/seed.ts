import { getPool, closePool, withTransaction, type PoolClient } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { hashPassword } from './modules/auth/password.js';
import {
  PERMISSION_DESCRIPTIONS,
  ROLE_DEFINITIONS,
  RoleKey,
  type Permission,
} from './modules/governance/permissions.js';

/**
 * Seed the RBAC catalog (permissions, roles, role→permission grants) from the
 * single source of truth in permissions.ts. Idempotent: safe to run on every
 * boot so the DB stays in sync with the code definitions.
 */
export async function seedAccessControl(client: PoolClient): Promise<void> {
  for (const [key, description] of Object.entries(PERMISSION_DESCRIPTIONS)) {
    await client.query(
      `INSERT INTO permission (key, description) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`,
      [key, description],
    );
  }

  for (const [roleKey, def] of Object.entries(ROLE_DEFINITIONS)) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO role (key, description) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description
       RETURNING id`,
      [roleKey, def.description],
    );
    const roleId = rows[0]!.id;
    // Reset grants to exactly match the definition (declarative).
    await client.query(`DELETE FROM role_permission WHERE role_id = $1`, [roleId]);
    for (const perm of def.permissions as Permission[]) {
      await client.query(
        `INSERT INTO role_permission (role_id, permission_key) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [roleId, perm],
      );
    }
  }
}

export interface SeededClinic {
  organizationId: string;
  clinicId: string;
}

/** Create an organization + clinic. Returns their ids. */
export async function createClinic(
  client: PoolClient,
  orgName: string,
  clinicName: string,
  country = 'EG',
  timezone = 'Africa/Cairo',
): Promise<SeededClinic> {
  const org = await client.query<{ id: string }>(
    `INSERT INTO organization (name, country, timezone) VALUES ($1,$2,$3) RETURNING id`,
    [orgName, country, timezone],
  );
  const organizationId = org.rows[0]!.id;
  const clinic = await client.query<{ id: string }>(
    `INSERT INTO clinic (organization_id, name, timezone) VALUES ($1,$2,$3) RETURNING id`,
    [organizationId, clinicName, timezone],
  );
  return { organizationId, clinicId: clinic.rows[0]!.id };
}

/** Create a user in a clinic and assign a role. Returns the user id. */
export async function createUser(
  client: PoolClient,
  clinicId: string,
  username: string,
  displayName: string,
  password: string,
  roleKey: RoleKey,
): Promise<string> {
  const passwordHash = await hashPassword(password);
  const user = await client.query<{ id: string }>(
    `INSERT INTO app_user (clinic_id, username, display_name, password_hash)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [clinicId, username, displayName, passwordHash],
  );
  const userId = user.rows[0]!.id;
  await client.query(
    `INSERT INTO user_role (user_id, role_id)
     SELECT $1, id FROM role WHERE key = $2`,
    [userId, roleKey],
  );
  return userId;
}

/** CLI: migrate, seed RBAC, and create a demo clinic with sample users. */
async function main(): Promise<void> {
  await runMigrations();

  const summary = await withTransaction(async (client) => {
    await seedAccessControl(client);

    // Only create the demo clinic once.
    const existing = await client.query(`SELECT id FROM clinic LIMIT 1`);
    if (existing.rows.length > 0) {
      return { created: false, clinicId: existing.rows[0]!.id as string };
    }

    const { clinicId } = await createClinic(client, 'MedCore Demo Org', 'Main Clinic');
    await createUser(client, clinicId, 'admin', 'Clinic Admin', 'admin12345', RoleKey.ADMIN);
    await createUser(client, clinicId, 'reception', 'Front Desk', 'reception12345', RoleKey.RECEPTION);
    await createUser(client, clinicId, 'doctor', 'Dr. Demo', 'doctor12345', RoleKey.DOCTOR);
    return { created: true, clinicId };
  });

  // eslint-disable-next-line no-console
  console.log(
    summary.created
      ? `[seed] demo clinic created: clinicId=${summary.clinicId}\n` +
          `[seed] users: admin/admin12345, reception/reception12345, doctor/doctor12345`
      : `[seed] RBAC synced; demo clinic already present (clinicId=${summary.clinicId})`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => closePool())
    .catch(async (err) => {
      // eslint-disable-next-line no-console
      console.error('[seed] failed:', err);
      await closePool();
      process.exit(1);
    });
}
