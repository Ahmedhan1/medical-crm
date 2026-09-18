import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, SECURITY_HEADERS } from '../../src/http/server.js';

/**
 * Baseline security headers (Phase 0 platform hardening). Every response — a
 * success, a 404, an auth failure — must carry the static hardening headers, so
 * no individual route can forget them. They are PHI-free and add no dependency.
 */
let app: FastifyInstance;

afterEach(async () => {
  if (app) await app.close();
});

const EXPECTED = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-dns-prefetch-control': 'off',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
};

describe('security headers', () => {
  it('exports a frozen, static header set (no per-request data)', () => {
    expect(Object.isFrozen(SECURITY_HEADERS)).toBe(true);
    expect(SECURITY_HEADERS).toEqual(EXPECTED);
  });

  it('sets every header on a successful response', async () => {
    app = buildServer();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/health' });
    for (const [k, v] of Object.entries(EXPECTED)) {
      expect(res.headers[k], `header ${k}`).toBe(v);
    }
  });

  it('sets every header on a 404 and on an auth-failure response', async () => {
    app = buildServer();
    await app.ready();
    for (const url of ['/no-such-route', '/auth/me']) {
      const res = await app.inject({ method: 'GET', url });
      for (const [k, v] of Object.entries(EXPECTED)) {
        expect(res.headers[k], `${url} header ${k}`).toBe(v);
      }
    }
  });

  it('uses the most restrictive CSP (API serves JSON/PDF, never scripted HTML)', async () => {
    app = buildServer();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
    // No `unsafe-inline`, no wildcard sources.
    expect(String(res.headers['content-security-policy'])).not.toMatch(/unsafe-|\*/);
  });
});
