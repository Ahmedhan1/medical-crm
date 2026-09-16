import type { FastifyInstance } from 'fastify';
import { authRoutes } from '../routes/auth.routes.js';

/**
 * FOUNDATION feature routes — owned by Agent 1.
 * Auth/session/identity plumbing shared by all workstreams.
 */
export async function foundationFeature(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes);
}
