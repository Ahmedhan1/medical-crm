import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import * as field from '../../modules/pharma/field.service.js';
import * as fieldforce from '../../modules/pharma/fieldforce.service.js';
import * as medaffairs from '../../modules/pharma/medaffairs.service.js';
import * as territory from '../../modules/pharma/territory.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

/**
 * Medical-representative platform routes (Agent 4): territory, the day's calls,
 * pre-visit briefing, call reports, scientific requests and follow-ups.
 */
const IdParam = z.object({ id: z.string().uuid() });

function params<T extends z.ZodTypeAny>(schema: T, raw: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(message, parsed.error.flatten());
  return parsed.data;
}

export async function repRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // --- Territory ------------------------------------------------------------
  app.post('/territories', async (req, reply) => {
    const created = await territory.createTerritory(principalOf(req), req.body);
    return reply.code(201).send(created);
  });

  app.get('/territories', async (req, reply) => {
    return reply.send({ results: await territory.listTerritories(principalOf(req)) });
  });

  app.post('/territories/:id/assignments', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await territory.assignTerritory(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  /**
   * Revoke territory scope. The counterpart to creating an assignment, and the
   * half that was missing — scope could be granted and never taken back.
   */
  app.patch('/territories/:id/assignments/:assignmentId', async (req, reply) => {
    const { id, assignmentId } = params(
      z.object({ id: z.string().uuid(), assignmentId: z.string().uuid() }),
      req.params,
      'Invalid id',
    );
    return reply.send(
      await territory.endTerritoryAssignment(principalOf(req), id, assignmentId, req.body),
    );
  });

  app.post('/territories/:id/targets', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await territory.targetHcp(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  /** The representative's own book of business. */
  app.get('/rep/territory', async (req, reply) => {
    return reply.send(await territory.myTerritory(principalOf(req)));
  });

  /** Today's calls, in planned order. */
  app.get('/rep/today', async (req, reply) => {
    return reply.send({ visits: await field.todaysVisits(principalOf(req)) });
  });

  app.get('/rep/follow-ups', async (req, reply) => {
    const query = params(
      z.object({
        hcpId: z.string().uuid().optional(),
        status: z.enum(['open', 'done', 'cancelled']).optional(),
        limit: z.coerce.number().int().optional(),
      }),
      req.query,
      'Invalid query',
    );
    return reply.send({ results: await field.listFollowUps(principalOf(req), query) });
  });

  app.post('/follow-ups/:id/complete', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await field.completeFollowUp(principalOf(req), id));
  });

  // --- Field force (rep profiles and the reporting hierarchy) ---------------
  app.put('/field-force/profiles', async (req, reply) => {
    return reply.send(await fieldforce.upsertFieldRepProfile(principalOf(req), req.body));
  });

  app.get('/field-force/profiles', async (req, reply) => {
    return reply.send({ results: await fieldforce.listFieldForce(principalOf(req), req.query) });
  });

  app.get('/field-force/profiles/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await fieldforce.fieldRepProfile(principalOf(req), id));
  });

  // --- Visits ---------------------------------------------------------------
  app.post('/visits', async (req, reply) => {
    const created = await field.planVisit(principalOf(req), req.body);
    return reply.code(201).send(created);
  });

  app.get('/visits', async (req, reply) => {
    const query = params(
      z.object({
        hcpId: z.string().uuid().optional(),
        hcoId: z.string().uuid().optional(),
        status: z.enum(['planned', 'confirmed', 'completed', 'cancelled', 'no_access']).optional(),
        modality: z
          .enum([
            'face_to_face',
            'virtual',
            'phone',
            'conference',
            'scientific_meeting',
            'institutional',
          ])
          .optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        mineOnly: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().optional(),
      }),
      req.query,
      'Invalid query',
    );
    return reply.send({ results: await field.listVisits(principalOf(req), query) });
  });

  /** Pre-visit briefing: who they are, what happened last time, what is open. */
  app.get('/visits/:id/briefing', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await field.preVisitBriefing(principalOf(req), id));
  });

  /** How this visit reached its current status — the append-only trail (0309). */
  app.get('/visits/:id/history', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send({ events: await field.visitHistory(principalOf(req), id) });
  });

  app.post('/visits/:id/status', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await field.updateVisitStatus(principalOf(req), id, req.body));
  });

  app.post('/visits/:id/call-report', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const created = await field.submitCallReport(principalOf(req), id, req.body);
    return reply.code(201).send(created);
  });

  app.get('/visits/:id/call-report', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await field.getCallReport(principalOf(req), id));
  });

  // --- Scientific requests (medical affairs) --------------------------------
  app.post('/scientific-requests', async (req, reply) => {
    const created = await medaffairs.createScientificRequest(principalOf(req), req.body);
    return reply.code(201).send(created);
  });

  app.get('/scientific-requests', async (req, reply) => {
    return reply.send({
      results: await medaffairs.listScientificRequests(principalOf(req), req.query),
    });
  });

  /** The medical-affairs workload: counts only, never enquiry text. */
  app.get('/scientific-requests/queue', async (req, reply) => {
    return reply.send(await medaffairs.medicalInformationQueue(principalOf(req)));
  });

  app.get('/scientific-requests/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await medaffairs.getScientificRequestDetail(principalOf(req), id));
  });

  app.post('/scientific-requests/:id/triage', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await medaffairs.triageScientificRequest(principalOf(req), id, req.body));
  });

  app.post('/scientific-requests/:id/answer', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await medaffairs.answerScientificRequest(principalOf(req), id, req.body));
  });

  app.post('/scientific-requests/:id/escalate', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await medaffairs.escalateScientificRequest(principalOf(req), id, req.body));
  });
}
