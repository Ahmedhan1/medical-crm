import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  createReferral,
  getReferral,
  listReferrals,
  transitionReferral,
} from '../../modules/clinical/referrals.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });

/** Referrals & care coordination (Agent 2 / Phase 10). */
export async function referralRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const idOf = (req: { params: unknown }): string => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    return parsed.data.id;
  };

  app.post('/referrals', async (req, reply) => {
    const referral = await createReferral(principalOf(req), req.body);
    return reply.code(201).send(referral);
  });

  app.get('/referrals', async (req, reply) => {
    return reply.send({ referrals: await listReferrals(principalOf(req), req.query) });
  });

  app.get('/referrals/:id', async (req, reply) => {
    return reply.send(await getReferral(principalOf(req), idOf(req)));
  });

  /** Advance the referral lifecycle; authority depends on the target status. */
  app.post('/referrals/:id/status', async (req, reply) => {
    return reply.send(await transitionReferral(principalOf(req), idOf(req), req.body));
  });
}
