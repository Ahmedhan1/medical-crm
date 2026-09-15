import { randomBytes, createHash } from 'node:crypto';

/**
 * Opaque bearer-token helpers shared by sessions and QR identity tokens.
 *
 * Security model: we generate a high-entropy random token, hand the RAW token
 * to the client, and persist only its SHA-256 hash. A database read therefore
 * never exposes a usable credential, and QR codes carry only this opaque
 * reference — never PHI (blueprint §43).
 */
export function generateToken(bytes = 32): string {
  // base64url: URL/QR-safe, no padding.
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
