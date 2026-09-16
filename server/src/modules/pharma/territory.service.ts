import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { getHcpById } from '../hcp/hcp.repo.js';
import * as repo from './territory.repo.js';
import { territoryScopeFor } from './visibility.js';

/**
 * Territory model and HCP targeting.
 *
 * Territory definition is a management act (`territory:manage`); a field
 * representative only reads their own assignment. That asymmetry is what makes
 * territory scoping meaningful — a rep cannot widen their own visibility by
 * assigning themselves a new territory.
 */

export const CreateTerritorySchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(160),
  parentTerritoryId: z.string().uuid().optional(),
  country: z.string().trim().length(2),
  region: z.string().trim().max(120).optional(),
});

export const AssignTerritorySchema = z.object({
  userId: z.string().uuid(),
  assignmentRole: z.enum(['primary_rep', 'backup_rep', 'manager']).default('primary_rep'),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const TargetHcpSchema = z.object({
  hcpId: z.string().uuid(),
  isTarget: z.boolean().default(true),
  tier: z.enum(['A', 'B', 'C', 'D']).optional(),
  targetVisitsPerQuarter: z.number().int().min(0).max(60).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Invalid ${what}`, parsed.error.flatten());
  return parsed.data;
}

export async function createTerritory(principal: Principal, raw: unknown) {
  requirePermission(principal, Permission.TERRITORY_MANAGE);
  const input = parse(CreateTerritorySchema, raw, 'territory');

  return withTransaction(async (client) => {
    if (input.parentTerritoryId) {
      const parent = await repo.getTerritoryById(principal.clinicId, input.parentTerritoryId, client);
      if (!parent) throw new NotFoundError('Parent territory');
    }
    try {
      const territory = await repo.insertTerritory(client, {
        clinicId: principal.clinicId,
        code: input.code.toUpperCase(),
        name: input.name,
        parentTerritoryId: input.parentTerritoryId ?? null,
        country: input.country.toUpperCase(),
        region: input.region ?? null,
        createdBy: principal.userId,
      });
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.TERRITORY_CREATED,
        subjectType: 'territory',
        subjectId: territory.id,
        actorId: principal.userId,
        payload: { code: territory.code },
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'territory.create',
        targetType: 'territory',
        targetId: territory.id,
        metadata: { code: territory.code },
      });
      return territory;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('A territory with this code already exists');
      }
      throw err;
    }
  });
}

export async function assignTerritory(principal: Principal, territoryId: string, raw: unknown) {
  requirePermission(principal, Permission.TERRITORY_MANAGE);
  const input = parse(AssignTerritorySchema, raw, 'territory assignment');

  return withTransaction(async (client) => {
    const territory = await repo.getTerritoryById(principal.clinicId, territoryId, client);
    if (!territory) throw new NotFoundError('Territory');
    // The assignee must be a user of this clinic — never a cross-tenant id.
    const { rows } = await client.query(
      `SELECT 1 FROM app_user WHERE id = $1 AND clinic_id = $2 AND is_active`,
      [input.userId, principal.clinicId],
    );
    if (rows.length === 0) throw new NotFoundError('User');

    try {
      const assignment = await repo.insertAssignment(client, {
        clinicId: principal.clinicId,
        territoryId,
        userId: input.userId,
        assignmentRole: input.assignmentRole,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        createdBy: principal.userId,
      });
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.TERRITORY_ASSIGNED,
        subjectType: 'territory',
        subjectId: territoryId,
        actorId: principal.userId,
        payload: { userId: input.userId, assignmentRole: input.assignmentRole },
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'territory.assign',
        targetType: 'territory',
        targetId: territoryId,
        metadata: { userId: input.userId, assignmentRole: input.assignmentRole },
      });
      return { ...assignment, territoryCode: territory.code, territoryName: territory.name };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('This user already holds an open assignment for this territory');
      }
      throw err;
    }
  });
}

export async function targetHcp(principal: Principal, territoryId: string, raw: unknown) {
  requirePermission(principal, Permission.TERRITORY_MANAGE);
  const input = parse(TargetHcpSchema, raw, 'HCP target');

  return withTransaction(async (client) => {
    const territory = await repo.getTerritoryById(principal.clinicId, territoryId, client);
    if (!territory) throw new NotFoundError('Territory');
    const hcp = await getHcpById(principal.clinicId, input.hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');

    await repo.upsertHcpTarget(client, {
      clinicId: principal.clinicId,
      hcpId: input.hcpId,
      territoryId,
      isTarget: input.isTarget,
      tier: input.tier ?? null,
      targetVisitsPerQuarter: input.targetVisitsPerQuarter ?? null,
      assignedBy: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.HCP_TARGETED,
      subjectType: 'hcp',
      subjectId: input.hcpId,
      actorId: principal.userId,
      payload: { territoryId, tier: input.tier ?? null, isTarget: input.isTarget },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'territory.target',
      targetType: 'hcp',
      targetId: input.hcpId,
      metadata: { territoryId, tier: input.tier ?? null },
    });
    return { territoryId, hcpId: input.hcpId, tier: input.tier ?? null, isTarget: input.isTarget };
  });
}

/** Territories visible to the caller: all of them for a manager, theirs for a rep. */
export async function listTerritories(principal: Principal) {
  requirePermission(principal, Permission.TERRITORY_READ);
  const scope = await territoryScopeFor(principal);
  if (scope !== null && scope.length === 0) return [];
  return repo.listTerritories(principal.clinicId, scope);
}

/** The representative's own book of business: assignments + targeted HCPs. */
export async function myTerritory(principal: Principal) {
  requirePermission(principal, Permission.TERRITORY_READ);
  const assignments = await repo.listAssignmentsForUser(principal.clinicId, principal.userId);
  const territoryIds = assignments.map((a) => a.territoryId);
  const targets = await repo.listTargets(principal.clinicId, territoryIds);
  return { assignments, targets };
}
