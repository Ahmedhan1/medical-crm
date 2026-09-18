import {
  bindsTo,
  featureGate,
  resolveEntitlement,
  verifyEntitlementSignature,
  type EntitlementStatus,
  type SignedEntitlement,
} from '../modules/platform/entitlement/index.js';
import { publicKeyPemFromEnv } from './paths.js';
import { fileEntitlementStore, loadOrCreateInstallation } from './store.js';
import { observeClock } from './clock.js';

/**
 * License service — the box-side operational layer over the platform entitlement
 * contract. It activates a signed license (verify → bind to THIS installation +
 * tenant → cache), and reports status on demand (cached license → verify → time
 * window → clock-rollback signal → feature gate).
 *
 * FAIL-SAFE, not fail-crippling: a missing/expired/unverified license disables
 * only COMMERCIAL features. Clinical-core (`core:*`) is never gated, so a clinic
 * keeps operating locally and offline exactly as the license model requires. The
 * PRIVATE signing key is never present here; the box holds only the public key.
 */
export interface LicenseStatus {
  status: EntitlementStatus;
  installationId: string;
  boundOk: boolean;
  clockRolledBack: boolean;
  reason?: string;
  license: {
    tenantId: string;
    customerId: string;
    plan: string;
    edition?: string;
    features: readonly string[];
    issuedAt: string;
    expiresAt: string;
    graceDays: number;
  } | null;
}

function publicKeyOrThrow(): string {
  const pem = publicKeyPemFromEnv();
  if (!pem) {
    throw new Error(
      'No license public key configured (set LICENSE_PUBLIC_KEY). The box cannot verify a license without the vendor public key.',
    );
  }
  return pem;
}

/**
 * Activate a signed license on this box. Verifies the signature against the
 * pinned public key AND that it was issued for THIS installation and tenant
 * (anti-copy), then caches it. Returns the resulting status. Throws on a bad
 * signature or a wrong-installation/tenant binding — activation fails closed.
 */
export async function activateLicense(
  signed: SignedEntitlement,
  now: Date = new Date(),
): Promise<LicenseStatus> {
  const pem = publicKeyOrThrow();
  const check = verifyEntitlementSignature(signed, pem);
  if (!check.valid) throw new Error(`License signature invalid: ${check.reason}`);

  const install = loadOrCreateInstallation();
  const resolved = resolveEntitlement(signed, pem, now);
  const bind = bindsTo(resolved, install.installationId, signed.payload.tenantId);
  if (!bind.ok) throw new Error(`License not valid for this installation: ${bind.reason}`);

  await fileEntitlementStore.save(signed);
  return getLicenseStatus(now);
}

/** Resolve the current license status from the cached license. Never throws. */
export async function getLicenseStatus(now: Date = new Date()): Promise<LicenseStatus> {
  const install = loadOrCreateInstallation();
  const clock = observeClock(now);
  const pem = publicKeyPemFromEnv();

  const signed = await fileEntitlementStore.load().catch(() => null);
  if (!pem || !signed) {
    return {
      status: 'unverified',
      installationId: install.installationId,
      boundOk: false,
      clockRolledBack: clock.rolledBack,
      reason: pem ? 'no license activated' : 'no public key configured',
      license: null,
    };
  }

  // If the clock was rolled back, evaluate expiry against the highest timestamp
  // ever seen instead of the (suspect) current clock — so grace cannot be
  // re-opened by moving the clock back.
  const evalNow = clock.rolledBack ? clock.maxSeen : now;
  const resolved = resolveEntitlement(signed, pem, evalNow);
  const bind = bindsTo(resolved, install.installationId, signed.payload.tenantId);
  const p = signed.payload as typeof signed.payload & { edition?: string };

  return {
    status: bind.ok ? resolved.status : 'unverified',
    installationId: install.installationId,
    boundOk: bind.ok,
    clockRolledBack: clock.rolledBack,
    reason: bind.ok ? resolved.reason : (bind.reason ?? 'binding failed'),
    license: {
      tenantId: p.tenantId,
      customerId: p.customerId,
      plan: p.plan,
      edition: p.edition,
      features: p.features,
      issuedAt: p.issuedAt,
      expiresAt: p.expiresAt,
      graceDays: p.graceDays,
    },
  };
}

/** Is a feature available under the current license? Clinical-core is always on. */
export async function isFeatureLicensed(featureKey: string, now: Date = new Date()): Promise<boolean> {
  const pem = publicKeyPemFromEnv();
  const signed = pem ? await fileEntitlementStore.load().catch(() => null) : null;
  const resolved = resolveEntitlement(signed ?? null, pem ?? '', now);
  return featureGate.isEnabled(featureKey, resolved);
}
