import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  bindsTo,
  canonicalizeEntitlement,
  createFeatureGate,
  evaluateStatus,
  isCoreFeature,
  newInstallationIdentity,
  resolveEntitlement,
  verifyEntitlementSignature,
  type Entitlement,
  type SignedEntitlement,
} from '../../src/modules/platform/entitlement/index.js';

// A throwaway control-plane signing key pair for the tests.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function makeEntitlement(over: Partial<Entitlement> = {}): Entitlement {
  return {
    installationId: 'inst-1',
    tenantId: 'tenant-1',
    customerId: 'cust-1',
    plan: 'clinic-pro',
    features: ['commercial:reporting-export', 'commercial:pharma-intelligence'],
    updateChannel: 'stable',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
    graceDays: 14,
    ...over,
  };
}

function signEntitlement(e: Entitlement): SignedEntitlement {
  const sig = cryptoSign(null, Buffer.from(canonicalizeEntitlement(e), 'utf8'), privateKey);
  return { payload: e, signatureB64: sig.toString('base64'), keyId: 'test-key' };
}

describe('entitlement signature verification (fail-closed)', () => {
  it('accepts a correctly signed entitlement', () => {
    expect(verifyEntitlementSignature(signEntitlement(makeEntitlement()), publicKeyPem)).toEqual({
      valid: true,
    });
  });

  it('rejects a tampered payload', () => {
    const signed = signEntitlement(makeEntitlement());
    const tampered = { ...signed, payload: { ...signed.payload, plan: 'clinic-enterprise' } };
    expect(verifyEntitlementSignature(tampered, publicKeyPem).valid).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const other = generateKeyPairSync('ed25519');
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyEntitlementSignature(signEntitlement(makeEntitlement()), otherPem).valid).toBe(
      false,
    );
  });

  it('never throws on malformed input — it fails closed', () => {
    expect(verifyEntitlementSignature({} as SignedEntitlement, publicKeyPem).valid).toBe(false);
    expect(
      verifyEntitlementSignature(signEntitlement(makeEntitlement()), 'not-a-key').valid,
    ).toBe(false);
  });

  it('canonical form is stable under feature reordering', () => {
    const a = makeEntitlement({ features: ['b', 'a'] });
    const b = makeEntitlement({ features: ['a', 'b'] });
    expect(canonicalizeEntitlement(a)).toBe(canonicalizeEntitlement(b));
  });
});

describe('entitlement time status (offline grace)', () => {
  const e = makeEntitlement(); // expires 2026-02-01, 14 grace days

  it('is active before expiry', () => {
    expect(evaluateStatus(e, new Date('2026-01-15T00:00:00Z'))).toBe('active');
  });
  it('is in grace within the grace window after expiry', () => {
    expect(evaluateStatus(e, new Date('2026-02-10T00:00:00Z'))).toBe('grace');
  });
  it('is expired past the grace window', () => {
    expect(evaluateStatus(e, new Date('2026-03-01T00:00:00Z'))).toBe('expired');
  });
  it('treats a malformed expiry as unverified', () => {
    expect(evaluateStatus(makeEntitlement({ expiresAt: 'nonsense' }), new Date())).toBe(
      'unverified',
    );
  });
});

describe('resolveEntitlement (verify + time, fail-closed)', () => {
  it('resolves a valid, current token to active', () => {
    const r = resolveEntitlement(
      signEntitlement(makeEntitlement()),
      publicKeyPem,
      new Date('2026-01-15T00:00:00Z'),
    );
    expect(r.status).toBe('active');
    expect(r.entitlement?.plan).toBe('clinic-pro');
  });

  it('resolves a missing cache to unverified', () => {
    const r = resolveEntitlement(null, publicKeyPem, new Date());
    expect(r.status).toBe('unverified');
    expect(r.entitlement).toBeNull();
  });

  it('resolves a bad signature to unverified (not active)', () => {
    const signed = signEntitlement(makeEntitlement());
    const tampered = { ...signed, payload: { ...signed.payload, tenantId: 'tenant-2' } };
    expect(resolveEntitlement(tampered, publicKeyPem, new Date('2026-01-15Z')).status).toBe(
      'unverified',
    );
  });
});

describe('bindsTo (anti-copy: installation + tenant)', () => {
  const resolved = resolveEntitlement(
    signEntitlement(makeEntitlement()),
    publicKeyPem,
    new Date('2026-01-15T00:00:00Z'),
  );
  it('accepts the matching installation and tenant', () => {
    expect(bindsTo(resolved, 'inst-1', 'tenant-1').ok).toBe(true);
  });
  it('rejects a different installation (membership copied to another box)', () => {
    expect(bindsTo(resolved, 'inst-2', 'tenant-1').ok).toBe(false);
  });
  it('rejects a different tenant', () => {
    expect(bindsTo(resolved, 'inst-1', 'tenant-9').ok).toBe(false);
  });
});

describe('feature gate (clinical core never gated)', () => {
  const gate = createFeatureGate();
  const active = resolveEntitlement(
    signEntitlement(makeEntitlement()),
    publicKeyPem,
    new Date('2026-01-15T00:00:00Z'),
  );
  const expired = resolveEntitlement(
    signEntitlement(makeEntitlement()),
    publicKeyPem,
    new Date('2026-03-01T00:00:00Z'),
  );
  const unverified = resolveEntitlement(null, publicKeyPem, new Date());

  it('marks core:* as a core feature', () => {
    expect(isCoreFeature('core:clinical')).toBe(true);
    expect(isCoreFeature('commercial:x')).toBe(false);
  });

  it('keeps clinical core enabled in EVERY status (active, expired, unverified)', () => {
    for (const r of [active, expired, unverified]) {
      expect(gate.isEnabled('core:clinical', r)).toBe(true);
      expect(gate.isEnabled('core:appointments', r)).toBe(true);
    }
  });

  it('enables a granted commercial feature only while active or in grace', () => {
    expect(gate.isEnabled('commercial:reporting-export', active)).toBe(true);
    const grace = resolveEntitlement(
      signEntitlement(makeEntitlement()),
      publicKeyPem,
      new Date('2026-02-10T00:00:00Z'),
    );
    expect(gate.isEnabled('commercial:reporting-export', grace)).toBe(true);
  });

  it('disables commercial features when expired or unverified (fail-closed)', () => {
    expect(gate.isEnabled('commercial:reporting-export', expired)).toBe(false);
    expect(gate.isEnabled('commercial:reporting-export', unverified)).toBe(false);
  });

  it('disables a commercial feature the membership did not grant', () => {
    expect(gate.isEnabled('commercial:not-granted', active)).toBe(false);
  });
});

describe('installation identity', () => {
  it('generates a unique id with a timestamp and no PHI', () => {
    const a = newInstallationIdentity('1.0.0');
    const b = newInstallationIdentity();
    expect(a.installationId).not.toBe(b.installationId);
    expect(Date.parse(a.createdAt)).not.toBeNaN();
    expect(a.boxVersion).toBe('1.0.0');
    expect(b.boxVersion).toBeUndefined();
  });
});
