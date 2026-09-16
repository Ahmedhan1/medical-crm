import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import * as content from '../../modules/pharma/content.service.js';
import * as marketing from '../../modules/pharma/marketing.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

/** Approved-content hub and marketing (segmentation, campaigns) routes. */
const IdParam = z.object({ id: z.string().uuid() });

function params<T extends z.ZodTypeAny>(schema: T, raw: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(message, parsed.error.flatten());
  return parsed.data;
}

export async function pharmaContentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // --- Approved content -----------------------------------------------------
  app.post('/pharma/content', async (req, reply) => {
    const created = await content.createContent(principalOf(req), req.body);
    return reply.code(201).send(created);
  });

  app.get('/pharma/content', async (req, reply) => {
    const query = params(
      z.object({
        jurisdiction: z.string().trim().max(6).optional(),
        medicationId: z.string().uuid().optional(),
        contentType: z.string().trim().max(40).optional(),
        includeUnapproved: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().optional(),
      }),
      req.query,
      'Invalid query',
    );
    return reply.send({ results: await content.listContent(principalOf(req), query) });
  });

  app.get('/pharma/content/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await content.getContent(principalOf(req), id));
  });

  app.get('/pharma/content/:id/history', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send({ revisions: await content.getContentHistory(principalOf(req), id) });
  });

  /** Approve / reject / withdraw / submit for review. */
  app.post('/pharma/content/:id/decision', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await content.decideContent(principalOf(req), id, req.body));
  });

  app.post('/pharma/content/:id/engagements', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await content.recordEngagement(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  // --- Segmentation ---------------------------------------------------------
  app.post('/pharma/segments', async (req, reply) => {
    const created = await marketing.createSegment(principalOf(req), req.body);
    return reply.code(201).send(created);
  });

  app.get('/pharma/segments', async (req, reply) => {
    return reply.send({ results: await marketing.listSegments(principalOf(req)) });
  });

  app.post('/pharma/segments/:id/resolve', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await marketing.resolveSegment(principalOf(req), id));
  });

  // --- Campaigns ------------------------------------------------------------
  app.post('/pharma/campaigns', async (req, reply) => {
    const created = await marketing.createCampaign(principalOf(req), req.body);
    return reply.code(201).send(created);
  });

  app.get('/pharma/campaigns', async (req, reply) => {
    return reply.send({ results: await marketing.listCampaigns(principalOf(req)) });
  });

  app.post('/pharma/campaigns/:id/targets', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await marketing.populateCampaignTargets(principalOf(req), id));
  });
}
