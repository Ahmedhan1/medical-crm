import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  listAllergies,
  recordAllergy,
  updateAllergy,
} from '../../modules/clinical/allergies.service.js';
import { previewPrescriptionSafety } from '../../modules/clinical/prescriptions.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });
const AllergyParams = z.object({ id: z.string().uuid(), allergyId: z.string().uuid() });

/** Structured allergies and the prescribing safety preview (Agent 2 / Phase 8). */
export async function allergyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/patients/:id/allergies', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    const allergy = await recordAllergy(principalOf(req), parsed.data.id, req.body);
    return reply.code(201).send(allergy);
  });

  app.get('/patients/:id/allergies', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    const includeInactive = (req.query as { includeInactive?: string })?.includeInactive === 'true';
    const allergies = await listAllergies(principalOf(req), parsed.data.id, includeInactive);
    return reply.send({ allergies });
  });

  app.patch('/patients/:id/allergies/:allergyId', async (req, reply) => {
    const parsed = AllergyParams.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid identifiers');
    const allergy = await updateAllergy(
      principalOf(req),
      parsed.data.id,
      parsed.data.allergyId,
      req.body,
    );
    return reply.send(allergy);
  });

  /** Dry-run the prescribing safety checks for candidate lines. */
  app.post('/encounters/:id/prescription-safety-check', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    return reply.send(await previewPrescriptionSafety(principalOf(req), parsed.data.id, req.body));
  });
}
