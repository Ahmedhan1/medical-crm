import { describe, expect, it } from 'vitest';
import { LoginThrottle, accountKey } from '../../src/modules/auth/throttle.js';
import { errorLogSerializer } from '../../src/http/server.js';
import { TooManyRequestsError } from '../../src/domain/errors.js';

const CFG = { maxAttempts: 3, windowSeconds: 900, lockoutSeconds: 600, ipMaxPerMinute: 5 };

describe('LoginThrottle — account lockout', () => {
  it('locks after maxAttempts failures and stays locked within the window', () => {
    let now = 1_000_000;
    const t = new LoginThrottle(CFG, () => now);
    const k = accountKey('clinic', 'User@X'); // case-insensitive key
    expect(accountKey('clinic', 'user@x')).toBe(k);

    for (let i = 0; i < 3; i++) {
      expect(() => t.assertAccountNotLocked(k)).not.toThrow();
      t.recordFailure(k);
    }
    expect(() => t.assertAccountNotLocked(k)).toThrow(TooManyRequestsError);

    now += 599_000; // still within lockout (600s)
    expect(() => t.assertAccountNotLocked(k)).toThrow(TooManyRequestsError);
    now += 2_000; // past lockout
    expect(() => t.assertAccountNotLocked(k)).not.toThrow();
  });

  it('a successful login clears failure state', () => {
    const t = new LoginThrottle(CFG, () => 5000);
    const k = accountKey('c', 'u');
    t.recordFailure(k);
    t.recordFailure(k);
    t.recordSuccess(k);
    t.recordFailure(k); // count restarts
    expect(() => t.assertAccountNotLocked(k)).not.toThrow();
  });

  it('failures older than the window do not accumulate into a lockout', () => {
    let now = 0;
    const t = new LoginThrottle(CFG, () => now);
    const k = accountKey('c', 'u');
    t.recordFailure(k);
    now += 901_000; // window elapsed
    t.recordFailure(k);
    t.recordFailure(k); // only 2 in the current window
    expect(() => t.assertAccountNotLocked(k)).not.toThrow();
  });
});

describe('LoginThrottle — per-IP rate limit', () => {
  it('caps attempts per IP per minute and resets after the minute', () => {
    let now = 0;
    const t = new LoginThrottle(CFG, () => now);
    for (let i = 0; i < 5; i++) t.assertIpUnderLimit('1.2.3.4');
    expect(() => t.assertIpUnderLimit('1.2.3.4')).toThrow(TooManyRequestsError);
    now += 61_000;
    expect(() => t.assertIpUnderLimit('1.2.3.4')).not.toThrow();
  });

  it('a missing IP is never rate limited (service-level calls)', () => {
    const t = new LoginThrottle(CFG, () => 0);
    for (let i = 0; i < 100; i++) expect(() => t.assertIpUnderLimit(undefined)).not.toThrow();
  });
});

describe('errorLogSerializer — never logs PHI-bearing pg fields (F-06)', () => {
  it('keeps type/code/message/stack but drops pg detail/where/parameters', () => {
    const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "uq_x"'), {
      name: 'error',
      code: '23505',
      detail: 'Key (national_id)=(29001011234567) already exists.', // PHI!
      where: 'SQL statement ...',
      table: 'patient',
      parameters: ['29001011234567'],
    });
    const out = errorLogSerializer(pgErr as never);
    const json = JSON.stringify(out);
    expect(out.code).toBe('23505');
    expect(out.type).toBe('error');
    expect(json).not.toContain('29001011234567'); // the value never appears
    expect(json).not.toContain('detail');
    expect(json).not.toContain('parameters');
    expect(json).not.toContain('national_id)=');
  });

  it('truncates an over-long message', () => {
    const out = errorLogSerializer(new Error('x'.repeat(1000)) as never);
    expect(out.message.length).toBeLessThanOrEqual(300);
  });
});
