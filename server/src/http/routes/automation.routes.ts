import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { principalOf, requireAuth } from '../plugins/auth.js';
import * as automation from '../../modules/automation/automation.service.js';

const IdParam = z.object({ id: z.string().uuid() });

/**
 * Automation engine HTTP surface — owned by Agent 3.
 * Rule CRUD + run history + an on-demand "process now" entry point (a scheduler
 * would call the engine directly on an interval).
 */
export async function automationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/automations', async (req, reply) => {
    const rule = await automation.createRule(principalOf(req), req.body);
    return reply.code(201).send(rule);
  });

  app.get('/automations', async (req, reply) => {
    const rules = await automation.listRules(principalOf(req));
    return reply.send({ rules });
  });

  app.get('/automations/:id', async (req, reply) => {
    const { id } = parseId(req.params);
    const rule = await automation.getRule(principalOf(req), id);
    return reply.send(rule);
  });

  app.patch('/automations/:id', async (req, reply) => {
    const { id } = parseId(req.params);
    const rule = await automation.updateRule(principalOf(req), id, req.body);
    return reply.send(rule);
  });

  app.delete('/automations/:id', async (req, reply) => {
    const { id } = parseId(req.params);
    await automation.deleteRule(principalOf(req), id);
    return reply.code(204).send();
  });

  app.get('/automations/:id/runs', async (req, reply) => {
    const { id } = parseId(req.params);
    const runs = await automation.listRuns(principalOf(req), id);
    return reply.send({ runs });
  });

  app.post('/automations/process', async (req, reply) => {
    const summary = await automation.processNow(principalOf(req));
    return reply.send(summary);
  });
}

function parseId(params: unknown): { id: string } {
  const parsed = IdParam.safeParse(params);
  if (!parsed.success) throw new ValidationError('Invalid id', parsed.error.flatten());
  return parsed.data;
}
