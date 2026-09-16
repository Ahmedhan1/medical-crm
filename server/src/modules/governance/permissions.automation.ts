import { type WorkstreamPermissions } from './roles.js';

/**
 * AI / AUTOMATION / WHATSAPP permissions — owned by Agent 3.
 *
 * Example (uncomment and extend):
 *   export const AutomationPermission = {
 *     AUTOMATION_MANAGE: 'automation:manage',
 *     WHATSAPP_SEND: 'whatsapp:send',
 *     AI_DRAFT_REVIEW: 'ai:draft-review',
 *   } as const;
 *
 * Then fill `descriptions` and `roleGrants`. ADMIN automatically receives every
 * permission — never list ADMIN. Do not edit other workstreams' files.
 */
export const AutomationPermission = {} as const;

export const automationPermissions: WorkstreamPermissions = {
  permissions: AutomationPermission,
  descriptions: {},
  roleGrants: {},
};
