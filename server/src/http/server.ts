import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { isAppError } from '../domain/errors.js';
import { getPool } from '../db/pool.js';
import { audit } from '../modules/governance/audit.js';
import { foundationFeature } from './features/foundation.feature.js';
import { clinicalFeature } from './features/clinical.feature.js';
import { automationFeature } from './features/automation.feature.js';
import { pharmaFeature } from './features/pharma.feature.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
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
