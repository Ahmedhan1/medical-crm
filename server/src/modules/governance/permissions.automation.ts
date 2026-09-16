import { RoleKey, type WorkstreamPermissions } from './roles.js';

/**
 * AI / AUTOMATION / WHATSAPP permissions — owned by Agent 3.
 *
 * ADMIN automatically receives every permission (never list it here).
 * PHARMA_REP is deliberately granted NONE of these: the pharma role must never
 * touch patient-linked messaging, consent, or AI over clinical data.
 *
 * Do not edit other workstreams' permission files.
 */
export const AutomationPermission = {
  // Automation engine configuration is an administrative capability.
  AUTOMATION_MANAGE: 'automation:manage',
  AUTOMATION_READ: 'automation:read',

  // Messaging.
  MESSAGING_SEND: 'messaging:send',
  MESSAGING_READ: 'messaging:read',
  MESSAGING_MANAGE: 'messaging:manage', // templates, retries, delivery callbacks
  CONSENT_MANAGE: 'consent:manage',

  // Review-first AI.
  AI_DRAFT_CREATE: 'ai:draft-create',
  AI_DRAFT_REVIEW: 'ai:draft-review',
  AI_SUMMARY_GENERATE: 'ai:summary-generate',

  // AI safety & governance — tenant AI policy (cloud/PHI routing controls).
  AI_POLICY_MANAGE: 'ai:policy-manage',
} as const;

export const automationPermissions: WorkstreamPermissions = {
  permissions: AutomationPermission,
  descriptions: {
    [AutomationPermission.AUTOMATION_MANAGE]: 'Create, update, enable/disable and run automation rules',
    [AutomationPermission.AUTOMATION_READ]: 'View automation rules and their run history',
    [AutomationPermission.MESSAGING_SEND]: 'Send an outbound patient message (consent-gated)',
    [AutomationPermission.MESSAGING_READ]: 'View message delivery log and templates',
    [AutomationPermission.MESSAGING_MANAGE]: 'Manage message templates, retries and delivery status',
    [AutomationPermission.CONSENT_MANAGE]: 'Record a patient communication consent/preference',
    [AutomationPermission.AI_DRAFT_CREATE]: 'Generate a review-first AI draft (intake, summary)',
    [AutomationPermission.AI_DRAFT_REVIEW]: 'Review, confirm or reject an AI draft',
    [AutomationPermission.AI_SUMMARY_GENERATE]: 'Generate a longitudinal AI summary draft',
    [AutomationPermission.AI_POLICY_MANAGE]: 'View and set the clinic AI policy (cloud/PHI routing)',
  },
  roleGrants: {
    // Front desk: sends reminders, captures consent, starts AI intake drafts.
    [RoleKey.RECEPTION]: [
      AutomationPermission.MESSAGING_SEND,
      AutomationPermission.MESSAGING_READ,
      AutomationPermission.CONSENT_MANAGE,
      AutomationPermission.AI_DRAFT_CREATE,
    ],
    // Nursing/intake: creates and reviews drafts, generates summaries.
    [RoleKey.NURSE]: [
      AutomationPermission.MESSAGING_READ,
      AutomationPermission.AI_DRAFT_CREATE,
      AutomationPermission.AI_DRAFT_REVIEW,
      AutomationPermission.AI_SUMMARY_GENERATE,
    ],
    // Physician: reviews clinical AI drafts and generates summaries.
    [RoleKey.DOCTOR]: [
      AutomationPermission.MESSAGING_READ,
      AutomationPermission.AI_DRAFT_REVIEW,
      AutomationPermission.AI_SUMMARY_GENERATE,
    ],
  },
};
