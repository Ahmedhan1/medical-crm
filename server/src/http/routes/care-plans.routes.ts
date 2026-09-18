import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  addActivity, addGoal, createCarePlan, getCarePlan, listPatientCarePlans,
  setCarePlanStatus, updateActivityProgress, updateGoalProgress,
} from '../../modules/clinical/care-plans.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });
const ChildParams = z.object({ id: z.string().uuid(), childId: z.string().uuid() });

/** Care plans, goals and interventions (Agent 2 / Care Plans). */
export async function carePlanRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  const idOf = (req: { params: unknown }): string => {
    const p = IdParam.safeParse(req.params); if (!p.success) throw new ValidationError('Invalid id'); return p.data.id;
  };
  const childOf = (req: { params: unknown }) => {
    const p = ChildParams.safeParse(req.params); if (!p.success) throw new ValidationError('Invalid ids'); return p.data;
  };

  app.post('/care-plans', async (req, reply) => reply.code(201).send(await createCarePlan(principalOf(req), req.body)));
  app.get('/care-plans/:id', async (req, reply) => reply.send(await getCarePlan(principalOf(req), idOf(req))));
  app.post('/care-plans/:id/status', async (req, reply) => reply.send(await setCarePlanStatus(principalOf(req), idOf(req), req.body)));
  app.post('/care-plans/:id/goals', async (req, reply) => reply.code(201).send(await addGoal(principalOf(req), idOf(req), req.body)));
  app.post('/care-plans/:id/goals/:childId/progress', async (req, reply) => { const { id, childId } = childOf(req); return reply.send(await updateGoalProgress(principalOf(req), id, childId, req.body)); });
  app.post('/care-plans/:id/activities', async (req, reply) => reply.code(201).send(await addActivity(principalOf(req), idOf(req), req.body)));
  app.post('/care-plans/:id/activities/:childId/progress', async (req, reply) => { const { id, childId } = childOf(req); return reply.send(await updateActivityProgress(principalOf(req), id, childId, req.body)); });
  app.get('/patients/:id/care-plans', async (req, reply) => reply.send({ carePlans: await listPatientCarePlans(principalOf(req), idOf(req), req.query) }));
}
