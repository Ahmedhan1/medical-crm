import type { FastifyInstance } from 'fastify';
import { hcoRoutes } from '../routes/hco.routes.js';
import { hcpRoutes } from '../routes/hcp.routes.js';
import { intelligenceRoutes } from '../routes/intelligence.routes.js';
import { medicationRoutes } from '../routes/medication.routes.js';
import { pharmaContentRoutes } from '../routes/pharma-content.routes.js';
import { pharmaReportingRoutes } from '../routes/pharma-reporting.routes.js';
import { repRoutes } from '../routes/rep.routes.js';
import { inventoryRoutes } from '../routes/inventory.routes.js';

/**
 * PHARMA / HCP / DRUG / INTELLIGENCE / INVENTORY feature routes.
 * Register pharma + inventory route modules here. `server.ts` never changes.
 *
 * GOVERNANCE BOUNDARY (§45): routes here must never expose patient-level
 * identifiable clinical data — only HCP engagement, aggregated signals, and
 * operational stock (inventory carries no patient data). Inventory (Agent 3)
 * is registered here because it is product/stock control, adjacent to the drug
 * master, and holds no PHI.
 */
export async function pharmaFeature(app: FastifyInstance): Promise<void> {
  await app.register(hcpRoutes);
  await app.register(hcoRoutes);
  await app.register(medicationRoutes);
  await app.register(repRoutes);
  await app.register(pharmaContentRoutes);
  await app.register(pharmaReportingRoutes);
  await app.register(intelligenceRoutes);
  await app.register(inventoryRoutes);
}
