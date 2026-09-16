import { getPool } from '../../db/pool.js';
import { config } from '../../config/env.js';
import { UnauthorizedError } from '../../domain/errors.js';
import { audit } from '../governance/audit.js';
import type { Principal } from '../governance/rbac.js';
import type { Permission } from '../governance/permissions.js';
import { findUserForLogin, findUserBySessionHash } from '../identity/users.repo.js';
import { verifyPassword } from './password.js';
import { generateToken, hashToken } from './tokens.js';
import { getLoginThrottle, accountKey } from './throttle.js';

export interface LoginResult {
  token: string;
  expiresAt: Date;
  principal: Principal;
}

/**
 * Authenticate a user within a clinic and open a session.
 *
 * Security: a single generic error is returned whether the clinic, username, or
 * password is wrong (no user-enumeration), and the password check always runs
 * against a real or dummy hash to keep timing uniform.
 */
export async function login(
  clinicId: string,
  username: string,
  password: string,
  ip?: string,
): Promise<LoginResult> {
  const throttle = getLoginThrottle();
  const acctKey = accountKey(clinicId, username);

  // Brute-force protection (fail-closed): reject before doing any work if this
  // IP is over its per-minute cap or this account is locked. Generic messages —
  // never reveal whether the account exists.
  throttle.assertIpUnderLimit(ip);
  throttle.assertAccountNotLocked(acctKey);

  const user = await findUserForLogin(clinicId, username);

  // Constant-ish work whether or not the user exists (mitigates enumeration).
  const hashToCheck =
    user?.passwordHash ??
    'scrypt$16384$8$1$00000000000000000000000000000000$00000000000000000000000000000000000000000000000000000000000000000';
  const ok = await verifyPassword(password, hashToCheck);

  if (!user || !user.isActive || !ok) {
    throttle.recordFailure(acctKey);
    await audit({
      clinicId,
      action: 'auth.login',
      outcome: 'denied',
      metadata: { username },
      ip: ip ?? null,
    });
    throw new UnauthorizedError('Invalid credentials');
  }

  throttle.recordSuccess(acctKey);

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config().sessionTtlSeconds * 1000);

  await getPool().query(
    `INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt],
  );

  await audit({
    clinicId,
    actorId: user.id,
    action: 'auth.login',
    outcome: 'success',
    metadata: { username },
    ip: ip ?? null,
  });

  return { token, expiresAt, principal: toPrincipal(user) };
}

/** Resolve a bearer token to a principal, or null if invalid/expired. */
export async function authenticate(token: string): Promise<Principal | null> {
  if (!token) return null;
  const user = await findUserBySessionHash(hashToken(token));
  return user ? toPrincipal(user) : null;
}

/** Revoke the session backing a bearer token (logout). Idempotent. */
export async function logout(token: string): Promise<void> {
  await getPool().query(
    `UPDATE session SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}

function toPrincipal(user: {
  id: string;
  clinicId: string;
  username: string;
  roles: string[];
  permissions: Permission[];
}): Principal {
  return {
    userId: user.id,
    clinicId: user.clinicId,
    username: user.username,
    roles: user.roles,
    permissions: new Set(user.permissions),
  };
}
