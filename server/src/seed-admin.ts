/**
 * Production admin bootstrap. Creates the FIRST clinic + a single ADMIN account
 * with a securely GENERATED one-time password that is printed exactly once, then
 * never stored in the clear. Idempotent: if any user already exists it does
 * nothing (so re-running the installer never creates duplicate admins or resets a
 * password). This is intentionally NOT the demo seeder (`seed.ts`), which uses
 * fixed sample passwords and must never run in production.
 */
import { randomBytes } from 'node:crypto';
import { withTransaction } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createClinic, createUser, seedAccessControl } from './seed.js';
import { RoleKey } from './modules/governance/permissions.js';
import { closePool } from './db/pool.js';

function generatePassword(): string {
  // 24 url-safe chars, no ambiguous separators; strong enough for a one-time
  // bootstrap credential the operator immediately changes.
  return randomBytes(18).toString('base64url');
}

export async function seedAdmin(): Promise<
  { created: false } | { created: true; username: string; password: string; clinicId: string }
> {
  await runMigrations();
  return withTransaction(async (client) => {
    await seedAccessControl(client);
    const existing = await client.query('SELECT 1 FROM app_user LIMIT 1');
    if (existing.rows.length > 0) return { created: false } as const;

    const clinicName = process.env.CLINIC_NAME ?? 'My Clinic';
    const adminUser = process.env.ADMIN_USERNAME ?? 'admin';
    const password = process.env.ADMIN_PASSWORD ?? generatePassword();
    const { clinicId } = await createClinic(client, `${clinicName} Org`, clinicName);
    await createUser(client, clinicId, adminUser, 'Administrator', password, RoleKey.ADMIN);
    return { created: true, username: adminUser, password, clinicId } as const;
  });
}

// CLI entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  seedAdmin()
    .then((r) => {
      if (!r.created) {
        // eslint-disable-next-line no-console
        console.log('[seed:admin] a user already exists — no changes made (idempotent).');
      } else {
        // eslint-disable-next-line no-console
        console.log(
          '\n============================================================\n' +
            ' MEDCORE admin account created (store this now — shown ONCE):\n' +
            `   clinic id : ${r.clinicId}\n` +
            `   username  : ${r.username}\n` +
            `   password  : ${r.password}\n` +
            ' Sign in and change this password immediately.\n' +
            '============================================================\n',
        );
      }
      return closePool();
    })
    .catch(async (err) => {
      // eslint-disable-next-line no-console
      console.error('[seed:admin] failed:', err instanceof Error ? err.message : String(err));
      await closePool();
      process.exit(1);
    });
}
