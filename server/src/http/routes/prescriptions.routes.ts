import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  cancelPrescription,
  getPrescription,
  issuePrescription,
  listPrescriptionsForEncounter,
  listPrescriptionsForPatient,
} from '../../modules/clinical/prescriptions.service.js';
import {
  closeFollowUp,
  listFollowUpsForPatient,
  listRecallWorklist,
  scheduleFollowUp,
} from '../../modules/clinical/followups.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });

/** Prescriptions and follow-ups (Agent 2 / C007). */
export async function prescriptionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const encounterId = (req: { params: unknown }): string => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid encounter id');
    return parsed.data.id;
  };

  app.post('/encounters/:id/prescriptions', async (req, reply) => {
    const prescription = await issuePrescription(principalOf(req), encounterId(req), req.body);
    return reply.code(201).send(prescription);
  });

  app.get('/encounters/:id/prescriptions', async (req, reply) => {
    const prescriptions = await listPrescriptionsForEncounter(principalOf(req), encounterId(req));
    return reply.send({ prescriptions });
  });

  app.get('/prescriptions/:id', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid prescription id');
    return reply.send(await getPrescription(principalOf(req), parsed.data.id));
  });

  app.post('/prescriptions/:id/cancel', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid prescription id');
    return reply.send(await cancelPrescription(principalOf(req), parsed.data.id, req.body));
  });

  app.get('/patients/:id/prescriptions', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid patient id');
    const prescriptions = await listPrescriptionsForPatient(
      principalOf(req),
      parsed.data.id,
      req.query,
    );
    return reply.send({ prescriptions });
  });

  // ---- Follow-ups -----------------------------------------------------------

  app.post('/encounters/:id/follow-ups', async (req, reply) => {
    const followUp = await scheduleFollowUp(principalOf(req), encounterId(req), req.body);
    return reply.code(201).send(followUp);
  });

  app.get('/patients/:id/follow-ups', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid patient id');
    const followUps = await listFollowUpsForPatient(principalOf(req), parsed.data.id, req.query);
    return reply.send({ followUps });
  });

  /** The recall worklist the front desk works from. */
  app.get('/follow-ups', async (req, reply) => {
    const followUps = await listRecallWorklist(principalOf(req), req.query);
    return reply.send({ followUps });
  });

  app.post('/follow-ups/:id/close', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid follow-up id');
    return reply.send(await closeFollowUp(principalOf(req), parsed.data.id, req.body));
  });
}
