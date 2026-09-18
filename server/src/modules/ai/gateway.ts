import { randomUUID } from 'node:crypto';
import { AppError } from '../../domain/errors.js';
import { audit } from '../governance/audit.js';
import type { AIProvider, ProviderTier } from './ai.types.js';
import { classifyCapabilityInput, severity, type AiCapability, type DataClass } from './classification.js';
import { decide, getTenantAiPolicy, permitsCloud, PolicyDecision } from './policy.js';
import { getLocalAIProvider, getCloudAIProvider } from './providers/registry.js';

/**
 * AI GATEWAY — the single chokepoint the AI safety chain runs through
 * (program §2). No AI capability calls a provider directly; each first calls
 * `authorizeAiRequest`, which classifies the input, applies the tenant AI
 * policy, and returns the provider it is ALLOWED to use. This is what makes the
 * guarantee "PHI never silently reaches a cloud model" structural rather than a
 * matter of remembering to check.
 *
 *   capability → classify → tenant policy → decision → provider selection
 *
 * Fail-closed: a DENY decision throws; ALLOW_LOCAL never returns a cloud
 * provider even if one is registered.
 */
export class AiPolicyDeniedError extends AppError {
  constructor(message: string, details?: unknown) {
    super(403, 'ai_policy_denied', message, details);
  }
}

export interface AiAuthorizationRequest {
  clinicId: string;
  capability: AiCapability;
  actorId?: string | null;
  /**
   * Override the intrinsic capability class upward (never downward). Used when a
   * specific request is even more sensitive than the capability default; it can
   * only raise sensitivity, never lower it.
   */
  escalateTo?: DataClass;
}

export interface AiAuthorization {
  requestId: string;
  capability: AiCapability;
  classification: DataClass;
  decision: PolicyDecision;
  provider: AIProvider;
  providerTier: ProviderTier;
}

export async function authorizeAiRequest(req: AiAuthorizationRequest): Promise<AiAuthorization> {
  const requestId = randomUUID();
  const baseClass = classifyCapabilityInput(req.capability);
  const classification = mostSensitive(baseClass, req.escalateTo);

  const policy = await getTenantAiPolicy(req.clinicId);
  const decision = decide(classification, policy);

  if (decision === PolicyDecision.DENY) {
    await audit({
      clinicId: req.clinicId,
      actorId: req.actorId ?? null,
      action: 'ai.request.denied',
      outcome: 'denied',
      targetType: 'ai_request',
      targetId: requestId,
      metadata: { capability: req.capability, dataClass: classification, decision },
    });
    throw new AiPolicyDeniedError('AI request denied by policy', { capability: req.capability });
  }

  // Provider selection. ALLOW_CLOUD may use the cloud provider IF one is
  // registered; otherwise local (always safe). ALLOW_LOCAL is local-only — a
  // registered cloud provider is deliberately NOT used here.
  const cloud = getCloudAIProvider();
  let provider: AIProvider;
  if (permitsCloud(decision) && cloud) {
    provider = cloud;
  } else {
    provider = getLocalAIProvider();
  }
  const providerTier: ProviderTier = provider.tier ?? 'local';

  // Defense in depth: never hand back a cloud provider for a non-cloud decision.
  if (providerTier === 'cloud' && !permitsCloud(decision)) {
    throw new AiPolicyDeniedError('Provider routing violated policy', {
      capability: req.capability,
      decision,
    });
  }

  return { requestId, capability: req.capability, classification, decision, provider, providerTier };
}

function mostSensitive(base: DataClass, escalateTo?: DataClass): DataClass {
  if (!escalateTo) return base;
  return severity(escalateTo) > severity(base) ? escalateTo : base;
}
