import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  generateEncounterReport,
  generatePatientReport,
  type RenderedReport,
} from '../../modules/clinical/report/report.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });

/**
 * Clinical reports (Agent 2 / C006).
 *
 * The URL and the download filename carry identifiers only. A patient name in
 * either would leak PHI into request logs, browser history and a downloads
 * folder, so neither ever contains one.
 */
export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const send = (reply: FastifyReply, report: RenderedReport) =>
    reply
      .header('content-type', report.contentType)
      .header('content-disposition', `attachment; filename="${report.filename}"`)
      .send(report.body);

  /** Report generation is stamped to the minute, in UTC, for reproducibility. */
  const stamp = (): string =>
    `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  app.get('/reports/encounter/:id.pdf', async (req, reply) => {
    const parsed = IdParam.safeParse({ id: (req.params as { id?: string }).id });
    if (!parsed.success) throw new ValidationError('Invalid encounter id');
    const report = await generateEncounterReport(
      principalOf(req),
      parsed.data.id,
      stamp(),
    );
    return send(reply, report);
  });

  app.get('/reports/patient/:id.pdf', async (req, reply) => {
    const parsed = IdParam.safeParse({ id: (req.params as { id?: string }).id });
    if (!parsed.success) throw new ValidationError('Invalid patient id');
    const report = await generatePatientReport(
      principalOf(req),
      parsed.data.id,
      stamp(),
    );
    return send(reply, report);
  });
}
