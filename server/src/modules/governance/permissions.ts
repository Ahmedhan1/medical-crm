/**
 * Permission catalog BARREL — owned by Agent 1 (Foundation / Governance).
 *
 * This file MERGES the per-workstream permission modules into the single
 * `Permission` catalog and the `ROLE_DEFINITIONS` contract used to seed RBAC and
 * to type-check authorization. Workstreams add permissions in their own
 * `permissions.<workstream>.ts` file, NOT here — so parallel agents never edit
 * the same file. Agent 1 only touches this barrel to wire in a brand-new
 * workstream module or change role identity (a CONTRACT_CHANGE_REQUEST).
 *
 * Public API is unchanged from the original single-file catalog:
 *   Permission, PERMISSION_DESCRIPTIONS, RoleKey, ROLE_DEFINITIONS
 */
import { RoleKey, ROLE_DESCRIPTIONS, type WorkstreamPermissions } from './roles.js';
import { platformPermissions, PlatformPermission } from './permissions.platform.js';
import { clinicalPermissions, ClinicalPermission } from './permissions.clinical.js';
import { automationPermissions, AutomationPermission } from './permissions.automation.js';
import { pharmaPermissions, PharmaPermission } from './permissions.pharma.js';

export { RoleKey } from './roles.js';

/** All permission constants, merged. Access as `Permission.PATIENT_READ`, etc. */
export const Permission = {
  ...PlatformPermission,
  ...ClinicalPermission,
  ...AutomationPermission,
  ...PharmaPermission,
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const WORKSTREAMS: WorkstreamPermissions[] = [
  platformPermissions,
  clinicalPermissions,
  automationPermissions,
  pharmaPermissions,
];

export const PERMISSION_DESCRIPTIONS: Record<string, string> = Object.assign(
  {},
  ...WORKSTREAMS.map((w) => w.descriptions),
);

const ALL_PERMISSIONS = Object.values(Permission) as Permission[];

export interface RoleDefinition {
  description: string;
  permissions: Permission[];
}

/**
 * Role → permission contract, assembled from role descriptions + each
 * workstream's declared grants. ADMIN always receives every permission.
 */
export const ROLE_DEFINITIONS: Record<RoleKey, RoleDefinition> = buildRoleDefinitions();

function buildRoleDefinitions(): Record<RoleKey, RoleDefinition> {
  const result = {} as Record<RoleKey, RoleDefinition>;
  for (const roleKey of Object.values(RoleKey)) {
    const granted = new Set<Permission>();
    if (roleKey === RoleKey.ADMIN) {
      for (const p of ALL_PERMISSIONS) granted.add(p);
    } else {
      for (const w of WORKSTREAMS) {
        for (const p of w.roleGrants[roleKey] ?? []) granted.add(p as Permission);
      }
    }
    result[roleKey] = {
      description: ROLE_DESCRIPTIONS[roleKey],
      permissions: [...granted],
    };
  }
  return result;
}
