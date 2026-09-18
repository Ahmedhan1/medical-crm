/**
 * MEDCORE BOX membership / entitlement foundation (Phase 0 contract).
 * Pure boundary logic only — no cloud service, no persistence wiring, no coupling
 * to clinical/AI/pharma behavior. See `types.ts` for the contract and the module
 * docs for the Cloud Control Plane ↔ BOX flow.
 */
export * from './types.js';
export {
  canonicalizeEntitlement,
  verifyEntitlementSignature,
  newInstallationIdentity,
} from './verify.js';
export { evaluateStatus, resolveEntitlement, bindsTo } from './grace.js';
export { CORE_FEATURE_PREFIX, isCoreFeature, createFeatureGate, featureGate } from './feature-gate.js';
