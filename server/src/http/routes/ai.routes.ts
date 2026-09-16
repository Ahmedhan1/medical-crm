import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { principalOf, requireAuth } from '../plugins/auth.js';
import { extractIntakeToDraft } from '../../modules/ai/intake.js';
import { generatePatientSummary } from '../../modules/ai/summaries.js';
import { getDraftForReview, listDrafts, confirmDraft, rejectDraft } from '../../modules/ai/drafts.js';

const IntakeBody = z.object({
  subjectType: z.enum(['patient', 'encounter']),
  subjectId: z.string().uuid(),
  text: z.string().max(20000).optional(),
  audioRef: z.string().max(500).optional(),
  locale: z.string().max(20).optional(),
});

const ReviewBody = z.object({ note: z.string().max(2000).optional() });

const ListQuery = z.object({
  status: z.enum(['pending', 'confirmed', 'rejected']).optional(),
  kind: z.enum(['intake', 'summary', 'call_report', 'clinical_note']).optional(),
  subjectType: z.string().max(50).optional(),
  subjectId: z.string().uuid().optional(),
});

const IdParam = z.object({ id: z.string().uuid() });

/**
 * Review-first AI HTTP surface — owned by Agent 3.
 * Every generation returns a DRAFT; confirmation is a human action and does not
 * write clinical data (see CCR-001).
 */
export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/ai/intake', async (req, reply) => {
    const parsed = IntakeBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid intake request', parsed.error.flatten());
    const draft = await extractIntakeToDraft(principalOf(req), parsed.data);
    return reply.code(201).send(draft);
  });

  app.post('/ai/summaries/patient/:patientId', async (req, reply) => {
    const params = z.object({ patientId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid patient id', params.error.flatten());
    const draft = await generatePatientSummary(principalOf(req), params.data.patientId);
    return reply.code(201).send(draft);
  });

  app.get('/ai/drafts', async (req, reply) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) throw new ValidationError('Invalid filter', query.error.flatten());
    const drafts = await listDrafts(principalOf(req), query.data);
    return reply.send({ drafts });
  });

  app.get('/ai/drafts/:id', async (req, reply) => {
    const { id } = parseId(req.params);
    const draft = await getDraftForReview(principalOf(req), id);
    return reply.send(draft);
  });

  app.post('/ai/drafts/:id/confirm', async (req, reply) => {
    const { id } = parseId(req.params);
    const note = ReviewBody.safeParse(req.body ?? {});
    const draft = await confirmDraft(principalOf(req), id, note.success ? note.data.note : undefined);
    return reply.send(draft);
  });

  app.post('/ai/drafts/:id/reject', async (req, reply) => {
    const { id } = parseId(req.params);
    const note = ReviewBody.safeParse(req.body ?? {});
    const draft = await rejectDraft(principalOf(req), id, note.success ? note.data.note : undefined);
    return reply.send(draft);
  });
}

function parseId(params: unknown): { id: string } {
  const parsed = IdParam.safeParse(params);
  if (!parsed.success) throw new ValidationError('Invalid id', parsed.error.flatten());
  return parsed.data;
}
