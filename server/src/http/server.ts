import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { isAppError } from '../domain/errors.js';
import { getPool } from '../db/pool.js';
import { audit } from '../modules/governance/audit.js';
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

// Shared pino config: strip query strings via the serializer and remove
// credential-bearing headers outright (defense in depth).
const LOGGER_CONFIG = {
  serializers: { req: requestLogSerializer },
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

  // Liveness/readiness for the observability dashboard (§38).
  app.get('/health', async (_req, reply) => {
    try {
      await getPool().query('SELECT 1');
      return reply.send({ status: 'ok', db: 'up', time: new Date().toISOString() });
    } catch {
      return reply.code(503).send({ status: 'degraded', db: 'down' });
    }
  });

  // Workstream feature aggregators. This list is STABLE (Agent 1 owned):
  // each agent adds their routes inside their own feature module, never here.
  app.register(foundationFeature); // Agent 1
  app.register(clinicalFeature); // Agent 2
  app.register(automationFeature); // Agent 3
  app.register(pharmaFeature); // Agent 4

  return app;
}
