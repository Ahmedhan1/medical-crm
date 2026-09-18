import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import * as hcp from '../../modules/hcp/hcp.service.js';
import { hcp360 } from '../../modules/hcp/hcp360.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

/**
 * HCP master-data routes (Agent 4). The organisation side lives in
 * `hco.routes.ts`.
 *
 * Routes are thin adapters: every authorization decision, territory scope check
 * and validation lives in the service, so it cannot be skipped by adding a new
 * route here.
 */
const IdParam = z.object({ id: z.string().uuid() });

const SearchQuery = z.object({
  q: z.string().trim().min(2).optional(),
  specialtyId: z.string().uuid().optional(),
  professionalCategory: z
    .enum([
      'physician',
      'pharmacist',
      'dentist',
      'nurse',
      'veterinarian',
      'researcher',
      'allied_health',
      'other',
    ])
    .optional(),
  verificationStatus: z
    .enum([
      'unverified',
      'pending_review',
      'verified',
      'rejected',
      'suspended',
      'expired',
      'disputed',
      'retired',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * Merging two professional identities is as destructive as merging two
 * organisations, so it carries the same evidence requirement: a recorded reason.
 * Before this the HCO path demanded one and the HCP path did not — the same act
 * held to two different bars.
 */
const MergeBody = z.object({
  targetHcpId: z.string().uuid(),
  reason: z.string().trim().min(4).max(2000),
});

function params<T extends z.ZodTypeAny>(schema: T, raw: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(message, parsed.error.flatten());
  return parsed.data;
}

export async function hcpRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // --- Specialty taxonomy ---------------------------------------------------
  app.post('/specialties', async (req, reply) => {
    const created = await hcp.createSpecialty(principalOf(req), req.body);
    return reply.code(201).send(created);
  });

  app.get('/specialties', async (req, reply) => {
    return reply.send({ results: await hcp.listSpecialties(principalOf(req)) });
  });

  // --- HCP ------------------------------------------------------------------
  app.post('/hcps', async (req, reply) => {
    const created = await hcp.createHcp(principalOf(req), req.body);
    return reply.code(201).send(created);
  });

  app.get('/hcps', async (req, reply) => {
    const query = params(SearchQuery, req.query, 'Invalid search');
    const results = await hcp.searchHcps(principalOf(req), query);
    return reply.send({ results });
  });

  /** HCP 360 — professional + engagement view. Contains no patient data (§45). */
  app.get('/hcps/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await hcp360(principalOf(req), id));
  });

  app.patch('/hcps/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await hcp.updateHcp(principalOf(req), id, req.body));
  });

  app.get('/hcps/:id/history', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send({ revisions: await hcp.getHcpRevisions(principalOf(req), id) });
  });

  /**
   * Persist lapsed verifications. Expiry is already derived on every read, so
   * this only reconciles stored state and emits events — it is registered
   * BEFORE `/hcps/:id/...` so the literal path is not captured as an id.
   */
  app.post('/hcps/verification/sweep', async (req, reply) => {
    const body = params(
      z.object({ limit: z.coerce.number().int().min(1).max(1000).optional() }),
      req.body ?? {},
      'Invalid sweep request',
    );
    return reply.send(await hcp.sweepExpiredVerifications(principalOf(req), body.limit));
  });

  app.post('/hcps/:id/verification', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await hcp.setHcpVerification(principalOf(req), id, req.body));
  });

  app.post('/hcps/:id/merge', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const body = params(MergeBody, req.body, 'Invalid merge target');
    return reply.send(await hcp.mergeHcp(principalOf(req), id, body.targetHcpId, body.reason));
  });

  app.get('/hcps/:id/provenance', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await hcp.getAttributeProvenance(principalOf(req), id));
  });

  app.post('/hcps/:id/credentials', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await hcp.addCredential(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  app.get('/hcps/:id/credentials', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send({ credentials: await hcp.listCredentials(principalOf(req), id) });
  });

  app.post('/hcps/:id/identifiers', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await hcp.addIdentifier(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  app.post('/hcps/:id/affiliations', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await hcp.addAffiliation(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  /** Amend or END an affiliation — the counterpart to creating one. */
  app.patch('/hcps/:id/affiliations/:affiliationId', async (req, reply) => {
    const { id, affiliationId } = params(
      z.object({ id: z.string().uuid(), affiliationId: z.string().uuid() }),
      req.params,
      'Invalid id',
    );
    return reply.send(await hcp.updateAffiliation(principalOf(req), id, affiliationId, req.body));
  });

  app.post('/hcps/:id/locations', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await hcp.addPracticeLocation(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  app.post('/hcps/:id/interests', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const interests = await hcp.addInterest(principalOf(req), id, req.body);
    return reply.code(201).send({ interests });
  });

  app.post('/hcps/:id/specialties', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const specialties = await hcp.addSpecialtyLink(principalOf(req), id, req.body);
    return reply.code(201).send({ specialties });
  });
}
