import { type WorkstreamPermissions } from './roles.js';

/**
 * PLATFORM permissions — owned by Agent 1 (Foundation / Platform).
 *
 * Operational capabilities that are not domain features: backup/restore,
 * platform administration. Granted to ADMIN only (ADMIN receives every
 * permission automatically); a dedicated PLATFORM_OPERATOR role can be added
 * later if duties need to be split from clinic administration.
 *
 * RESTORE is deliberately NOT a permission-gated HTTP action — it is an
 * operator CLI action (see `backup-cli.ts`), so a compromised web session can
 * never overwrite the live database.
 */
export const PlatformPermission = {
  BACKUP_MANAGE: 'backup:manage', // create/list/verify backups via the admin API
  LICENSE_MANAGE: 'license:manage', // view license status via the admin API
} as const;

export const platformPermissions: WorkstreamPermissions = {
  permissions: PlatformPermission,
  descriptions: {
    [PlatformPermission.BACKUP_MANAGE]: 'Create, list and verify database backups',
    [PlatformPermission.LICENSE_MANAGE]: 'View MEDCORE license status',
  },
  // No explicit roleGrants: ADMIN automatically receives every permission.
  roleGrants: {},
};
