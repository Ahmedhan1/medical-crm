import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { principalOf, requireAuth } from '../plugins/auth.js';
import { createService, updateService, listServices } from '../../modules/billing/catalog.service.js';
import {
  createInvoice,
  updateDraftInvoice,
  issueInvoice,
  cancelDraftInvoice,
  voidInvoice,
  getInvoice,
  listInvoices,
  listPatientInvoices,
} from '../../modules/billing/invoices.service.js';
import { recordPayment, reversePayment } from '../../modules/billing/payments.service.js';
import { getFinancialSummary, getRevenueSeries } from '../../modules/billing/reports.service.js';

const IdParam = z.object({ id: z.string().uuid() });

/** Billing & Finance HTTP surface (Agent 2 — Finance). Auth on every route;
 * authorization + tenant scope enforced in the service layer. */
export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const idOf = (req: { params: unknown }): string => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    return parsed.data.id;
  };

  // --- Billable-service catalog ---
  app.post('/billing/services', async (req, reply) =>
    reply.code(201).send(await createService(principalOf(req), req.body)),
  );
  app.patch('/billing/services/:id', async (req, reply) =>
    reply.send(await updateService(principalOf(req), idOf(req), req.body)),
  );
  app.get('/billing/services', async (req, reply) =>
    reply.send({ services: await listServices(principalOf(req), req.query) }),
  );

  // --- Invoices ---
  app.post('/invoices', async (req, reply) =>
    reply.code(201).send(await createInvoice(principalOf(req), req.body)),
  );
  app.get('/invoices', async (req, reply) =>
    reply.send(await listInvoices(principalOf(req), req.query)),
  );
  app.get('/invoices/:id', async (req, reply) =>
    reply.send(await getInvoice(principalOf(req), idOf(req))),
  );
  app.patch('/invoices/:id', async (req, reply) =>
    reply.send(await updateDraftInvoice(principalOf(req), idOf(req), req.body)),
  );
  app.post('/invoices/:id/issue', async (req, reply) =>
    reply.send(await issueInvoice(principalOf(req), idOf(req))),
  );
  app.post('/invoices/:id/cancel', async (req, reply) =>
    reply.send(await cancelDraftInvoice(principalOf(req), idOf(req))),
  );
  app.post('/invoices/:id/void', async (req, reply) =>
    reply.send(await voidInvoice(principalOf(req), idOf(req), req.body)),
  );

  // --- Payments ---
  app.post('/invoices/:id/payments', async (req, reply) =>
    reply.code(201).send(await recordPayment(principalOf(req), idOf(req), req.body)),
  );
  app.post('/payments/:id/reverse', async (req, reply) =>
    reply.send(await reversePayment(principalOf(req), idOf(req), req.body)),
  );

  // --- Patient billing history ---
  app.get('/patients/:id/invoices', async (req, reply) =>
    reply.send({ invoices: await listPatientInvoices(principalOf(req), idOf(req)) }),
  );

  // --- Reports ---
  app.get('/billing/reports/summary', async (req, reply) =>
    reply.send(await getFinancialSummary(principalOf(req), req.query)),
  );
  app.get('/billing/reports/revenue', async (req, reply) =>
    reply.send(await getRevenueSeries(principalOf(req), req.query)),
  );
}
