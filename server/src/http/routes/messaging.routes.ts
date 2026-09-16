import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { principalOf, requireAuth } from '../plugins/auth.js';
import { requirePermission } from '../../modules/governance/rbac.js';
import { Permission } from '../../modules/governance/permissions.js';
import { sendMessage, listMessages } from '../../modules/messaging/messaging.service.js';
import { retryMessage, retryDueMessages, applyDeliveryStatus } from '../../modules/messaging/delivery.js';
import { saveTemplate, getTemplatesForClinic } from '../../modules/messaging/templates.js';
import { setConsent, listConsents } from '../../modules/messaging/consent.js';
import { setPolicy, listPolicies } from '../../modules/messaging/policy.js';

const Channel = z.enum(['whatsapp', 'sms', 'email']);
const IdParam = z.object({ id: z.string().uuid() });

const SendBody = z.object({
  channel: Channel,
  patientId: z.string().uuid().optional(),
  templateKey: z.string().min(1).optional(),
  locale: z.string().min(1).max(20).optional(),
  variables: z.record(z.string()).optional(),
  to: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const TemplateBody = z.object({
  key: z.string().min(1).max(100),
  channel: Channel,
  locale: z.string().min(1).max(20).optional(),
  body: z.string().min(1).max(4000),
});

const ConsentBody = z.object({
  patientId: z.string().uuid(),
  channel: Channel,
  status: z.enum(['opted_in', 'opted_out', 'unknown']),
});

const DeliveryStatusBody = z.object({
  provider: z.string().min(1),
  providerRef: z.string().min(1),
  delivered: z.boolean(),
  errorCode: z.string().max(200).optional(),
});

const PolicyBody = z.object({
  channel: z.enum(['all', 'whatsapp', 'sms', 'email']).optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietStartHour: z.number().int().min(0).max(23).optional(),
  quietEndHour: z.number().int().min(0).max(23).optional(),
  dailyCap: z.number().int().min(0).nullable().optional(),
  minGapMinutes: z.number().int().min(0).max(10080).optional(),
});

/**
 * Messaging + consent HTTP surface — owned by Agent 3. Consent-gated sends,
 * template management, delivery-status callbacks, and retry/recovery.
 */
export async function messagingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/messages', async (req, reply) => {
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid message', parsed.error.flatten());
    const outcome = await sendMessage(principalOf(req), parsed.data);
    return reply.code(202).send(outcome);
  });

  app.get('/messages', async (req, reply) => {
    const messages = await listMessages(principalOf(req));
    return reply.send({ messages });
  });

  app.post('/messages/:id/retry', async (req, reply) => {
    const { id } = parseId(req.params);
    const outcome = await retryMessage(principalOf(req), id);
    return reply.send(outcome);
  });

  app.post('/messages/retry-due', async (req, reply) => {
    const summary = await retryDueMessages(principalOf(req));
    return reply.send(summary);
  });

  app.post('/messages/delivery-status', async (req, reply) => {
    const parsed = DeliveryStatusBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid delivery status', parsed.error.flatten());
    const outcome = await applyDeliveryStatus(principalOf(req), parsed.data);
    return reply.send(outcome);
  });

  app.post('/message-templates', async (req, reply) => {
    const parsed = TemplateBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid template', parsed.error.flatten());
    const template = await saveTemplate(principalOf(req), parsed.data);
    return reply.code(201).send(template);
  });

  app.get('/message-templates', async (req, reply) => {
    const templates = await getTemplatesForClinic(principalOf(req));
    return reply.send({ templates });
  });

  app.post('/consent', async (req, reply) => {
    const parsed = ConsentBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid consent', parsed.error.flatten());
    const record = await setConsent(
      principalOf(req),
      parsed.data.patientId,
      parsed.data.channel,
      parsed.data.status,
    );
    return reply.code(201).send(record);
  });

  app.post('/messaging-policy', async (req, reply) => {
    const parsed = PolicyBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid messaging policy', parsed.error.flatten());
    const policy = await setPolicy(principalOf(req), parsed.data);
    return reply.code(201).send(policy);
  });

  app.get('/messaging-policy', async (req, reply) => {
    const policies = await listPolicies(principalOf(req));
    return reply.send({ policies });
  });

  app.get('/consent/:patientId', async (req, reply) => {
    const params = z.object({ patientId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid patient id', params.error.flatten());
    // Reading consent is part of the messaging read surface.
    const principal = principalOf(req);
    requirePermission(principal, Permission.MESSAGING_READ);
    const consents = await listConsents(principal.clinicId, params.data.patientId);
    return reply.send({ consents });
  });
}

function parseId(params: unknown): { id: string } {
  const parsed = IdParam.safeParse(params);
  if (!parsed.success) throw new ValidationError('Invalid id', parsed.error.flatten());
  return parsed.data;
}
