import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  addDiagnosis,
  addNote,
  completeEncounter,
  getWorkspace,
  reviseDiagnosis,
  startConsultation,
  updateClinical,
} from '../../modules/clinical/workspace.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });
const DiagnosisParams = z.object({ id: z.string().uuid(), diagnosisId: z.string().uuid() });

/** Doctor workspace: the consultation record for an encounter (Agent 2 / C002). */
export async function encounterRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/encounters/:id', async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    return reply.send(await getWorkspace(principalOf(req), params.data.id));
  });

  app.post('/encounters/:id/start', async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    return reply.send(await startConsultation(principalOf(req), params.data.id));
  });

  app.patch('/encounters/:id/clinical', async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    return reply.send(await updateClinical(principalOf(req), params.data.id, req.body));
  });

  app.post('/encounters/:id/diagnoses', async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    const diagnosis = await addDiagnosis(principalOf(req), params.data.id, req.body);
    return reply.code(201).send(diagnosis);
  });

  app.patch('/encounters/:id/diagnoses/:diagnosisId', async (req, reply) => {
    const params = DiagnosisParams.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid identifiers');
    const diagnosis = await reviseDiagnosis(
      principalOf(req),
      params.data.id,
      params.data.diagnosisId,
      req.body,
    );
    return reply.send(diagnosis);
  });

  app.post('/encounters/:id/notes', async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    const note = await addNote(principalOf(req), params.data.id, req.body);
    return reply.code(201).send(note);
  });

  app.post('/encounters/:id/complete', async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid encounter id');
    return reply.send(await completeEncounter(principalOf(req), params.data.id));
  });
}
