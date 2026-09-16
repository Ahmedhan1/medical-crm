import { type WorkstreamPermissions } from './roles.js';

/**
 * PHARMA / HCP / DRUG / INTELLIGENCE permissions — owned by Agent 4.
 *
 * GOVERNANCE BOUNDARY (blueprint §45): pharma roles must NEVER receive any
 * patient/clinical permission. Grant pharma permissions to PHARMA_REP (and any
 * future pharma roles), never to clinical roles, and never grant clinical
 * permissions here.
 *
 * Example (uncomment and extend):
 *   export const PharmaPermission = {
 *     HCP_READ: 'hcp:read',
 *     TERRITORY_READ: 'territory:read',
 *     CALL_REPORT_WRITE: 'callreport:write',
 *     INTELLIGENCE_SIGNAL_READ: 'intelligence:signal-read',
 *   } as const;
 *
 * ADMIN automatically receives every permission — never list ADMIN.
 */
export const PharmaPermission = {} as const;

export const pharmaPermissions: WorkstreamPermissions = {
  permissions: PharmaPermission,
  descriptions: {},
  roleGrants: {},
};
