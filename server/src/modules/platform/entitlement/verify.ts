import { createPublicKey, randomUUID, verify as cryptoVerify } from 'node:crypto';
import type { Entitlement, InstallationIdentity, SignedEntitlement } from './types.js';

/**
 * Canonical byte form of an entitlement, so the BOX and the Control Plane sign and
 * verify EXACTLY the same bytes. Keys are emitted in a fixed order (not JS object
 * order, which is fragile), and `features` is sorted so an array reordering does
 * not change the signature. Pure and deterministic.
 */
export function canonicalizeEntitlement(e: Entitlement): string {
  const ordered = {
    customerId: e.customerId,
    expiresAt: e.expiresAt,
    features: [...e.features].sort(),
    graceDays: e.graceDays,
    installationId: e.installationId,
    issuedAt: e.issuedAt,
    plan: e.plan,
    tenantId: e.tenantId,
    updateChannel: e.updateChannel,
  };
  return JSON.stringify(ordered);
}

/**
 * Verify the Control Plane's Ed25519 signature over a signed entitlement, using a
 * PEM SPKI public key the BOX ships/pins. FAIL-CLOSED: any malformed input, wrong
 * key, or tampered payload returns `{ valid: false }` — never throws, never
 * defaults to valid. This function makes no time or policy decision; expiry/grace
 * is `evaluateStatus`.
 */
export function verifyEntitlementSignature(
  signed: SignedEntitlement,
  publicKeyPem: string,
): { valid: boolean; reason?: string } {
  try {
    if (!signed?.payload || typeof signed.signatureB64 !== 'string') {
      return { valid: false, reason: 'malformed signed entitlement' };
    }
    const key = createPublicKey(publicKeyPem);
    const message = Buffer.from(canonicalizeEntitlement(signed.payload), 'utf8');
    const signature = Buffer.from(signed.signatureB64, 'base64');
    if (signature.length === 0) return { valid: false, reason: 'empty signature' };
    const ok = cryptoVerify(null, message, key, signature);
    return ok ? { valid: true } : { valid: false, reason: 'signature mismatch' };
  } catch (err) {
    // A bad key, bad base64, or unsupported algorithm all fail closed.
    return { valid: false, reason: err instanceof Error ? err.message : 'verify error' };
  }
}

/**
 * Generate a fresh installation identity (first-run). Pure aside from the random
 * id and clock; carries no PHI and no secret. The BOX persists this via an
 * `EntitlementStore`-adjacent mechanism (Final phase).
 */
export function newInstallationIdentity(boxVersion?: string): InstallationIdentity {
  return {
    installationId: randomUUID(),
    createdAt: new Date().toISOString(),
    ...(boxVersion ? { boxVersion } : {}),
  };
}
