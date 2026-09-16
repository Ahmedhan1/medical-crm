import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  createObservationDefinition,
  listEncounterObservations,
  listObservationDefinitions,
  listPatientObservations,
  recordObservation,
} from '../../modules/clinical/observations.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });

/** Structured observations and their definition catalog (Agent 2 / Phase 3). */
export async function observationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const idOf = (req: { params: unknown }): string => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    return parsed.data.id;
  };

  // ---- Definition catalog (config, not code) --------------------------------
  app.post('/observation-definitions', async (req, reply) => {
    const definition = await createObservationDefinition(principalOf(req), req.body);
    return reply.code(201).send(definition);
  });

  app.get('/observation-definitions', async (req, reply) => {
    const { category, includeInactive } = (req.query ?? {}) as {
      category?: string;
      includeInactive?: string;
    };
    const definitions = await listObservationDefinitions(principalOf(req), {
      ...(category ? { category } : {}),
      includeInactive: includeInactive === 'true',
    });
    return reply.send({ definitions });
  });

  // ---- Observations ---------------------------------------------------------
  app.post('/observations', async (req, reply) => {
    const observation = await recordObservation(principalOf(req), req.body);
    return reply.code(201).send(observation);
  });

  app.get('/encounters/:id/observations', async (req, reply) => {
    const observations = await listEncounterObservations(principalOf(req), idOf(req));
    return reply.send({ observations });
  });

  app.get('/patients/:id/observations', async (req, reply) => {
    const observations = await listPatientObservations(principalOf(req), idOf(req), req.query);
    return reply.send({ observations });
  });
}
