import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  findPatients,
  getPatient,
  registerPatient,
} from '../../modules/identity/patients.service.js';
import { issuePatientQr, resolveQr } from '../../modules/qr/qr.service.js';
import { getPatientTimeline } from '../../modules/clinical/timeline.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });
const SearchQuery = z.object({
  q: z.string().min(2),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const ResolveQrBody = z.object({ payload: z.string().min(8) });

export async function patientRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/patients', async (req, reply) => {
    const patient = await registerPatient(principalOf(req), req.body);
    return reply.code(201).send(patient);
  });

  /*
   * `logLevel: 'warn'` suppresses Fastify's info-level request log for THIS
   * route only. That log line contains the full URL including the query string,
   * so a name search would otherwise write a patient name into application logs
   * (AGENTS.md rule 9: never put PHI in logs). Warnings and errors still log.
   *
   * This is a route-local mitigation. The general fix — a redacting request
   * serializer in `http/server.ts` — is a shared-file change and is filed as
   * CCR-002, because every workstream adding a query-string endpoint needs it.
   * Governance loses nothing here: the search is audited in the service layer.
   */
  app.get('/patients/search', { logLevel: 'warn' }, async (req, reply) => {
    const parsed = SearchQuery.safeParse(req.query);
    if (!parsed.success) throw new ValidationError('Invalid search', parsed.error.flatten());
    const results = await findPatients(principalOf(req), parsed.data.q, parsed.data.limit);
    return reply.send({ results });
  });

  app.get('/patients/:id', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    const patient = await getPatient(principalOf(req), parsed.data.id);
    return reply.send(patient);
  });

  // Longitudinal clinical history (§4.3)
  app.get('/patients/:id/timeline', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    const page = await getPatientTimeline(principalOf(req), parsed.data.id, req.query);
    return reply.send(page);
  });

  // QR identity (§10, §43)
  app.post('/patients/:id/qr', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    const issued = await issuePatientQr(principalOf(req), parsed.data.id);
    return reply.code(201).send({
      payload: issued.payload,
      qrPngDataUrl: issued.qrPngDataUrl,
      expiresAt: issued.expiresAt.toISOString(),
    });
  });

  app.post('/qr/resolve', async (req, reply) => {
    const parsed = ResolveQrBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid QR payload');
    const patient = await resolveQr(principalOf(req), parsed.data.payload);
    return reply.send(patient);
  });
}
