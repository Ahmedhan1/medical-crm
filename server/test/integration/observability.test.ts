import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

describe('observability (Phase 1)', () => {
  it('GET /health is a dependency-light liveness probe', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('GET /health/detailed reports DB readiness + migration count, no PHI', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/detailed' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('up');
    expect(typeof body.checks.database.latencyMs).toBe('number');
    // Migrations have been applied by the test setup.
    expect(body.checks.database.migrationsApplied).toBeGreaterThan(0);
    expect(typeof body.uptimeSeconds).toBe('number');
    // No auth was provided and none is required for an ops probe; and the body
    // must carry only operational metadata (no obvious PHI-shaped fields).
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/patient|mrn|phone|diagnosis/i);
  });

  it('does not require authentication (ops probes must work headless)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/detailed' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /health/detailed includes pool + backup readiness (Task 4)', async () => {
    const body = (await app.inject({ method: 'GET', url: '/health/detailed' })).json();
    expect(body.checks.pool).toBeDefined();
    expect(typeof body.checks.pool.total).toBe('number');
    expect(typeof body.checks.pool.idle).toBe('number');
    expect(typeof body.checks.pool.waiting).toBe('number');
    expect(body.checks.backup).toBeDefined(); // present (possibly empty), never throws
  });

  it('GET /metrics exposes bounded-cardinality counters with no PHI', async () => {
    // Generate a couple of requests so counters are non-empty.
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/does-not-exist' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.errorsTotal).toBe('number');
    const keys = Object.keys(body.requestsTotal);
    expect(keys.length).toBeGreaterThan(0);
    // Every label key is "METHOD /route/template Nxx" — bounded, no ids/PHI.
    for (const k of keys) {
      expect(k).toMatch(/^[A-Z]+ \S+ [1-5]xx$/);
      expect(k).not.toMatch(/patient|mrn|phone|diagnosis|\d{6,}/i);
    }
    // The 404 was bucketed as 'unmatched', not stored as a concrete path.
    expect(keys.some((k) => k.includes('/does-not-exist'))).toBe(false);
  });
});
