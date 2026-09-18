/**
 * MEDCORE License Issuer — VENDOR-SIDE tool. Runs on the issuer's secure machine,
 * NOT on a customer box. It signs a license payload with the vendor's Ed25519
 * PRIVATE key, which is supplied at runtime (file or env) and never stored in the
 * repository or shipped to a box. The box only ever receives the resulting signed
 * license JSON and the PUBLIC key.
 *
 * Usage:
 *   tsx src/license/issuer.ts keygen --out ./vendor-keys
 *   tsx src/license/issuer.ts issue --key ./vendor-keys/private.pem --key-id k1 \
 *       --installation <id> --tenant <uuid> --customer <id> --plan clinic-pro \
 *       --edition Pro --features commercial:reporting-export,commercial:pharma-intelligence \
 *       --days 365 --grace 14 > license.json
 *   tsx src/license/issuer.ts verify --pub ./vendor-keys/public.pem --license license.json
 */
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalizeEntitlement,
  verifyEntitlementSignature,
  type Entitlement,
  type SignedEntitlement,
  type UpdateChannel,
} from '../modules/platform/entitlement/index.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required --${name}`);
}
function optArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function keygen(): void {
  const out = arg('out', './vendor-keys');
  mkdirSync(out, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(out, 'private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  writeFileSync(join(out, 'public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  // eslint-disable-next-line no-console
  console.error(
    `[issuer] wrote ${out}/private.pem (KEEP SECRET, 0600) and ${out}/public.pem (ship to boxes).`,
  );
}

function issue(): void {
  const privateKeyPem =
    process.env.LICENSE_SIGNING_KEY ?? readFileSync(arg('key'), 'utf8');
  const days = Number(arg('days', '365'));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const payload: Entitlement & { edition?: string } = {
    installationId: arg('installation'),
    tenantId: arg('tenant'),
    customerId: arg('customer'),
    plan: arg('plan', 'clinic-basic'),
    features: (optArg('features') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    updateChannel: (optArg('channel') ?? 'stable') as UpdateChannel,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    graceDays: Number(arg('grace', '14')),
    ...(optArg('edition') ? { edition: optArg('edition') } : {}),
  };
  const sig = edSign(null, Buffer.from(canonicalizeEntitlement(payload), 'utf8'), privateKeyPem);
  const signed: SignedEntitlement = {
    payload,
    signatureB64: sig.toString('base64'),
    keyId: arg('key-id', 'k1'),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(signed, null, 2));
}

function verify(): void {
  const pub = readFileSync(arg('pub'), 'utf8');
  const signed = JSON.parse(readFileSync(arg('license'), 'utf8')) as SignedEntitlement;
  const res = verifyEntitlementSignature(signed, pub);
  // eslint-disable-next-line no-console
  console.log(res.valid ? '[issuer] signature VALID' : `[issuer] signature INVALID: ${res.reason}`);
  if (!res.valid) process.exit(1);
}

const cmd = process.argv[2];
try {
  if (cmd === 'keygen') keygen();
  else if (cmd === 'issue') issue();
  else if (cmd === 'verify') verify();
  else {
    // eslint-disable-next-line no-console
    console.error('Usage: issuer.ts <keygen|issue|verify> [flags]');
    process.exit(2);
  }
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`[issuer] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
