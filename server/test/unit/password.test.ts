import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js';
import { generateToken, hashToken } from '../../src/modules/auth/tokens.js';

describe('password hashing', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('wrong password!!', hash)).toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    const a = await hashPassword('same-password-123');
    const b = await hashPassword('same-password-123');
    expect(a).not.toEqual(b);
    expect(await verifyPassword('same-password-123', a)).toBe(true);
    expect(await verifyPassword('same-password-123', b)).toBe(true);
  });

  it('rejects passwords shorter than 8 chars', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
  });

  it('returns false for a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('whatever', 'not-a-valid-hash')).toBe(false);
  });
});

describe('opaque tokens', () => {
  it('hashToken is deterministic and generateToken is not', () => {
    const t = generateToken();
    expect(hashToken(t)).toEqual(hashToken(t));
    expect(generateToken()).not.toEqual(generateToken());
    // Raw token must not be recoverable from its hash.
    expect(hashToken(t)).not.toContain(t);
  });
});
