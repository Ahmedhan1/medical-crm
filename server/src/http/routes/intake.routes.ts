import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { getIntake, recordIntake } from '../../modules/clinical/intake.service.js';
import { listVitals, recordVitals } from '../../modules/clinical/vitals.service.js';
import { advanceStatus } from '../../modules/clinical/status.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const EncounterIdParam = z.object({ id: z.string().uuid() });

/**
 * `reason` is a controlled vocabulary, not free text — it ends up in the event
 * payload, which must never carry PHI.
 */
const StatusBody = z.object({
  status: z.enum(['intake', 'ready', 'cancelled']),
  reason: z.enum(['intake_recorded', 'vitals_recorded', 'patient_left', 'duplicate', 'staff_decision'])
    .optional(),
});

/** Intake, vitals and workflow status for an encounter (Agent 2 / C001). */
export async function intakeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/encounters/:id/intake', async (req, reply) => {
    const params = EncounterIdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    const result = await recordIntake(principalOf(req), params.data.id, req.body);
    return reply.code(201).send(result);
  });

  app.get('/encounters/:id/intake', async (req, reply) => {
    const params = EncounterIdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    const intake = await getIntake(principalOf(req), params.data.id);
    return reply.send(intake);
  });

  app.post('/encounters/:id/vitals', async (req, reply) => {
    const params = EncounterIdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    const result = await recordVitals(principalOf(req), params.data.id, req.body);
    return reply.code(201).send(result);
  });

  app.get('/encounters/:id/vitals', async (req, reply) => {
    const params = EncounterIdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    const vitals = await listVitals(principalOf(req), params.data.id);
    return reply.send({ vitals });
  });

  app.post('/encounters/:id/status', async (req, reply) => {
    const params = EncounterIdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    const body = StatusBody.safeParse(req.body);
    if (!body.success) throw new ValidationError('Invalid status change', body.error.flatten());
    const encounter = await advanceStatus(
      principalOf(req),
      params.data.id,
      body.data.status,
      body.data.reason,
    );
    return reply.send(encounter);
  });
}
