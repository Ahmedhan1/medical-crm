import { ForbiddenError } from '../../domain/errors.js';
import type { Permission } from './permissions.js';

/**
 * The authenticated principal attached to each request. Authorization decisions
 * use ONLY this object — permissions are resolved at login and carried per
 * request, and every data query is additionally scoped to `clinicId`.
 */
export interface Principal {
  userId: string;
  clinicId: string;
  username: string;
  roles: string[];
  permissions: ReadonlySet<Permission>;
}

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.permissions.has(permission);
}

/**
 * Assert the principal holds a permission, throwing ForbiddenError otherwise.
 * Never bypassed "for convenience" (§48).
 */
export function requirePermission(principal: Principal, permission: Permission): void {
  if (!hasPermission(principal, permission)) {
    throw new ForbiddenError(`Missing required permission: ${permission}`);
  }
}

/**
 * Assert a target row belongs to the principal's clinic (data-scope / tenant
 * isolation). Prevents a valid user in clinic A from reading clinic B's data
 * even if they somehow obtain an id.
 */
export function assertSameClinic(principal: Principal, resourceClinicId: string): void {
  if (principal.clinicId !== resourceClinicId) {
    // Report as not-visible rather than leaking existence across tenants.
    throw new ForbiddenError('Resource is outside your clinic scope');
  }
}
