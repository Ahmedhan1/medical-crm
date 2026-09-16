import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  endEpisode,
  getEpisode,
  listEpisodes,
  recordResponse,
  startEpisode,
} from '../../modules/clinical/episodes.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });

/** Treatment episodes and their response history (Agent 2 / C005). */
export async function treatmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/patients/:id/treatment-episodes', async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid patient id');
    const episode = await startEpisode(principalOf(req), params.data.id, req.body);
    return reply.code(201).send(episode);
  });

  app.get('/patients/:id/treatment-episodes', async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid patient id');
    const episodes = await listEpisodes(principalOf(req), params.data.id, req.query);
    return reply.send({ episodes });
  });

  app.get('/treatment-episodes/:id', async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid episode id');
    return reply.send(await getEpisode(principalOf(req), params.data.id));
  });

  app.post('/treatment-episodes/:id/responses', async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid episode id');
    const result = await recordResponse(principalOf(req), params.data.id, req.body);
    return reply.code(201).send(result);
  });

  app.post('/treatment-episodes/:id/end', async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid episode id');
    return reply.send(await endEpisode(principalOf(req), params.data.id, req.body));
  });
}
