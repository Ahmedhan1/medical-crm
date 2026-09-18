import { join } from 'node:path';

/**
 * On-box license/state locations. Everything lives under LICENSE_DIR (default
 * `./license`, set by the installer to a durable path outside the app tree so an
 * app upgrade never wipes the activation). None of these files contain PHI or a
 * private signing key — the box only ever holds the PUBLIC key and a signed
 * license issued for it.
 */
export function licenseDir(): string {
  return process.env.LICENSE_DIR ?? './license';
}

/** The stable per-installation identity (generated once at first run). */
export function installationPath(): string {
  return join(licenseDir(), 'installation.json');
}

/** The cached, signed license (the last-good entitlement). */
export function licensePath(): string {
  return join(licenseDir(), 'license.json');
}

/** Monotonic clock witness (anti clock-rollback). */
export function clockWitnessPath(): string {
  return join(licenseDir(), 'clock.json');
}

/**
 * The issuer's PUBLIC key (PEM SPKI), pinned into the box by the vendor. Provided
 * as an inline PEM (LICENSE_PUBLIC_KEY) or a file path (LICENSE_PUBLIC_KEY_FILE).
 * The PRIVATE key never lives on the box — see `issuer.ts`.
 */
export function publicKeyPemFromEnv(): string | null {
  if (process.env.LICENSE_PUBLIC_KEY && process.env.LICENSE_PUBLIC_KEY.includes('BEGIN')) {
    return process.env.LICENSE_PUBLIC_KEY;
  }
  return null;
}
