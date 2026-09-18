import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { principalOf, requireAuth } from '../plugins/auth.js';
import * as catalog from '../../modules/inventory/catalog.service.js';
import * as stock from '../../modules/inventory/stock.service.js';
import * as reporting from '../../modules/inventory/reporting.service.js';

/** Inventory / stock control routes (Agent 3). Authorization + tenant scope are
 * enforced in the services; routes only authenticate + validate shape. */
const IdParam = z.object({ id: z.string().uuid() });
const MovementType = z.enum(['RECEIVE', 'ISSUE', 'TRANSFER', 'ADJUSTMENT', 'RETURN']);

const StockOp = z.object({
  productId: z.string().uuid(),
  locationId: z.string().uuid(),
  batchId: z.string().uuid().nullish(),
  quantity: z.number().positive(),
  reason: z.string().trim().max(500).nullish(),
  reference: z.string().trim().max(200).nullish(),
  idempotencyKey: z.string().trim().min(1).max(200).nullish(),
});

function params<T extends z.ZodTypeAny>(schema: T, raw: unknown, message: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(message, parsed.error.flatten());
  return parsed.data;
}

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // -- Locations -------------------------------------------------------------
  app.post('/inventory/locations', async (req, reply) => {
    const body = params(z.object({ code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(200), kind: z.enum(['store', 'dispensary', 'room', 'cold_chain', 'other']).optional() }), req.body, 'Invalid location');
    return reply.code(201).send(await catalog.createLocation(principalOf(req), body));
  });
  app.patch('/inventory/locations/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const body = params(z.object({ name: z.string().trim().min(1).max(200).optional(), kind: z.enum(['store', 'dispensary', 'room', 'cold_chain', 'other']).optional(), isActive: z.boolean().optional() }), req.body, 'Invalid update');
    return reply.send(await catalog.updateLocation(principalOf(req), id, body));
  });
  app.get('/inventory/locations', async (req, reply) => {
    const q = params(z.object({ includeInactive: z.coerce.boolean().optional() }), req.query, 'Invalid query');
    return reply.send({ locations: await catalog.listLocations(principalOf(req), q.includeInactive) });
  });
  app.get('/inventory/locations/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send(await catalog.getLocation(principalOf(req), id));
  });

  // -- Products --------------------------------------------------------------
  const ProductBody = z.object({
    sku: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(200),
    category: z.string().trim().max(100).nullish(),
    unitOfMeasure: z.string().trim().min(1).max(20).optional(),
    medicationProductId: z.string().uuid().nullish(),
    isBatchTracked: z.boolean().optional(),
    isExpiryTracked: z.boolean().optional(),
    blockExpiredIssue: z.boolean().optional(),
    allowNegativeStock: z.boolean().optional(),
    reorderThreshold: z.number().min(0).nullish(),
    reorderQuantity: z.number().positive().nullish(),
    isBillable: z.boolean().optional(),
    billingCode: z.string().trim().max(60).nullish(),
    unitPrice: z.number().min(0).nullish(),
    unitCost: z.number().min(0).nullish(),
  });

  app.post('/inventory/products', async (req, reply) => {
    const body = params(ProductBody, req.body, 'Invalid product');
    return reply.code(201).send(await catalog.createProduct(principalOf(req), body));
  });
  app.patch('/inventory/products/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const body = params(ProductBody.partial().extend({ isActive: z.boolean().optional() }).omit({ sku: true }), req.body, 'Invalid update');
    return reply.send(await catalog.updateProduct(principalOf(req), id, body));
  });
  app.get('/inventory/products', async (req, reply) => {
    const q = params(z.object({
      q: z.string().trim().max(120).optional(),
      category: z.string().trim().max(100).optional(),
      includeInactive: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }), req.query, 'Invalid search');
    return reply.send({ products: await catalog.searchProducts(principalOf(req), q) });
  });
  app.get('/inventory/products/:id', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    const p = principalOf(req);
    const [product, balances, batches] = await Promise.all([
      catalog.getProduct(p, id),
      reporting.listBalances(p, { productId: id }),
      catalog.listBatches(p, id),
    ]);
    return reply.send({ product, balances, batches });
  });
  app.get('/inventory/products/:id/batches', async (req, reply) => {
    const { id } = params(IdParam, req.params, 'Invalid id');
    return reply.send({ batches: await catalog.listBatches(principalOf(req), id) });
  });

  // -- Batches ---------------------------------------------------------------
  app.post('/inventory/batches', async (req, reply) => {
    const body = params(z.object({ productId: z.string().uuid(), lotNumber: z.string().trim().min(1).max(100), expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }), req.body, 'Invalid batch');
    return reply.code(201).send(await catalog.createBatch(principalOf(req), body));
  });

  // -- Stock movements -------------------------------------------------------
  app.post('/inventory/stock/receive', async (req, reply) => {
    const body = params(StockOp, req.body, 'Invalid receive');
    return reply.code(201).send(await stock.receiveStock(principalOf(req), body));
  });
  app.post('/inventory/stock/issue', async (req, reply) => {
    const body = params(StockOp, req.body, 'Invalid issue');
    return reply.code(201).send(await stock.issueStock(principalOf(req), body));
  });
  app.post('/inventory/stock/return', async (req, reply) => {
    const body = params(StockOp, req.body, 'Invalid return');
    return reply.code(201).send(await stock.returnStock(principalOf(req), body));
  });
  app.post('/inventory/stock/adjust', async (req, reply) => {
    const body = params(StockOp.extend({ direction: z.enum(['in', 'out']), reason: z.string().trim().min(1).max(500) }), req.body, 'Invalid adjustment');
    return reply.code(201).send(await stock.adjustStock(principalOf(req), body));
  });
  app.post('/inventory/stock/transfer', async (req, reply) => {
    const body = params(StockOp.omit({ locationId: true }).extend({ fromLocationId: z.string().uuid(), toLocationId: z.string().uuid() }), req.body, 'Invalid transfer');
    return reply.code(201).send(await stock.transferStock(principalOf(req), body));
  });

  // -- Reporting -------------------------------------------------------------
  app.get('/inventory/balances', async (req, reply) => {
    const q = params(z.object({ productId: z.string().uuid().optional(), locationId: z.string().uuid().optional(), onlyPositive: z.coerce.boolean().optional() }), req.query, 'Invalid query');
    return reply.send({ balances: await reporting.listBalances(principalOf(req), q) });
  });
  app.get('/inventory/movements', async (req, reply) => {
    const q = params(z.object({
      productId: z.string().uuid().optional(),
      locationId: z.string().uuid().optional(),
      batchId: z.string().uuid().optional(),
      movementType: MovementType.optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }), req.query, 'Invalid query');
    return reply.send({ movements: await reporting.listMovements(principalOf(req), q) });
  });
  app.get('/inventory/reports/low-stock', async (req, reply) => {
    return reply.send({ products: await reporting.lowStock(principalOf(req)) });
  });
  app.get('/inventory/reports/valuation', async (req, reply) => {
    return reply.send(await reporting.valuation(principalOf(req)));
  });
}
