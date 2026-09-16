import { getPool, type PoolClient } from '../../db/pool.js';
import { ForbiddenError } from '../../domain/errors.js';
import { Permission } from '../governance/permissions.js';
import { hasPermission, type Principal } from '../governance/rbac.js';

type Runner = Pick<PoolClient, 'query'>;

/**
 * Territory scope for a principal.
 *
 * `null` means unrestricted. Any other pharma principal — a field
 * representative — sees only HCPs targeted in a territory they are currently
 * assigned to.
 *
 * This is a second, independent scope on top of `clinic_id`: clinic scope stops
 * cross-tenant reads, territory scope stops a representative from browsing the
 * whole HCP master of their own clinic.
 */
export type TerritoryScope = string[] | null;

/**
 * Permissions whose holder works across the whole clinic, so territory scope
 * does not apply to them. Each entry is a deliberate judgement, not a
 * convenience:
 *
 * - `territory:manage` — owns the territory model itself (pharma manager, admin).
 * - `hcp:verify` — the data steward's job IS the whole master; scoping a steward
 *   to a territory they were never assigned would lock them out of the records
 *   they exist to curate.
 * - `scientificrequest:fulfill` — medical affairs answers questions from any HCP
 *   in the clinic and holds no territory.
 *
 * `PHARMA_REP` holds none of these and therefore stays territory-scoped, which
 * is the property the field-force and red-team tests assert.
 */
const CLINIC_WIDE_PHARMA_PERMISSIONS = [
  Permission.TERRITORY_MANAGE,
  Permission.HCP_VERIFY,
  Permission.SCIENTIFIC_REQUEST_FULFILL,
] as const;

/** Territory ids the user currently holds an open (or not yet expired) assignment for. */
export async function activeTerritoryIds(
  runner: Runner,
  clinicId: string,
  userId: string,
): Promise<string[]> {
  const { rows } = await runner.query<{ territory_id: string }>(
    `SELECT DISTINCT territory_id
       FROM territory_assignment
      WHERE clinic_id = $1
        AND user_id = $2
        AND valid_from <= current_date
        AND (valid_to IS NULL OR valid_to >= current_date)`,
    [clinicId, userId],
  );
  return rows.map((r) => r.territory_id);
}

export function isClinicWidePrincipal(principal: Principal): boolean {
  return CLINIC_WIDE_PHARMA_PERMISSIONS.some((permission) =>
    hasPermission(principal, permission),
  );
}

export async function territoryScopeFor(
  principal: Principal,
  runner: Runner = getPool(),
): Promise<TerritoryScope> {
  if (isClinicWidePrincipal(principal)) return null;
  return activeTerritoryIds(runner, principal.clinicId, principal.userId);
}

/**
 * Assert the principal may act on this HCP.
 *
 * Reported as *forbidden* rather than *not found*: within a clinic the
 * existence of an HCP is not itself the secret — the engagement data attached
 * to it is. (Cross-clinic reads are still indistinguishable from "not found",
 * because the row is filtered out by `clinic_id` before we get here.)
 */
export async function assertHcpInScope(
  principal: Principal,
  hcpId: string,
  runner: Runner = getPool(),
): Promise<void> {
  const scope = await territoryScopeFor(principal, runner);
  if (scope === null) return;
  if (scope.length === 0) {
    throw new ForbiddenError('You have no territory assignment, so no HCPs are in your scope');
  }
  const { rows } = await runner.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM hcp_territory
        WHERE clinic_id = $1 AND hcp_id = $2 AND territory_id = ANY($3)
     ) AS ok`,
    [principal.clinicId, hcpId, scope],
  );
  if (!rows[0]!.ok) {
    throw new ForbiddenError('This HCP is not targeted in a territory assigned to you');
  }
}
