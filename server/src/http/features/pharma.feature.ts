import type { FastifyInstance } from 'fastify';
import { hcoRoutes } from '../routes/hco.routes.js';
import { hcpRoutes } from '../routes/hcp.routes.js';
import { intelligenceRoutes } from '../routes/intelligence.routes.js';
import { medicationRoutes } from '../routes/medication.routes.js';
import { pharmaContentRoutes } from '../routes/pharma-content.routes.js';
import { pharmaReportingRoutes } from '../routes/pharma-reporting.routes.js';
import { repRoutes } from '../routes/rep.routes.js';

/**
 * PHARMA / HCP / DRUG / INTELLIGENCE feature routes — owned by Agent 4.
 * Register pharma route modules here. `server.ts` never changes.
 *
 * GOVERNANCE BOUNDARY (§45): pharma routes must never expose patient-level
 * identifiable clinical data — only HCP engagement and aggregated signals.
 */
export async function pharmaFeature(app: FastifyInstance): Promise<void> {
  await app.register(hcpRoutes);
  await app.register(hcoRoutes);
  await app.register(medicationRoutes);
  await app.register(repRoutes);
  await app.register(pharmaContentRoutes);
  await app.register(pharmaReportingRoutes);
  await app.register(intelligenceRoutes);
}
