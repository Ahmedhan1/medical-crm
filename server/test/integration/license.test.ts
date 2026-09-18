import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import {
  canonicalizeEntitlement,
  type Entitlement,
  type SignedEntitlement,
} from '../../src/modules/platform/entitlement/index.js';
import { activateLicense, getLicenseStatus, isFeatureLicensed } from '../../src/license/service.js';
import { loadOrCreateInstallation } from '../../src/license/store.js';

/**
 * License service — box-side activation/verification/grace/anti-copy/anti-rollback.
 * Uses a throwaway vendor key pair and an isolated LICENSE_DIR per test.
 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

let dir: string;

function sign(payload: Entitlement): SignedEntitlement {
  const sig = edSign(null, Buffer.from(canonicalizeEntitlement(payload), 'utf8'), privateKey);
  return { payload, signatureB64: sig.toString('base64'), keyId: 'test' };
}

function licenseFor(installationId: string, over: Partial<Entitlement> = {}): SignedEntitlement {
  const now = new Date('2026-06-01T00:00:00Z');
  return sign({
    installationId,
    tenantId: 'tenant-1',
    customerId: 'cust-1',
    plan: 'clinic-pro',
    features: ['commercial:reporting-export'],
    updateChannel: 'stable',
    issuedAt: now.toISOString(),
    expiresAt: '2026-07-01T00:00:00Z',
    graceDays: 14,
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'medcore-lic-'));
  process.env.LICENSE_DIR = dir;
  process.env.LICENSE_PUBLIC_KEY = publicKeyPem;
});
afterEach(() => {
  delete process.env.LICENSE_DIR;
  delete process.env.LICENSE_PUBLIC_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe('license activation + status', () => {
  it('is unverified before activation, and clinical core stays available', async () => {
    const s = await getLicenseStatus(new Date('2026-06-10Z'));
    expect(s.status).toBe('unverified');
    expect(await isFeatureLicensed('core:clinical', new Date('2026-06-10Z'))).toBe(true);
    expect(await isFeatureLicensed('commercial:reporting-export', new Date('2026-06-10Z'))).toBe(
      false,
    );
  });

  it('activates a valid license bound to THIS installation and reports active', async () => {
    const install = loadOrCreateInstallation();
    await activateLicense(licenseFor(install.installationId), new Date('2026-06-10Z'));
    const s = await getLicenseStatus(new Date('2026-06-10Z'));
    expect(s.status).toBe('active');
    expect(s.boundOk).toBe(true);
    expect(await isFeatureLicensed('commercial:reporting-export', new Date('2026-06-10Z'))).toBe(
      true,
    );
  });

  it('refuses a license issued for a DIFFERENT installation (anti-copy)', async () => {
    await expect(
      activateLicense(licenseFor('some-other-box'), new Date('2026-06-10Z')),
    ).rejects.toThrow(/not valid for this installation/i);
  });

  it('refuses a tampered license (bad signature) — fail closed', async () => {
    const install = loadOrCreateInstallation();
    const good = licenseFor(install.installationId);
    const tampered = { ...good, payload: { ...good.payload, plan: 'enterprise' } };
    await expect(activateLicense(tampered, new Date('2026-06-10Z'))).rejects.toThrow(/invalid/i);
  });

  it('enters offline grace after expiry, then expires past the grace window', async () => {
    const install = loadOrCreateInstallation();
    await activateLicense(licenseFor(install.installationId), new Date('2026-06-10Z'));
    // expiresAt 2026-07-01, grace 14 days
    expect((await getLicenseStatus(new Date('2026-07-05Z'))).status).toBe('grace');
    expect((await getLicenseStatus(new Date('2026-08-01Z'))).status).toBe('expired');
    // Clinical core remains available even when expired.
    expect(await isFeatureLicensed('core:clinical', new Date('2026-08-01Z'))).toBe(true);
    expect(await isFeatureLicensed('commercial:reporting-export', new Date('2026-08-01Z'))).toBe(
      false,
    );
  });

  it('does not re-open grace when the clock is rolled back past tolerance', async () => {
    const install = loadOrCreateInstallation();
    await activateLicense(licenseFor(install.installationId), new Date('2026-06-10Z'));
    // Advance well past the grace window so the witness records a late time.
    expect((await getLicenseStatus(new Date('2026-08-01Z'))).status).toBe('expired');
    // Now the clock is rolled back to look "active" again — must NOT be honoured.
    const rolled = await getLicenseStatus(new Date('2026-06-10Z'));
    expect(rolled.clockRolledBack).toBe(true);
    expect(rolled.status).toBe('expired');
  });
});
