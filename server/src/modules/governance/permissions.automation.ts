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

  // AI Action Security Kernel (E4) — human-side management. These govern the
  // kernel; they are NOT granted to AI. An AI's authority is its ai_identity
  // scopes, a separate vocabulary that never appears in this catalog.
  AI_IDENTITY_MANAGE: 'ai:identity-manage', // create/disable AI identities, grant scopes
  AI_ACTION_CONFIRM: 'ai:action-confirm', // a human confirms a pending AI action

  // E5 batch.
  AI_RECEPTIONIST_USE: 'ai:receptionist', // use the administrative AI receptionist
  AI_EVAL_RUN: 'ai:eval-run', // run the AI evaluation suite

  // FHIR interoperability (Agent 3). An ADDITIONAL gate on the governed FHIR
  // REST API — it does NOT widen access: every FHIR read still goes through the
  // clinical service that owns the data, so the caller also needs that clinical
  // read permission (patient:read, observation:read, …). This permission only
  // decides who may use the interoperability surface at all.
  FHIR_READ: 'fhir:read',
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
    [AutomationPermission.AI_IDENTITY_MANAGE]: 'Create, disable and scope AI execution identities',
    [AutomationPermission.AI_ACTION_CONFIRM]: 'Confirm a pending AI action requiring human approval',
    [AutomationPermission.AI_RECEPTIONIST_USE]: 'Use the administrative AI receptionist (non-clinical)',
    [AutomationPermission.AI_EVAL_RUN]: 'Run the AI evaluation suite over synthetic fixtures',
    [AutomationPermission.FHIR_READ]: 'Use the FHIR interoperability API (in addition to the relevant clinical read permission)',
  },
  roleGrants: {
    // Front desk: sends reminders, captures consent, starts AI intake drafts,
    // and uses the administrative receptionist.
    [RoleKey.RECEPTION]: [
      AutomationPermission.MESSAGING_SEND,
      AutomationPermission.MESSAGING_READ,
      AutomationPermission.CONSENT_MANAGE,
      AutomationPermission.AI_DRAFT_CREATE,
      AutomationPermission.AI_RECEPTIONIST_USE,
    ],
    // Nursing/intake: creates and reviews drafts, generates summaries.
    [RoleKey.NURSE]: [
      AutomationPermission.MESSAGING_READ,
      AutomationPermission.AI_DRAFT_CREATE,
      AutomationPermission.AI_DRAFT_REVIEW,
      AutomationPermission.AI_SUMMARY_GENERATE,
    ],
    // Physician: reviews clinical AI drafts, generates summaries, and may use
    // the FHIR interoperability API (still bounded by their clinical reads).
    [RoleKey.DOCTOR]: [
      AutomationPermission.MESSAGING_READ,
      AutomationPermission.AI_DRAFT_REVIEW,
      AutomationPermission.AI_SUMMARY_GENERATE,
      AutomationPermission.FHIR_READ,
    ],
  },
};
