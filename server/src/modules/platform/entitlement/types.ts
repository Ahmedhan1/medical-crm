/**
 * MEDCORE BOX — membership / entitlement CONTRACT (Phase 0 foundation).
 *
 * MEDCORE is distributed as a local-first "BOX" (backend + Postgres + frontend on
 * the clinic's own hardware). Commercial access is governed by a MEMBERSHIP, not a
 * license-key file: a future Cloud Control Plane issues a SIGNED ENTITLEMENT that
 * the BOX verifies and caches locally, so the clinic keeps operating offline.
 *
 * This module defines the boundary types and the pure verification/gating logic.
 * It deliberately does NOT implement the cloud service, a persistence layer, or
 * any wiring into clinical/AI/pharma routes — those are Final-phase work. The one
 * invariant fixed here for safety: **clinical-core features are never gated.**
 * Losing membership (or the Internet) must degrade commercial features only; it
 * must never disable a clinical workflow or make clinical data unreachable.
 */

/** Stable identity a BOX generates once at first run. Carries no PHI. */
export interface InstallationIdentity {
  /** Opaque per-installation UUID. Not a secret; identifies the BOX to the plane. */
  readonly installationId: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** Optional BOX software version at creation (informational). */
  readonly boxVersion?: string;
}

/** Release channel a BOX follows for updates. */
export type UpdateChannel = 'stable' | 'beta';

/**
 * The claim the Cloud Control Plane signs. It binds a membership to ONE
 * installation and tenant, lists the commercial features granted, and carries a
 * hard expiry plus an offline grace window. It contains no PHI and no secret.
 */
export interface Entitlement {
  readonly installationId: string;
  readonly tenantId: string;
  readonly customerId: string;
  /** Membership plan key, e.g. `clinic-basic`, `clinic-pro`. */
  readonly plan: string;
  /** Commercial feature keys this membership grants (never core clinical keys). */
  readonly features: readonly string[];
  readonly updateChannel: UpdateChannel;
  /** ISO-8601. When the plane issued this token. */
  readonly issuedAt: string;
  /** ISO-8601. Hard expiry of the token; the BOX must re-verify online by then. */
  readonly expiresAt: string;
  /**
   * Days AFTER `expiresAt` the BOX may keep honouring the last-good entitlement
   * while it cannot reach the plane (the offline grace period). Commercial
   * features stay on through grace; clinical core is unaffected either way.
   */
  readonly graceDays: number;
}

/** An `Entitlement` plus the plane's detached signature over its canonical form. */
export interface SignedEntitlement {
  readonly payload: Entitlement;
  /** Base64 Ed25519 signature over `canonicalize(payload)`. */
  readonly signatureB64: string;
  /** Which control-plane signing key produced the signature (rotation support). */
  readonly keyId: string;
}

/**
 * The effective state of an entitlement at a moment in time.
 * - `active`     signature valid and now ≤ expiresAt
 * - `grace`      signature valid, expired, but within the offline grace window
 * - `expired`    signature valid but past the grace window
 * - `unverified` signature missing/invalid, or no entitlement cached at all
 */
export type EntitlementStatus = 'active' | 'grace' | 'expired' | 'unverified';

/** Result of resolving a (possibly signed) entitlement at `now`. */
export interface ResolvedEntitlement {
  readonly status: EntitlementStatus;
  /** The verified entitlement, when the signature was valid; otherwise null. */
  readonly entitlement: Entitlement | null;
  /** Human-readable reason for a non-active status (diagnostics; no PHI). */
  readonly reason?: string;
}

/**
 * Local cache of the last-good signed entitlement. The BOX reads this at boot and
 * on every online verification; it survives offline so the clinic keeps working.
 * Phase 0 defines the contract only — a concrete file/DB store is Final-phase.
 */
export interface EntitlementStore {
  load(): Promise<SignedEntitlement | null>;
  save(signed: SignedEntitlement): Promise<void>;
  clear(): Promise<void>;
}

/**
 * The feature-gating boundary the rest of the platform will consult in the Final
 * phase. Wiring specific domain features to keys goes through a CCR — this is the
 * mechanism, not a policy that gates anything today.
 */
export interface FeatureGate {
  /** True if `featureKey` is available given the resolved entitlement. */
  isEnabled(featureKey: string, resolved: ResolvedEntitlement): boolean;
}
