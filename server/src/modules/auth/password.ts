import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { config } from '../../config/env.js';

/** Promisified scrypt that preserves the cost-parameter options argument. */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

// scrypt cost parameters. N must be a power of two. These give a ~50-100ms hash
// on modern hardware — strong enough for an on-prem clinic box while keeping
// login responsive. Encoded into the hash so parameters can evolve safely.
const PARAMS = { N: 16_384, r: 8, p: 1, keylen: 32 } as const;
const SALT_BYTES = 16;

/**
 * Hash a password with scrypt + a per-user random salt + a deployment-wide
 * pepper (from the secret manager, never stored in the DB). Format:
 *   scrypt$N$r$p$<saltHex>$<hashHex>
 * Self-describing so verification does not depend on current constants.
 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(peppered(password), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
  })) as Buffer;
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Verify a password against a stored hash. Constant-time comparison. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const salt = Buffer.from(saltHex!, 'hex');
  const expected = Buffer.from(hashHex!, 'hex');
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const derived = (await scrypt(peppered(password), salt, expected.length, { N, r, p })) as Buffer;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function peppered(password: string): string {
  return `${password}${config().authPepper}`;
}
