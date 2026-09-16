import { z } from 'zod';
import { getPool, withTransaction } from '../../db/pool.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { hasPermission, requirePermission, type Principal } from '../governance/rbac.js';
import { today } from './dates.js';
import {
  assertNoManagerCycle,
  managerChainFor,
  subordinateUserIds,
} from './hierarchy.js';
import * as repo from './fieldforce.repo.js';

/**
 * FIELD-FORCE service — representative profiles and the reporting hierarchy
 * (migration 0309).
 *
 * WHY THE HIERARCHY IS HERE AT ALL: before it, the only way to supervise
 * another representative's work was `territory:manage`, which reaches the whole
 * clinic. A district manager who should see six people either saw none or saw
 * everyone. `field_rep_profile.manager_user_id` gives the third answer — their
 * own subtree — and `hierarchy.ts` is the only place that chain is walked, with
 * cycle and depth guards, because walking it wrongly either hangs or over-grants.
 *
 * PERMISSIONS: no new ones. Reading the field force is `territory:read`;
 * changing it is `territory:manage` — the permission that already owns the
 * shape of the field organisation. Inventing `fieldforce:*` alongside it would
 * add a permission without adding a decision.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const UpsertFieldRepProfileSchema = z
  .object({
    userId: z.string().uuid(),
    employeeRef: z.string().trim().max(60).optional(),
    repRole: z
      .enum(['representative', 'senior_representative', 'district_manager', 'regional_manager'])
      .default('representative'),
    status: z.enum(['active', 'on_leave', 'inactive']).default('active'),
    managerUserId: z.string().uuid().nullable().optional(),
    region: z.string().trim().max(120).optional(),
    startDate: DATE.optional(),
    endDate: DATE.nullable().optional(),
  })
  .refine((v) => !v.endDate || !v.startDate || v.endDate >= v.startDate, {
    message: 'endDate cannot precede startDate',
    path: ['endDate'],
  });

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Invalid ${what}`, parsed.error.flatten());
  return parsed.data;
}

async function assertClinicUser(clinicId: string, userId: string, label: string): Promise<void> {
  const { rows } = await getPool().query(`SELECT 1 FROM app_user WHERE id = $1 AND clinic_id = $2`, [
    userId,
    clinicId,
  ]);
  if (rows.length === 0) throw new NotFoundError(label);
}

export async function upsertFieldRepProfile(
  principal: Principal,
  raw: unknown,
): Promise<repo.FieldRepProfile> {
  requirePermission(principal, Permission.TERRITORY_MANAGE);
  const input = parse(UpsertFieldRepProfileSchema, raw, 'field representative profile');

  // Both the subject and the manager must belong to this tenant. Checked before
  // the transaction so a cross-tenant id can never reach the insert.
  await assertClinicUser(principal.clinicId, input.userId, 'User');
  if (input.managerUserId) {
    await assertClinicUser(principal.clinicId, input.managerUserId, 'Manager');
  }
  // A cycle makes "who may see my data" unanswerable. The schema refuses the
  // one-step case; reachability needs a walk, so it is checked here.
  await assertNoManagerCycle(principal.clinicId, input.userId, input.managerUserId ?? null);

  return withTransaction(async (client) => {
    const profile = await repo.upsertProfile(client, {
      clinicId: principal.clinicId,
      userId: input.userId,
      employeeRef: input.employeeRef ?? null,
      repRole: input.repRole,
      status: input.status,
      managerUserId: input.managerUserId ?? null,
      region: input.region ?? null,
      startDate: input.startDate ?? today(),
      endDate: input.endDate ?? null,
      createdBy: principal.userId,
    });

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.FIELD_REP_PROFILE_CHANGED,
      subjectType: 'field_rep_profile',
      subjectId: profile.id,
      actorId: principal.userId,
      payload: {
        userId: profile.userId,
        repRole: profile.repRole,
        status: profile.status,
        managerUserId: profile.managerUserId,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'fieldforce.profile.upsert',
      targetType: 'field_rep_profile',
      targetId: profile.id,
      metadata: { userId: profile.userId, repRole: profile.repRole },
    });
    return profile;
  });
}

export const ListFieldForceQuerySchema = z.object({
  managerUserId: z.string().uuid().optional(),
  status: z.enum(['active', 'on_leave', 'inactive']).optional(),
  repRole: z
    .enum(['representative', 'senior_representative', 'district_manager', 'regional_manager'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The field force this principal may see.
 *
 * A `territory:manage` holder sees the whole clinic's field force — that
 * permission owns the field organisation. Everyone else sees THEMSELVES plus
 * their own subtree, so a district manager gets their reports and an ordinary
 * representative gets exactly one row.
 */
export async function listFieldForce(
  principal: Principal,
  rawQuery: unknown,
): Promise<repo.FieldRepProfile[]> {
  requirePermission(principal, Permission.TERRITORY_READ);
  const query = parse(ListFieldForceQuerySchema, rawQuery ?? {}, 'field force query');

  let userIds: string[] | null = null;
  if (!hasPermission(principal, Permission.TERRITORY_MANAGE)) {
    const reports = await subordinateUserIds(principal.clinicId, principal.userId);
    userIds = [principal.userId, ...reports];
  }

  return repo.listProfiles(principal.clinicId, {
    managerUserId: query.managerUserId ?? null,
    status: query.status ?? null,
    repRole: query.repRole ?? null,
    userIds,
    limit: query.limit,
  });
}

/**
 * One representative's profile, their direct reports and their management chain.
 *
 * Readable by the person themselves, by anyone above them in the chain, and by
 * a `territory:manage` holder. Not by a peer: who reports to whom is
 * organisational information, and a colleague has no standing to walk it.
 */
export async function fieldRepProfile(principal: Principal, userId: string) {
  requirePermission(principal, Permission.TERRITORY_READ);
  const profile = await repo.getProfileByUser(principal.clinicId, userId);
  if (!profile) throw new NotFoundError('Field representative profile');

  if (
    userId !== principal.userId &&
    !hasPermission(principal, Permission.TERRITORY_MANAGE)
  ) {
    const reports = await subordinateUserIds(principal.clinicId, principal.userId);
    if (!reports.includes(userId)) {
      throw new ForbiddenError('This representative does not report to you');
    }
  }

  const [directReports, chain] = await Promise.all([
    repo.listProfiles(principal.clinicId, {
      managerUserId: userId,
      status: null,
      repRole: null,
      userIds: null,
      limit: 200,
    }),
    managerChainFor(principal.clinicId, userId),
  ]);

  return { profile, directReports, managerChain: chain };
}
