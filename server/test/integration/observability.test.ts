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
});
