import { randomUUID } from 'node:crypto';
import { DataClass, severity, type DataClass as DataClassType } from '../classification.js';
import { getTenantAiPolicy, decide, PolicyDecision } from '../policy.js';
import { getIdentity } from './identity.js';
import { getTool } from './tools.js';
import { RiskClass, riskWithinCeiling, riskRequiresConfirmation } from './risk.js';
import { verifyConfirmationToken } from './confirmation.js';

/**
 * AI ACTION GUARD (E4) — the single, FAIL-CLOSED authorization decision for any
 * AI-initiated action. It never defaults to allow: every missing or mismatched
 * input yields DENY (or REQUIRE_CONFIRMATION where a human gate applies).
 *
 *   identity → status → tool → prohibited → enabled → risk ceiling → scope
 *            → data classification vs tool + identity ceilings → tenant AI policy
 *            → human confirmation → ALLOW
 *
 * It consumes the E3 classification + policy model (never a second one) and is a
 * SEPARATE concern from provider routing (the E3 gateway) — an AI capability
 * that both reads via a provider and performs an action passes through both.
 */
export type AiDecision = 'allow' | 'deny' | 'require_confirmation';

export interface AiActionRequest {
  clinicId: string;
  identityId: string;
  toolId: string;
  /** Classification of the data this specific action touches. Defaults to the
   *  tool's own ceiling (the most permissive the tool allows). */
  dataClass?: DataClassType;
  /** A human confirmation token bound to this exact action, if one was issued. */
  confirmationToken?: string;
  actorId?: string | null;
}

export interface AiActionDecision {
  requestId: string;
  decision: AiDecision;
  reasonCode: string;
  clinicId: string;
  identityId: string;
  toolId: string;
  access: 'read' | 'write' | null;
  risk: RiskClass | null;
  dataClass: DataClassType;
  confirmationRequired: boolean;
  /** Human-presentable context for a future UI/API. Never contains PHI. */
  detail: { toolName?: string; description?: string };
}

function deny(req: AiActionRequest, requestId: string, reasonCode: string, extra: Partial<AiActionDecision> = {}): AiActionDecision {
  return {
    requestId,
    decision: 'deny',
    reasonCode,
    clinicId: req.clinicId,
    identityId: req.identityId,
    toolId: req.toolId,
    access: extra.access ?? null,
    risk: extra.risk ?? null,
    dataClass: extra.dataClass ?? DataClass.INTERNAL,
    confirmationRequired: false,
    detail: extra.detail ?? {},
  };
}

export async function authorizeAiAction(req: AiActionRequest): Promise<AiActionDecision> {
  const requestId = randomUUID();

  // 1. Identity must exist within this tenant (a cross-tenant id is not found).
  const identity = await getIdentity(req.clinicId, req.identityId);
  if (!identity) return deny(req, requestId, 'unknown_identity');
  if (identity.status !== 'active') return deny(req, requestId, 'identity_disabled');

  // 2. Tool must be a known registry entry (unknown ⇒ fail closed).
  const tool = getTool(req.toolId);
  if (!tool) return deny(req, requestId, 'unknown_tool');
  const detail = { toolName: tool.name, description: tool.description };

  // 3. Prohibited clinical actions are denied unconditionally, before anything else.
  if (tool.risk === RiskClass.PROHIBITED) {
    return deny(req, requestId, 'prohibited', { access: tool.access, risk: tool.risk, dataClass: tool.dataCeiling, detail });
  }
  if (!tool.enabled) {
    return deny(req, requestId, 'tool_disabled', { access: tool.access, risk: tool.risk, dataClass: tool.dataCeiling, detail });
  }

  // 4. Identity risk ceiling.
  if (!riskWithinCeiling(tool.risk, identity.riskCeiling)) {
    return deny(req, requestId, 'risk_exceeds_ceiling', { access: tool.access, risk: tool.risk, dataClass: tool.dataCeiling, detail });
  }

  // 5. Explicit AI scope (never a human RBAC permission).
  if (!identity.scopes.includes(tool.requiredScope)) {
    return deny(req, requestId, 'missing_permission', { access: tool.access, risk: tool.risk, dataClass: tool.dataCeiling, detail });
  }

  // 6. Data classification vs the tool ceiling AND the identity ceiling.
  //    The effective class is the MORE sensitive of the caller's declared class
  //    and the tool's own level, so a caller cannot DOWNGRADE (under-declare) a
  //    PHI tool to slip past a low identity ceiling.
  const declared = req.dataClass ?? tool.dataCeiling;
  const dataClass = severity(declared) > severity(tool.dataCeiling) ? declared : tool.dataCeiling;
  if (severity(dataClass) > severity(tool.dataCeiling)) {
    return deny(req, requestId, 'classification_exceeds_tool_ceiling', { access: tool.access, risk: tool.risk, dataClass, detail });
  }
  if (severity(dataClass) > severity(identity.dataCeiling)) {
    return deny(req, requestId, 'classification_exceeds_identity_ceiling', { access: tool.access, risk: tool.risk, dataClass, detail });
  }

  // 7. Consult the E3 tenant AI policy (never a second classification system).
  const policy = await getTenantAiPolicy(req.clinicId);
  if (decide(dataClass, policy) === PolicyDecision.DENY) {
    return deny(req, requestId, 'policy_denied', { access: tool.access, risk: tool.risk, dataClass, detail });
  }

  // 8. Human confirmation gate.
  const needsConfirmation = tool.requiresConfirmation || riskRequiresConfirmation(tool.risk);
  const base: Omit<AiActionDecision, 'decision' | 'reasonCode' | 'confirmationRequired'> = {
    requestId,
    clinicId: req.clinicId,
    identityId: req.identityId,
    toolId: req.toolId,
    access: tool.access,
    risk: tool.risk,
    dataClass,
    detail,
  };
  if (needsConfirmation) {
    const confirmed = verifyConfirmationToken(
      { clinicId: req.clinicId, identityId: req.identityId, toolId: req.toolId, dataClass },
      req.confirmationToken,
    );
    if (!confirmed) {
      return { ...base, decision: 'require_confirmation', reasonCode: 'confirmation_required', confirmationRequired: true };
    }
  }

  return { ...base, decision: 'allow', reasonCode: 'authorized', confirmationRequired: needsConfirmation };
}
