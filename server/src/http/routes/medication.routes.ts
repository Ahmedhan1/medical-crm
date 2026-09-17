import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import * as medication from '../../modules/drug/medication.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

/** Drug / medication master routes (Agent 4). */
const IdParam = z.object({ id: z.string().uuid() });

const SearchQuery = z.object({
  q: z.string().trim().min(2).optional(),
  jurisdiction: z.string().trim().max(6).optional(),
  atcCode: z.string().trim().max(10).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function params<T extends z.ZodTypeAny>(schema: T, raw: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(message, parsed.error.flatten());
  return parsed.data;
}

export async function medicationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** The registered data providers and the licence basis each one carries. */
  app.get('/medications/providers', async (req, reply) => {
    return reply.send({ providers: medication.medicationProviders(principalOf(req)) });
  });

  app.get('/medications/imports', async (req, reply) => {
    const query = params(
      z.object({ limit: z.coerce.number().int().optional() }),
      req.query,
      'Invalid query',
    );
    return reply.send({ runs: await medication.listImportRuns(principalOf(req), query.limit) });
  });

  app.post('/medications/import', async (req, reply) => {
    const result = await medication.importMedications(principalOf(req), req.body);
    return reply.code(201).send(result);
  });

  app.post('/medications', async (req, reply) => {
    const created = await medication.createMedication(principalOf(req), req.body);
    return reply.code(201).send(created);
  });

  app.get('/medications', async (req, reply) => {
    const query = params(SearchQuery, req.query, 'Invalid search');
    const results = await medication.searchMedications(principalOf(req), query);
    return reply.send({ results });
  });

  app.get('/medications/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const query = params(
      z.object({ jurisdiction: z.string().trim().max(6).optional() }),
      req.query,
      'Invalid query',
    );
    return reply.send(await medication.getMedication(principalOf(req), id, query.jurisdiction));
  });

  app.post('/medications/:id/products', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await medication.addProduct(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  /** Declared before `/medications/:id` so the literal segment is not swallowed. */
  app.post('/medications/verification/sweep', async (req, reply) => {
    const body = params(
      z.object({ limit: z.number().int().min(1).max(1000).optional() }),
      req.body ?? {},
      'Invalid sweep request',
    );
    return reply.send(await medication.sweepMedicationVerifications(principalOf(req), body.limit));
  });

  app.post('/medications/:id/verification', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await medication.verifyMedication(principalOf(req), id, req.body));
  });
}
