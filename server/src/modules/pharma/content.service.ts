import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { hasPermission, requirePermission, type Principal } from '../governance/rbac.js';
import { getHcpById } from '../hcp/hcp.repo.js';
import * as repo from './content.repo.js';
import { today } from './dates.js';
import { JurisdictionSchema } from './provenance.js';
import { assertFreeTextClean } from './guards.js';
import { assertHcpInScope } from './visibility.js';

/**
 * Approved scientific content.
 *
 * The governance rules, all enforced here or in the schema:
 *  - Every record has an accountable **owner**, a **version** and a
 *    **jurisdiction**; none of the three is optional.
 *  - Authoring and approving are **different permissions**. The approver is
 *    recorded with a timestamp, and content cannot become `approved` without an
 *    effective date (DB constraint `content_approved_has_approver`).
 *  - A representative can only retrieve content that is approved **and inside
 *    its validity window today** — expiry gating happens in SQL so it cannot be
 *    skipped by a caller.
 *  - Every lifecycle decision is appended to `approved_content_revision`.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const CreateContentSchema = z.object({
  title: z.string().trim().min(2).max(300),
  summary: z.string().trim().max(2000).optional(),
  contentType: z.enum([
    'detail_aid',
    'reprint',
    'leave_behind',
    'slide_deck',
    'video',
    'faq',
    'safety_update',
    'other',
  ]),
  therapeuticArea: z.string().trim().max(160).optional(),
  medicationId: z.string().uuid().optional(),
  ownerUserId: z.string().uuid().optional(),
  version: z.string().trim().min(1).max(40),
  jurisdiction: JurisdictionSchema,
  language: z.string().trim().max(20).optional(),
  effectiveDate: DATE.optional(),
  expiryDate: DATE.optional(),
  reviewDueDate: DATE.optional(),
  externalRef: z.string().trim().max(120).optional(),
  storageUri: z.string().trim().max(500).optional(),
});

export const ApproveContentSchema = z.object({
  decision: z.enum(['approve', 'reject', 'withdraw', 'submit_review']),
  effectiveDate: DATE.optional(),
  expiryDate: DATE.optional(),
  reviewDueDate: DATE.optional(),
  note: z.string().trim().max(1000).optional(),
});

export const RecordEngagementSchema = z.object({
  hcpId: z.string().uuid(),
  visitId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  channel: z.enum(['in_person', 'email', 'whatsapp', 'portal', 'event']).default('in_person'),
  engagementType: z
    .enum(['presented', 'shared', 'opened', 'viewed', 'downloaded', 'discussed'])
    .default('presented'),
  durationSeconds: z.number().int().min(0).max(86_400).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Invalid ${what}`, parsed.error.flatten());
  return parsed.data;
}

export async function createContent(principal: Principal, raw: unknown) {
  requirePermission(principal, Permission.CONTENT_WRITE);
  const input = parse(CreateContentSchema, raw, 'content');
  assertFreeTextClean({ title: input.title, summary: input.summary ?? null });

  if (input.expiryDate && input.effectiveDate && input.expiryDate < input.effectiveDate) {
    throw new ValidationError('expiryDate must not be before effectiveDate');
  }

  return withTransaction(async (client) => {
    const ownerUserId = input.ownerUserId ?? principal.userId;
    const { rows } = await client.query(
      `SELECT 1 FROM app_user WHERE id = $1 AND clinic_id = $2`,
      [ownerUserId, principal.clinicId],
    );
    if (rows.length === 0) throw new NotFoundError('Content owner');

    if (input.medicationId) {
      const med = await client.query(`SELECT 1 FROM medication WHERE id = $1 AND clinic_id = $2`, [
        input.medicationId,
        principal.clinicId,
      ]);
      if (med.rows.length === 0) throw new NotFoundError('Medication');
    }

    try {
      const content = await repo.insertContent(client, {
        clinicId: principal.clinicId,
        title: input.title,
        summary: input.summary ?? null,
        contentType: input.contentType,
        therapeuticArea: input.therapeuticArea ?? null,
        medicationId: input.medicationId ?? null,
        ownerUserId,
        version: input.version,
        jurisdiction: input.jurisdiction,
        language: input.language ?? null,
        effectiveDate: input.effectiveDate ?? null,
        expiryDate: input.expiryDate ?? null,
        reviewDueDate: input.reviewDueDate ?? null,
        externalRef: input.externalRef ?? null,
        storageUri: input.storageUri ?? null,
        createdBy: principal.userId,
      });
      await repo.insertContentRevision(client, {
        clinicId: principal.clinicId,
        contentId: content.id,
        recordVersion: content.recordVersion,
        changeType: 'create',
        changedFields: [],
        snapshot: content,
        note: null,
        changedBy: principal.userId,
      });
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.CONTENT_CREATED,
        subjectType: 'approved_content',
        subjectId: content.id,
        actorId: principal.userId,
        payload: { contentType: content.contentType, jurisdiction: content.jurisdiction },
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'content.create',
        targetType: 'approved_content',
        targetId: content.id,
        metadata: { version: content.version, jurisdiction: content.jurisdiction },
      });
      return content;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('Content with this title, version and jurisdiction already exists');
      }
      throw err;
    }
  });
}

/** Approve, reject, withdraw or submit content for review. */
export async function decideContent(principal: Principal, contentId: string, raw: unknown) {
  const input = parse(ApproveContentSchema, raw, 'content decision');
  // Submitting for review is an authoring act; the rest are approval acts.
  requirePermission(
    principal,
    input.decision === 'submit_review' ? Permission.CONTENT_WRITE : Permission.CONTENT_APPROVE,
  );

  return withTransaction(async (client) => {
    const before = await repo.getContentForUpdate(client, principal.clinicId, contentId);
    if (!before) throw new NotFoundError('Content');

    const now = new Date().toISOString();
    let status: repo.ApprovedContent['approvalStatus'];
    let changeType: string;
    switch (input.decision) {
      case 'submit_review':
        if (before.approvalStatus !== 'draft' && before.approvalStatus !== 'rejected') {
          throw new ConflictError(`Cannot submit content in state "${before.approvalStatus}" for review`);
        }
        status = 'in_review';
        changeType = 'submit_review';
        break;
      case 'approve': {
        if (before.approvalStatus === 'withdrawn') {
          throw new ConflictError('Withdrawn content cannot be approved; publish a new version');
        }
        const effective = input.effectiveDate ?? before.effectiveDate;
        if (!effective) {
          throw new ValidationError(
            'Approved content must declare an effectiveDate — material without a validity window cannot be used in the field',
          );
        }
        // Self-approval defeats the separation of authoring and approval.
        if (before.ownerUserId === principal.userId) {
          throw new ConflictError(
            'Content cannot be approved by its own owner; approval is a separate accountability',
          );
        }
        status = 'approved';
        changeType = 'approve';
        break;
      }
      case 'reject':
        status = 'rejected';
        changeType = 'reject';
        break;
      case 'withdraw':
        status = 'withdrawn';
        changeType = 'withdraw';
        break;
    }

    const approving = status === 'approved';
    const after = await repo.setContentApproval(client, principal.clinicId, contentId, {
      approvalStatus: status,
      approvedBy: approving ? principal.userId : null,
      approvedAt: approving ? now : null,
      rejectionReason: input.decision === 'reject' ? input.note ?? 'rejected' : null,
      effectiveDate: input.effectiveDate ?? null,
      expiryDate: input.expiryDate ?? null,
      reviewDueDate: input.reviewDueDate ?? null,
    });

    await repo.insertContentRevision(client, {
      clinicId: principal.clinicId,
      contentId,
      recordVersion: after.recordVersion,
      changeType,
      changedFields: ['approvalStatus'],
      snapshot: after,
      note: input.note ?? null,
      changedBy: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: approving ? EventType.CONTENT_APPROVED : EventType.CONTENT_WITHDRAWN,
      subjectType: 'approved_content',
      subjectId: contentId,
      actorId: principal.userId,
      payload: { approvalStatus: after.approvalStatus, version: after.version },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: `content.${changeType}`,
      targetType: 'approved_content',
      targetId: contentId,
      metadata: { approvalStatus: after.approvalStatus, version: after.version },
    });
    return after;
  });
}

export interface ListContentParams {
  jurisdiction?: string;
  medicationId?: string;
  contentType?: string;
  includeUnapproved?: boolean;
  limit?: number;
}

export async function listContent(principal: Principal, params: ListContentParams) {
  requirePermission(principal, Permission.CONTENT_READ);
  // Only a content author/approver may see drafts; everyone else sees usable
  // material only, and cannot opt out of expiry gating.
  const maySeeUnapproved =
    hasPermission(principal, Permission.CONTENT_WRITE) ||
    hasPermission(principal, Permission.CONTENT_APPROVE);
  const usableOnly = !(params.includeUnapproved && maySeeUnapproved);
  return repo.listContent(principal.clinicId, {
    jurisdiction: params.jurisdiction ?? null,
    medicationId: params.medicationId ?? null,
    contentType: params.contentType ?? null,
    usableOnly,
    onDate: today(),
    limit: Math.min(Math.max(params.limit ?? 50, 1), 200),
  });
}

export async function getContent(principal: Principal, id: string) {
  requirePermission(principal, Permission.CONTENT_READ);
  const content = await repo.getContentById(principal.clinicId, id);
  if (!content) throw new NotFoundError('Content');
  const maySeeUnapproved =
    hasPermission(principal, Permission.CONTENT_WRITE) ||
    hasPermission(principal, Permission.CONTENT_APPROVE);
  if (!maySeeUnapproved && !isUsable(content, today())) {
    // Unapproved or out-of-window material does not exist as far as the field
    // is concerned — it must never be shown to an HCP.
    throw new NotFoundError('Content');
  }
  return content;
}

export function isUsable(content: repo.ApprovedContent, onDate: string): boolean {
  if (content.approvalStatus !== 'approved') return false;
  if (!content.effectiveDate || content.effectiveDate > onDate) return false;
  if (content.expiryDate && content.expiryDate < onDate) return false;
  return true;
}

export async function getContentHistory(principal: Principal, id: string) {
  requirePermission(principal, Permission.CONTENT_READ);
  const content = await repo.getContentById(principal.clinicId, id);
  if (!content) throw new NotFoundError('Content');
  return repo.listContentRevisions(principal.clinicId, id);
}

/** Record that approved content was presented to / opened by an HCP. */
export async function recordEngagement(principal: Principal, contentId: string, raw: unknown) {
  requirePermission(principal, Permission.CONTENT_READ);
  const input = parse(RecordEngagementSchema, raw, 'engagement');
  await assertHcpInScope(principal, input.hcpId);

  return withTransaction(async (client) => {
    const content = await repo.getContentById(principal.clinicId, contentId, client);
    if (!content) throw new NotFoundError('Content');
    if (!isUsable(content, today())) {
      throw new ConflictError(
        'This content is not approved or is outside its validity window; it must not be used with an HCP',
        { approvalStatus: content.approvalStatus, expiryDate: content.expiryDate },
      );
    }
    const hcp = await getHcpById(principal.clinicId, input.hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');

    const engagement = await repo.insertEngagement(client, {
      clinicId: principal.clinicId,
      contentId,
      hcpId: input.hcpId,
      visitId: input.visitId ?? null,
      campaignId: input.campaignId ?? null,
      channel: input.channel,
      engagementType: input.engagementType,
      durationSeconds: input.durationSeconds ?? null,
      recordedBy: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.CONTENT_ENGAGED,
      subjectType: 'approved_content',
      subjectId: contentId,
      actorId: principal.userId,
      payload: {
        hcpId: input.hcpId,
        channel: input.channel,
        engagementType: input.engagementType,
      },
    });
    return { id: engagement.id, contentId, hcpId: input.hcpId, occurredAt: engagement.occurredAt };
  });
}
