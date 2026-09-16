import type { FastifyInstance } from 'fastify';

/**
 * PHARMA / HCP / DRUG / INTELLIGENCE feature routes — owned by Agent 4.
 * Register pharma route modules here. `server.ts` never changes.
 *
 * GOVERNANCE BOUNDARY (§45): pharma routes must never expose patient-level
 * identifiable clinical data — only HCP engagement and aggregated signals.
 */
export async function pharmaFeature(_app: FastifyInstance): Promise<void> {
  // No pharma routes yet. Example:
  //   await _app.register(hcpRoutes);
}
