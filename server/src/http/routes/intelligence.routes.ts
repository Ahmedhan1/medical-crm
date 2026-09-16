import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import * as intelligence from '../../modules/intelligence/intelligence.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

/**
 * Healthcare-intelligence routes (Agent 4).
 *
 * There is no endpoint here that returns a record about an individual. The only
 * readable artefact is an `aggregated_signal`, and the only way one comes into
 * existence is a firewall run (`POST /intelligence/runs`), which requires the
 * separate `intelligence:publish` permission.
 */
function params<T extends z.ZodTypeAny>(schema: T, raw: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(message, parsed.error.flatten());
  return parsed.data;
}

const SignalQuery = z.object({
  signalType: z.string().trim().max(60).optional(),
  scopeType: z
    .enum(['territory', 'region', 'country', 'therapeutic_area', 'product', 'global'])
    .optional(),
  scopeId: z.string().trim().max(120).optional(),
  jurisdiction: z.string().trim().max(6).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function intelligenceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Which governed sources exist and whether each is currently available. */
  app.get('/intelligence/sources', async (req, reply) => {
    return reply.send({ sources: intelligence.describeSources(principalOf(req)) });
  });

  app.get('/intelligence/policies', async (req, reply) => {
    return reply.send({ policies: await intelligence.listPolicies(principalOf(req)) });
  });

  app.put('/intelligence/policies', async (req, reply) => {
    return reply.send(await intelligence.upsertPolicy(principalOf(req), req.body));
  });

  /** Run the firewall and publish whatever survives every stage. */
  app.post('/intelligence/runs', async (req, reply) => {
    const outcome = await intelligence.runIntelligence(principalOf(req), req.body);
    return reply.code(201).send(outcome);
  });

  app.get('/intelligence/runs', async (req, reply) => {
    const query = params(
      z.object({ limit: z.coerce.number().int().optional() }),
      req.query,
      'Invalid query',
    );
    return reply.send({ runs: await intelligence.listRuns(principalOf(req), query.limit) });
  });

  app.get('/intelligence/signals', async (req, reply) => {
    const query = params(SignalQuery, req.query, 'Invalid query');
    const signals = await intelligence.listSignals(principalOf(req), query);
    return reply.send({
      signals,
      governance:
        'Aggregated, de-identified, threshold-gated signals only. Cohorts below the policy ' +
        'minimum are not returned and their absence is not reported per cohort.',
    });
  });
}
