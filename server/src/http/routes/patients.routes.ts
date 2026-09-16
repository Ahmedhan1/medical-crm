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
import { getPatient360 } from '../../modules/clinical/patient360.service.js';
import {
  addContact,
  addIdentifier,
  findDuplicateCandidates,
  listContacts,
  listIdentifiers,
  mergePatients,
  removeContact,
  removeIdentifier,
  setPatientStatus,
  updatePatient,
} from '../../modules/identity/patients.lifecycle.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });
/** `:id` plus a sub-resource id, whatever the route names the second param. */
const SubResourceParams = z
  .object({
    id: z.string().uuid(),
    identifierId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
  })
  .transform((v) => ({ id: v.id, subId: (v.identifierId ?? v.contactId)! }))
  .refine((v) => !!v.subId, { message: 'Missing sub-resource id' });
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

  // ---- Patient lifecycle (Phase 1) -----------------------------------------

  app.patch('/patients/:id', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    return reply.send(await updatePatient(principalOf(req), parsed.data.id, req.body));
  });

  app.post('/patients/:id/status', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    return reply.send(await setPatientStatus(principalOf(req), parsed.data.id, req.body));
  });

  /** Deterministic duplicate candidates, for the merge workflow. */
  app.get('/patients/:id/duplicates', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    const candidates = await findDuplicateCandidates(principalOf(req), parsed.data.id);
    return reply.send({ candidates });
  });

  /** Merge a duplicate INTO this patient; `:id` is the surviving record. */
  app.post('/patients/:id/merge', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    return reply.send(await mergePatients(principalOf(req), parsed.data.id, req.body));
  });

  app.post('/patients/:id/identifiers', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    const identifier = await addIdentifier(principalOf(req), parsed.data.id, req.body);
    return reply.code(201).send(identifier);
  });

  app.get('/patients/:id/identifiers', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    const identifiers = await listIdentifiers(principalOf(req), parsed.data.id);
    return reply.send({ identifiers });
  });

  app.delete('/patients/:id/identifiers/:identifierId', async (req, reply) => {
    const parsed = SubResourceParams.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid identifiers');
    await removeIdentifier(principalOf(req), parsed.data.id, parsed.data.subId);
    return reply.code(204).send();
  });

  app.post('/patients/:id/contacts', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    const contact = await addContact(principalOf(req), parsed.data.id, req.body);
    return reply.code(201).send(contact);
  });

  app.get('/patients/:id/contacts', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    const contacts = await listContacts(principalOf(req), parsed.data.id);
    return reply.send({ contacts });
  });

  app.delete('/patients/:id/contacts/:contactId', async (req, reply) => {
    const parsed = SubResourceParams.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid identifiers');
    await removeContact(principalOf(req), parsed.data.id, parsed.data.subId);
    return reply.code(204).send();
  });

  // Patient 360 — an authorization-shaped read-only summary (§4.3)
  app.get('/patients/:id/360', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    return reply.send(await getPatient360(principalOf(req), parsed.data.id));
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
