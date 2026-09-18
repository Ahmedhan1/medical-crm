import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';

/**
 * Request correlation id (§11 error contract, platform observability).
 *
 * Every response — success or error — must carry an opaque `x-request-id`, and
 * every error envelope must repeat it as `error.request_id`, so a clinician who
 * hits a failure can quote one id and support can find the exact server log line.
 * The id must be unguessable (not the sequential default) and must never leak
 * internals or PHI (it is a random UUID).
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let app: FastifyInstance;

afterEach(async () => {
  if (app) await app.close();
});

describe('request correlation id', () => {
  it('sets an opaque UUID x-request-id header on a successful response', async () => {
    app = buildServer();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const id = res.headers['x-request-id'];
    expect(id).toBeDefined();
    expect(String(id)).toMatch(UUID_V4);
    // Not the sequential Fastify default ("req-1"), which would leak volume and
    // collide across instances.
    expect(String(id)).not.toMatch(/^req-\d+$/);
  });

  it('issues a distinct id per request', async () => {
    app = buildServer();
    await app.ready();

    const a = await app.inject({ method: 'GET', url: '/health' });
    const b = await app.inject({ method: 'GET', url: '/health' });
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('includes request_id in a 404 envelope, matching the header', async () => {
    app = buildServer();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.request_id).toBe(res.headers['x-request-id']);
    expect(String(body.error.request_id)).toMatch(UUID_V4);
  });

  it('includes request_id in an auth-failure envelope, matching the header', async () => {
    app = buildServer();
    await app.ready();

    // A protected route with no bearer token → the app error envelope.
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
    const body = res.json();
    expect(body.error).toBeDefined();
    expect(body.error.request_id).toBe(res.headers['x-request-id']);
  });

  it('logs the same id (reqId) that it returns, so a failure is traceable', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    app = buildServer({ loggerStream: stream });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const id = String(res.headers['x-request-id']);

    // The production logger emits the request with the same id under `reqId`,
    // giving support a grep target that the client can quote.
    const output = lines.join('');
    expect(output).toContain(id);
    expect(output).toMatch(/"reqId":"[0-9a-f-]{36}"/i);
  });
});
