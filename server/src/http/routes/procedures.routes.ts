import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  getProcedure,
  listPatientProcedures,
  recordProcedure,
  updateProcedure,
  voidProcedure,
} from '../../modules/clinical/procedures.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });

/** Structured procedure documentation (Agent 2 / Procedures). */
export async function procedureRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  const idOf = (req: { params: unknown }): string => {
    const p = IdParam.safeParse(req.params);
    if (!p.success) throw new ValidationError('Invalid id');
    return p.data.id;
  };

  app.post('/procedures', async (req, reply) => {
    return reply.code(201).send(await recordProcedure(principalOf(req), req.body));
  });
  app.get('/procedures/:id', async (req, reply) => {
    return reply.send(await getProcedure(principalOf(req), idOf(req)));
  });
  app.patch('/procedures/:id', async (req, reply) => {
    return reply.send(await updateProcedure(principalOf(req), idOf(req), req.body));
  });
  app.post('/procedures/:id/void', async (req, reply) => {
    return reply.send(await voidProcedure(principalOf(req), idOf(req), req.body));
  });
  app.get('/patients/:id/procedures', async (req, reply) => {
    return reply.send({ procedures: await listPatientProcedures(principalOf(req), idOf(req), req.query) });
  });
}
