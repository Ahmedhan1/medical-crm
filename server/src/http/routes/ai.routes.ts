import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { principalOf, requireAuth } from '../plugins/auth.js';
import { extractIntakeToDraft } from '../../modules/ai/intake.js';
import { generatePatientSummary } from '../../modules/ai/summaries.js';
import { getDraftForReview, listDrafts, confirmDraft, rejectDraft } from '../../modules/ai/drafts.js';
import { readTenantAiPolicy, setTenantAiPolicy } from '../../modules/ai/policy.js';
import { requirePermission } from '../../modules/governance/rbac.js';
import { Permission } from '../../modules/governance/permissions.js';
import { createIdentity, listIdentities, setIdentityStatus } from '../../modules/ai/kernel/identity.js';
import { listTools } from '../../modules/ai/kernel/tools.js';
import { authorizeAiAction } from '../../modules/ai/kernel/guard.js';
import { executeAiAction } from '../../modules/ai/kernel/execute.js';
import { issueConfirmationToken } from '../../modules/ai/kernel/confirmation.js';
import { recordActionDecision } from '../../modules/ai/kernel/action-log.js';

const PolicyBody = z.object({
  allowCloud: z.boolean().optional(),
  cloudMaxClass: z.enum(['public', 'internal', 'operational', 'sensitive', 'phi', 'highly_restricted']).optional(),
});

const DataClassEnum = z.enum(['public', 'internal', 'operational', 'sensitive', 'phi', 'highly_restricted']);

const IdentityBody = z.object({
  agentType: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  riskCeiling: z.enum(['read_only', 'low_risk', 'medium_risk', 'high_risk']).optional(),
  dataCeiling: DataClassEnum.optional(),
  scopes: z.array(z.string().max(100)).max(100).optional(),
});

const ActionBody = z.object({
  identityId: z.string().uuid(),
  toolId: z.string().min(1).max(200),
  dataClass: DataClassEnum.optional(),
  confirmationToken: z.string().max(500).optional(),
  args: z.record(z.unknown()).optional(),
});

const ConfirmBody = z.object({
  identityId: z.string().uuid(),
  toolId: z.string().min(1).max(200),
  dataClass: DataClassEnum,
});

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

  // AI governance: the clinic's cloud/PHI routing policy (admin only).
  app.get('/ai/policy', async (req, reply) => {
    const policy = await readTenantAiPolicy(principalOf(req));
    return reply.send(policy);
  });

  app.post('/ai/policy', async (req, reply) => {
    const parsed = PolicyBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid AI policy', parsed.error.flatten());
    const policy = await setTenantAiPolicy(principalOf(req), parsed.data);
    return reply.code(201).send(policy);
  });

  // --- AI Action Security Kernel (E4) ---

  // AI identities (human-managed; ADMIN via ai:identity-manage).
  app.post('/ai/identities', async (req, reply) => {
    const parsed = IdentityBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid AI identity', parsed.error.flatten());
    const identity = await createIdentity(principalOf(req), parsed.data);
    return reply.code(201).send(identity);
  });

  app.get('/ai/identities', async (req, reply) => {
    const identities = await listIdentities(principalOf(req));
    return reply.send({ identities });
  });

  app.post('/ai/identities/:id/disable', async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) throw new ValidationError('Invalid id', params.error.flatten());
    const identity = await setIdentityStatus(principalOf(req), params.data.id, 'disabled');
    return reply.send(identity);
  });

  // Tool registry catalog (metadata only; no handlers exposed).
  app.get('/ai/tools', async (req, reply) => {
    requirePermission(principalOf(req), Permission.AI_IDENTITY_MANAGE);
    const tools = listTools().map(({ handler: _handler, ...meta }) => meta);
    return reply.send({ tools });
  });

  // Dry-run the Action Guard (no execution). Every decision is logged.
  app.post('/ai/actions/authorize', async (req, reply) => {
    const principal = principalOf(req);
    requirePermission(principal, Permission.AI_IDENTITY_MANAGE);
    const parsed = ActionBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid AI action', parsed.error.flatten());
    const decision = await authorizeAiAction({
      clinicId: principal.clinicId, // tenant scope from the principal, never the body
      identityId: parsed.data.identityId,
      toolId: parsed.data.toolId,
      dataClass: parsed.data.dataClass,
      confirmationToken: parsed.data.confirmationToken,
      actorId: principal.userId,
    });
    await recordActionDecision(decision, { executed: false, createdBy: principal.userId });
    return reply.send(decision);
  });

  // A human mints a confirmation token bound to a specific action.
  app.post('/ai/actions/confirm', async (req, reply) => {
    const principal = principalOf(req);
    requirePermission(principal, Permission.AI_ACTION_CONFIRM);
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid confirmation request', parsed.error.flatten());
    const confirmationToken = issueConfirmationToken({
      clinicId: principal.clinicId,
      identityId: parsed.data.identityId,
      toolId: parsed.data.toolId,
      dataClass: parsed.data.dataClass,
    });
    return reply.send({ confirmationToken, expiresInSeconds: 600 });
  });

  // The execution boundary: authorize then run the tool handler on ALLOW.
  app.post('/ai/actions/execute', async (req, reply) => {
    const principal = principalOf(req);
    requirePermission(principal, Permission.AI_IDENTITY_MANAGE);
    const parsed = ActionBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid AI action', parsed.error.flatten());
    const outcome = await executeAiAction({
      clinicId: principal.clinicId,
      identityId: parsed.data.identityId,
      toolId: parsed.data.toolId,
      dataClass: parsed.data.dataClass,
      confirmationToken: parsed.data.confirmationToken,
      args: parsed.data.args,
      actorId: principal.userId,
    });
    const code = outcome.executed ? 200 : outcome.authorization.decision === 'require_confirmation' ? 202 : 403;
    return reply.code(code).send(outcome);
  });

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
