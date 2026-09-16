import type { FastifyInstance } from 'fastify';
import { patientRoutes } from '../routes/patients.routes.js';
import { workflowRoutes } from '../routes/workflow.routes.js';
import { intakeRoutes } from '../routes/intake.routes.js';
import { encounterRoutes } from '../routes/encounters.routes.js';
import { treatmentRoutes } from '../routes/treatment.routes.js';
import { reportRoutes } from '../routes/reports.routes.js';
import { prescriptionRoutes } from '../routes/prescriptions.routes.js';
import { appointmentRoutes } from '../routes/appointments.routes.js';
import { observationRoutes } from '../routes/observations.routes.js';
import { allergyRoutes } from '../routes/allergies.routes.js';

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
  await app.register(encounterRoutes);
  await app.register(treatmentRoutes);
  await app.register(reportRoutes);
  await app.register(prescriptionRoutes);
  await app.register(appointmentRoutes);
  await app.register(observationRoutes);
  await app.register(allergyRoutes);
}
