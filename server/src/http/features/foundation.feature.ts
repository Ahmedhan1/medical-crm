import type { FastifyInstance } from 'fastify';
import { authRoutes } from '../routes/auth.routes.js';
import { backupRoutes } from '../routes/backup.routes.js';
import { licenseRoutes } from '../routes/license.routes.js';

/**
 * FOUNDATION feature routes — owned by Agent 1.
 * Auth/session/identity plumbing + platform admin (backup, license) shared by all
 * workstreams.
 */
export async function foundationFeature(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes);
  await app.register(backupRoutes);
  await app.register(licenseRoutes);
}
