import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { checkIn, getQueue } from '../../modules/workflow/checkin.service.js';
import { claimNext, completeAndNext } from '../../modules/workflow/queue.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const CheckInBody = z.object({ patientId: z.string().uuid() });
const EncounterIdParam = z.object({ id: z.string().uuid() });

export async function workflowRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/encounters/check-in', async (req, reply) => {
    const parsed = CheckInBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid check-in', parsed.error.flatten());
    const encounter = await checkIn(principalOf(req), parsed.data.patientId);
    return reply.code(201).send(encounter);
  });

  app.get('/queue', async (req, reply) => {
    const queue = await getQueue(principalOf(req));
    return reply.send({ queue });
  });

  // Save & Next (§14): close the current consultation and take the next
  // waiting patient atomically.
  app.post('/encounters/:id/complete-and-next', async (req, reply) => {
    const params = EncounterIdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    return reply.send(await completeAndNext(principalOf(req), params.data.id));
  });

  // Take the next waiting patient without completing one first.
  app.post('/queue/next', async (req, reply) => {
    const next = await claimNext(principalOf(req));
    return reply.send({ next });
  });
}
