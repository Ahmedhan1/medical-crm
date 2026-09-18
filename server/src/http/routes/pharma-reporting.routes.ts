import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import * as reporting from '../../modules/pharma/reporting/report.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

/**
 * Governed pharma reporting/export routes (Agent 4).
 *
 * Thin adapters only: authorization, territory scope, row caps, the column
 * allow-list and the audit receipt all live in the service, so a new route
 * cannot skip them.
 */
const KeyParam = z.object({ key: z.string().trim().min(2).max(60) });

function params<T extends z.ZodTypeAny>(schema: T, raw: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(message, parsed.error.flatten());
  return parsed.data;
}

export async function pharmaReportingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** The catalogue of reports this platform will produce, and their governance. */
  app.get('/pharma/reports', async (req, reply) => {
    return reply.send({ reports: reporting.listReports(principalOf(req)) });
  });

  /** Who exported what — the append-only receipt trail. */
  app.get('/pharma/reports/export-log', async (req, reply) => {
    const query = params(
      z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
      req.query,
      'Invalid query',
    );
    return reply.send({ exports: await reporting.listExportLog(principalOf(req), query.limit) });
  });

  /**
   * Run a registered report. POST rather than GET because it writes an audit
   * receipt and takes a filter body — an export is an action, not a lookup.
   */
  app.post('/pharma/reports/:key', async (req, reply) => {
    const { key } = params(KeyParam, req.params, 'Invalid report key');
    const result = await reporting.runReport(principalOf(req), key, req.body ?? {});
    if (result.format === 'csv') {
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${result.reportKey}.csv"`)
        .send(result.csv);
    }
    return reply.send(result);
  });
}
