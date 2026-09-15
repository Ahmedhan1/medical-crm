import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { checkIn, getQueue } from '../../modules/workflow/checkin.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const CheckInBody = z.object({ patientId: z.string().uuid() });

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
}
