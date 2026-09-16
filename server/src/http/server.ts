import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { isAppError } from '../domain/errors.js';
import { getPool } from '../db/pool.js';
import { audit } from '../modules/governance/audit.js';
import { TooManyRequestsError } from '../domain/errors.js';
import { recordRequest, metricsSnapshot } from './metrics.js';
import { listBackups } from '../modules/backup/backup.service.js';
import { foundationFeature } from './features/foundation.feature.js';
import { clinicalFeature } from './features/clinical.feature.js';
import { automationFeature } from './features/automation.feature.js';
import { pharmaFeature } from './features/pharma.feature.js';

/**
 * Request-log serializer (CCR-002, governance rule 9: never put PHI in logs).
 *
 * Fastify's default request log records the full URL including the query string,
 * so `GET /patients/search?q=Ahmed` — or any future endpoint whose query carries
 * a name, phone, MRN or other identifier — would write PHI into application logs.
 * We log the method, the PATH ONLY (query string stripped), and the hostname.
 * This is a single cross-cutting control so no individual route can re-create the
 * leak. Path params (e.g. an opaque patient UUID) are retained: they are not PHI
 * and are needed to correlate requests.
 */
export function requestLogSerializer(req: FastifyRequest): {
  method: string;
  url: string;
  hostname: string;
} {
  const rawUrl = req.url ?? '';
  const qIndex = rawUrl.indexOf('?');
  const path = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  return { method: req.method, url: path, hostname: req.hostname };
}

/**
 * Error-log serializer (Task 2, finding F-06). Postgres attaches value-bearing
 * fields to its errors — `detail` ("Key (national_id)=(123)…"), `where`,
 * `internalQuery`, `parameters` — which can contain PHI. Pino's default error
 * serializer would log all enumerable props. We log ONLY a controlled, PHI-safe
 * shape: type, SQLSTATE code, a truncated message, HTTP status, and the stack
 * (code paths, not data). Value-bearing pg fields are never included.
 */
export function errorLogSerializer(
  err: Error & { code?: unknown; statusCode?: unknown },
): { type: string; message: string; stack: string; code?: string; statusCode?: number } {
  return {
    type: err?.name ?? 'Error',
    message: typeof err?.message === 'string' ? err.message.slice(0, 300) : '',
    stack: typeof err?.stack === 'string' ? err.stack : '',
    code: typeof err?.code === 'string' ? err.code : undefined,
    statusCode: typeof err?.statusCode === 'number' ? err.statusCode : undefined,
  };
}

// Shared pino config: strip query strings, sanitise errors (no pg detail/PHI),
// and remove credential-bearing headers outright (defense in depth).
const LOGGER_CONFIG = {
  serializers: { req: requestLogSerializer, err: errorLogSerializer },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
    remove: true,
  },
};

export interface BuildServerOptions {
  /**
   * Test hook: capture logs through this stream using the PRODUCTION serializer,
   * so a regression test exercises the real logger config rather than a stand-in.
   */
  loggerStream?: NodeJS.WritableStream;
}

export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const logger: FastifyServerOptions['logger'] = opts.loggerStream
    ? { level: 'info', stream: opts.loggerStream, ...LOGGER_CONFIG }
    : process.env.NODE_ENV !== 'test'
      ? LOGGER_CONFIG
      : false;

  const app = Fastify({
    logger,
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  // Consistent, non-leaky error envelope for the whole API.
  app.setErrorHandler(async (err, req, reply) => {
    if (isAppError(err)) {
      if (err.status >= 500) req.log.error({ err }, 'app error');
      // Record denied access attempts by an authenticated user (§34 forensics).
      // Awaited so the audit trail is durable before the 403 is returned.
      if (err.status === 403 && req.principal) {
        try {
          await audit({
            clinicId: req.principal.clinicId,
            actorId: req.principal.userId,
            action: 'access.denied',
            outcome: 'denied',
            metadata: { method: req.method, route: req.url },
            ip: req.ip,
          });
        } catch (auditErr) {
          req.log.error({ auditErr }, 'failed to write denied-access audit');
        }
      }
      if (err instanceof TooManyRequestsError) {
        reply.header('Retry-After', String(err.retryAfterSeconds));
      }
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message, details: err.details ?? undefined },
      });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: 'Invalid request', details: err.flatten() },
      });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: (err as Error).message },
      });
    }
    req.log.error({ err }, 'unhandled error');
    // Never leak internals to the client.
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'An unexpected error occurred' },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  // PHI-safe request metrics: count by method + route TEMPLATE + status class.
  app.addHook('onResponse', async (req, reply) => {
    recordRequest(req.method, req.routeOptions?.url, reply.statusCode);
  });

  // Liveness: is the process up? (No dependencies — never 503s on DB.)
  app.get('/health', async (_req, reply) => {
    try {
      await getPool().query('SELECT 1');
      return reply.send({ status: 'ok', db: 'up', time: new Date().toISOString() });
    } catch {
      return reply.code(503).send({ status: 'degraded', db: 'down' });
    }
  });

  // Readiness / observability (Phase 1 + §38). PHI-free operational metadata
  // only: DB reachability + latency, applied-migration count, process uptime.
  // An administrator can tell whether the box is healthy without support.
  app.get('/health/detailed', async (_req, reply) => {
    const startedAt = process.hrtime.bigint();
    let db: { status: 'up' | 'down'; latencyMs?: number; migrationsApplied?: number } = {
      status: 'down',
    };
    try {
      const res = await getPool().query<{ n: string }>(
        'SELECT count(*)::text AS n FROM schema_migrations',
      );
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      db = {
        status: 'up',
        latencyMs: Math.round(latencyMs * 100) / 100,
        migrationsApplied: Number(res.rows[0]?.n ?? 0),
      };
    } catch {
      db = { status: 'down' };
    }
    // Connection-pool saturation is a leading indicator of trouble.
    const pool = getPool();
    const poolStats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };

    // Last backup (operational readiness for recovery). Metadata only, no PHI.
    let backup: { lastStatus?: string; lastAt?: string | null } = {};
    try {
      const [last] = await listBackups(1);
      if (last) backup = { lastStatus: last.status, lastAt: last.finishedAt ?? last.startedAt };
    } catch {
      /* backup ledger unavailable — omit rather than fail readiness */
    }

    const ready = db.status === 'up';
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      checks: { database: db, pool: poolStats, backup },
    });
  });

  // PHI-safe operational metrics (bounded-cardinality counters only).
  app.get('/metrics', async (_req, reply) => {
    return reply.send(metricsSnapshot());
  });

  // Workstream feature aggregators. This list is STABLE (Agent 1 owned):
  // each agent adds their routes inside their own feature module, never here.
  app.register(foundationFeature); // Agent 1
  app.register(clinicalFeature); // Agent 2
  app.register(automationFeature); // Agent 3
  app.register(pharmaFeature); // Agent 4

  return app;
}
