import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import * as hco from '../../modules/hcp/hco.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

/**
 * HCO (healthcare organisation) master-data routes (Agent 4).
 *
 * Routes are thin adapters: every authorization decision, territory scope check
 * and validation lives in the service, so none of it can be skipped by adding a
 * new route here.
 *
 * GOVERNANCE BOUNDARY (§45): nothing under `/hcos` reaches a clinical table. An
 * organisation is a commercial counterparty, and its 360 view is organisational
 * — never an aggregation of the care delivered inside it.
 */
const IdParam = z.object({ id: z.string().uuid() });

function params<T extends z.ZodTypeAny>(schema: T, raw: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(message, parsed.error.flatten());
  return parsed.data;
}

export async function hcoRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/hcos', async (req, reply) => {
    const created = await hco.createHco(principalOf(req), req.body);
    return reply.code(201).send(created);
  });

  app.get('/hcos', async (req, reply) => {
    const results = await hco.listHcos(principalOf(req), req.query);
    return reply.send({ results });
  });

  // Declared before `/hcos/:id` so the literal segment is not swallowed by the
  // parametric route.
  app.post('/hcos/verification/sweep', async (req, reply) => {
    const body = params(
      z.object({ limit: z.number().int().min(1).max(1000).optional() }),
      req.body ?? {},
      'Invalid sweep request',
    );
    return reply.send(await hco.sweepHcoVerifications(principalOf(req), body.limit));
  });

  app.get('/hcos/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await hco.getHco(principalOf(req), id));
  });

  app.patch('/hcos/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await hco.updateHco(principalOf(req), id, req.body));
  });

  app.get('/hcos/:id/360', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await hco.hco360(principalOf(req), id));
  });

  app.get('/hcos/:id/history', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send({ revisions: await hco.listHcoHistory(principalOf(req), id) });
  });

  app.post('/hcos/:id/verification', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await hco.decideHcoVerification(principalOf(req), id, req.body));
  });

  app.post('/hcos/:id/merge', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await hco.mergeHco(principalOf(req), id, req.body));
  });

  app.post('/hcos/:id/identifiers', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await hco.addHcoIdentifier(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  app.get('/hcos/:id/identifiers', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send({ identifiers: await hco.listHcoIdentifiers(principalOf(req), id) });
  });

  app.post('/hcos/:id/locations', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await hco.addHcoLocation(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  app.get('/hcos/:id/locations', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send({ locations: await hco.listHcoLocations(principalOf(req), id) });
  });

  app.post('/hcos/:id/departments', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await hco.addHcoDepartment(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  app.get('/hcos/:id/departments', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send({ departments: await hco.listHcoDepartments(principalOf(req), id) });
  });
}
