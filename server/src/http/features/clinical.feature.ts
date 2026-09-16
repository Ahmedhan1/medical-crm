import type { FastifyInstance } from 'fastify';
import { patientRoutes } from '../routes/patients.routes.js';
import { workflowRoutes } from '../routes/workflow.routes.js';
import { intakeRoutes } from '../routes/intake.routes.js';

/**
 * CLINICAL CORE feature routes — owned by Agent 2.
 * Register new clinical route modules here (intake, vitals, encounter, timeline,
 * prescriptions, reports). This is the ONLY place Agent 2 wires HTTP routes;
 * `server.ts` never changes.
 */
export async function clinicalFeature(app: FastifyInstance): Promise<void> {
  await app.register(patientRoutes);
  await app.register(workflowRoutes);
  await app.register(intakeRoutes);
}
