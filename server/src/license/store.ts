import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  newInstallationIdentity,
  type EntitlementStore,
  type InstallationIdentity,
  type SignedEntitlement,
} from '../modules/platform/entitlement/index.js';
import { installationPath, licensePath } from './paths.js';

function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

function readJson<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  ensureDir(file);
  // 0600 so the license/installation files are not world-readable.
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

/**
 * Load the box's installation identity, generating and persisting it on first
 * run. Idempotent: the same id is returned on every subsequent boot, so a license
 * issued for this installation keeps matching after restarts and upgrades.
 */
export function loadOrCreateInstallation(boxVersion?: string): InstallationIdentity {
  const existing = readJson<InstallationIdentity>(installationPath());
  if (existing?.installationId) return existing;
  const created = newInstallationIdentity(boxVersion);
  writeJson(installationPath(), created);
  return created;
}

/** File-backed implementation of the platform `EntitlementStore` contract. */
export const fileEntitlementStore: EntitlementStore = {
  load(): Promise<SignedEntitlement | null> {
    return Promise.resolve(readJson<SignedEntitlement>(licensePath()));
  },
  save(signed: SignedEntitlement): Promise<void> {
    writeJson(licensePath(), signed);
    return Promise.resolve();
  },
  clear(): Promise<void> {
    try {
      if (existsSync(licensePath())) writeFileSync(licensePath(), '', { mode: 0o600 });
    } catch {
      /* best effort */
    }
    return Promise.resolve();
  },
};
