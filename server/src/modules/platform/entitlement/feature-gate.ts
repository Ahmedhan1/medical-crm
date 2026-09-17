import type { FeatureGate, ResolvedEntitlement } from './types.js';

/**
 * The `core:` prefix marks a CLINICAL-CORE capability. Core features are ALWAYS
 * enabled, regardless of membership status or Internet reachability. This is the
 * single hard safety rule of the whole membership model: a clinic that has not
 * paid, whose token expired, or that is offline, must still be able to run
 * clinical workflows and reach clinical data. Losing membership degrades COMMERCIAL
 * features only.
 */
export const CORE_FEATURE_PREFIX = 'core:';

/** True for a clinical-core feature key that must never be gated. */
export function isCoreFeature(featureKey: string): boolean {
  return featureKey.startsWith(CORE_FEATURE_PREFIX);
}

/**
 * The default platform feature gate.
 *
 * - Core (`core:*`) features: always enabled — never gated by membership.
 * - Commercial features: enabled only when the entitlement is `active` or in
 *   offline `grace` AND the feature key is in the entitlement's granted list.
 *   `expired` and `unverified` disable commercial features (fail-closed), while
 *   leaving clinical core untouched.
 *
 * Pure and side-effect free. Nothing in the clinical/AI/pharma domains consults it
 * yet; wiring a specific domain feature to a commercial key is a Final-phase change
 * that must go through a CCR so it can be reviewed against this safety rule.
 */
export function createFeatureGate(): FeatureGate {
  return {
    isEnabled(featureKey: string, resolved: ResolvedEntitlement): boolean {
      if (isCoreFeature(featureKey)) return true;
      if (resolved.status !== 'active' && resolved.status !== 'grace') return false;
      const granted = resolved.entitlement?.features ?? [];
      return granted.includes(featureKey);
    },
  };
}

/** Shared default instance. */
export const featureGate: FeatureGate = createFeatureGate();
