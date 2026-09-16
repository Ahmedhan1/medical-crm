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

  // --- Scheduled actions (time engine) ---
  app.post('/automations/run-scheduled', async (req, reply) => {
    const summary = await automation.runScheduledNow(principalOf(req));
    return reply.send(summary);
  });

  app.get('/scheduled-actions', async (req, reply) => {
    const q = ScheduledQuery.safeParse(req.query);
    if (!q.success) throw new ValidationError('Invalid filter', q.error.flatten());
    const actions = await automation.listScheduledActions(principalOf(req), q.data.status);
    return reply.send({ actions });
  });

  app.post('/scheduled-actions/:id/cancel', async (req, reply) => {
    const { id } = parseId(req.params);
    const action = await automation.cancelScheduledAction(principalOf(req), id);
    return reply.send(action);
  });
}

const ScheduledQuery = z.object({
  status: z.enum(['pending', 'executing', 'done', 'failed', 'cancelled', 'expired']).optional(),
});

function parseId(params: unknown): { id: string } {
  const parsed = IdParam.safeParse(params);
  if (!parsed.success) throw new ValidationError('Invalid id', parsed.error.flatten());
  return parsed.data;
}
