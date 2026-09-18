import type { FastifyInstance } from 'fastify';
import { billingRoutes } from '../routes/billing.routes.js';

/**
 * BILLING & FINANCE feature routes — owned by Agent 2 (Finance workstream).
 * The single place billing HTTP routes are wired; `server.ts` registers this
 * feature exactly as it registers the other workstreams.
 */
export async function billingFeature(app: FastifyInstance): Promise<void> {
  await app.register(billingRoutes);
}
