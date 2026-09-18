import type {
  Entitlement,
  EntitlementStatus,
  ResolvedEntitlement,
  SignedEntitlement,
} from './types.js';
import { verifyEntitlementSignature } from './verify.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluate the time-based status of an already-verified entitlement at `now`.
 * Pure. `expiresAt` is the hard online-reverification deadline; `graceDays` is how
 * long past it the BOX may keep honouring the last-good token while offline.
 */
export function evaluateStatus(entitlement: Entitlement, now: Date): EntitlementStatus {
  const expiresAt = Date.parse(entitlement.expiresAt);
  if (Number.isNaN(expiresAt)) return 'unverified';
  const t = now.getTime();
  if (t <= expiresAt) return 'active';
  const graceMs = Math.max(0, entitlement.graceDays) * DAY_MS;
  if (t <= expiresAt + graceMs) return 'grace';
  return 'expired';
}

/**
 * Resolve a cached signed entitlement end to end: verify the signature, then apply
 * the time window. FAIL-CLOSED — a missing cache or a bad signature resolves to
 * `unverified` with a reason, never to `active`. No exceptions escape.
 *
 * This makes NO clinical decision. `unverified`/`expired` only mean "commercial
 * features are off"; clinical core stays available (see `feature-gate`).
 */
export function resolveEntitlement(
  signed: SignedEntitlement | null,
  publicKeyPem: string,
  now: Date,
): ResolvedEntitlement {
  if (!signed) return { status: 'unverified', entitlement: null, reason: 'no entitlement cached' };
  const check = verifyEntitlementSignature(signed, publicKeyPem);
  if (!check.valid) return { status: 'unverified', entitlement: null, reason: check.reason };

  // Bind check: the token must be for THIS reasoning is left to the caller, which
  // knows its own installationId; here we only report time status of a valid sig.
  const status = evaluateStatus(signed.payload, now);
  return { status, entitlement: signed.payload, reason: status === 'active' ? undefined : status };
}

/**
 * Confirm a resolved entitlement actually belongs to this installation and tenant.
 * A signature can be valid yet issued for a DIFFERENT box; honouring it would let a
 * membership be copied between clinics. Pure; returns a reason on mismatch.
 */
export function bindsTo(
  resolved: ResolvedEntitlement,
  installationId: string,
  tenantId: string,
): { ok: boolean; reason?: string } {
  const e = resolved.entitlement;
  if (!e) return { ok: false, reason: 'no verified entitlement' };
  if (e.installationId !== installationId) return { ok: false, reason: 'installation mismatch' };
  if (e.tenantId !== tenantId) return { ok: false, reason: 'tenant mismatch' };
  return { ok: true };
}
