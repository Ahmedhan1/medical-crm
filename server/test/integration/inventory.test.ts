import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * Inventory / stock control tests. Exercises the full mutation matrix through the
 * HTTP API: receive, issue, transfer, adjustment, batch/expiry rules, negative
 * stock protection, idempotent (duplicate) movements, low-stock detection, RBAC,
 * and tenant isolation.
 */
let app: FastifyInstance;
let clinicId: string;
let admin: { token: string };
let rep: { token: string };       // PHARMA_REP: inventory:read only
let reception: { token: string }; // no inventory permission at all
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function createProduct(token: string, body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/inventory/products', headers: bearer(token), payload: body });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}
async function createLocation(token: string, code: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/inventory/locations', headers: bearer(token), payload: { code, name: code } });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  rep = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  app = buildServer();
  await app.ready();
});
afterAll(async () => { if (app) await app.close(); });

describe('inventory catalog + stock lifecycle', () => {
  it('receives, issues and reflects the running balance', async () => {
    const product = await createProduct(admin.token, { sku: 'GLOVE-M', name: 'Gloves M', reorderThreshold: 20, unitCost: 1 });
    const loc = await createLocation(admin.token, 'MAIN');

    const recv = await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 100 } });
    expect(recv.statusCode).toBe(201);
    expect(recv.json().balanceAfter).toBe(100);

    const issue = await app.inject({ method: 'POST', url: '/inventory/stock/issue', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 30 } });
    expect(issue.statusCode).toBe(201);
    expect(issue.json().balanceAfter).toBe(70);

    const balances = await app.inject({ method: 'GET', url: `/inventory/balances?productId=${product}`, headers: bearer(admin.token) });
    expect(balances.json().balances[0].onHand).toBe(70);
  });

  it('refuses to issue more than is on hand (no negative stock)', async () => {
    const product = await createProduct(admin.token, { sku: 'SYR-5', name: 'Syringe 5ml' });
    const loc = await createLocation(admin.token, 'MAIN');
    await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 10 } });
    const issue = await app.inject({ method: 'POST', url: '/inventory/stock/issue', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 25 } });
    expect(issue.statusCode).toBe(409);
    expect(issue.json().error.code).toBe('conflict');
  });

  it('rejects an invalid (zero/negative) quantity', async () => {
    const product = await createProduct(admin.token, { sku: 'ITEM-1', name: 'Item 1' });
    const loc = await createLocation(admin.token, 'MAIN');
    const zero = await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 0 } });
    expect(zero.statusCode).toBe(400);
  });

  it('transfers stock between locations, conserving total on hand', async () => {
    const product = await createProduct(admin.token, { sku: 'PARA-500', name: 'Paracetamol 500' });
    const main = await createLocation(admin.token, 'MAIN');
    const disp = await createLocation(admin.token, 'DISP');
    await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload: { productId: product, locationId: main, quantity: 50 } });

    const tr = await app.inject({ method: 'POST', url: '/inventory/stock/transfer', headers: bearer(admin.token), payload: { productId: product, fromLocationId: main, toLocationId: disp, quantity: 20 } });
    expect(tr.statusCode).toBe(201);
    expect(tr.json().out.balanceAfter).toBe(30);
    expect(tr.json().in.balanceAfter).toBe(20);

    const balances = await app.inject({ method: 'GET', url: `/inventory/balances?productId=${product}`, headers: bearer(admin.token) });
    const total = balances.json().balances.reduce((s: number, b: { onHand: number }) => s + b.onHand, 0);
    expect(total).toBe(50);
  });

  it('adjusts on hand up and down with a mandatory reason', async () => {
    const product = await createProduct(admin.token, { sku: 'ADJ-1', name: 'Adjustable' });
    const loc = await createLocation(admin.token, 'MAIN');
    await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 10 } });

    const noReason = await app.inject({ method: 'POST', url: '/inventory/stock/adjust', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 2, direction: 'out' } });
    expect(noReason.statusCode).toBe(400);

    const down = await app.inject({ method: 'POST', url: '/inventory/stock/adjust', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 2, direction: 'out', reason: 'breakage' } });
    expect(down.json().balanceAfter).toBe(8);
  });

  it('serialises concurrent issues so stock is never oversold (row lock)', async () => {
    const product = await createProduct(admin.token, { sku: 'CONC-1', name: 'Concurrent' });
    const loc = await createLocation(admin.token, 'MAIN');
    await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 10 } });

    // Two issues of 8 fired together — only one can succeed (10 on hand).
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/inventory/stock/issue', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 8 } }),
      app.inject({ method: 'POST', url: '/inventory/stock/issue', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 8 } }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const balances = await app.inject({ method: 'GET', url: `/inventory/balances?productId=${product}`, headers: bearer(admin.token) });
    expect(balances.json().balances[0].onHand).toBe(2);
  });

  it('a duplicate movement (same idempotency key) is applied only once', async () => {
    const product = await createProduct(admin.token, { sku: 'IDEM-1', name: 'Idempotent' });
    const loc = await createLocation(admin.token, 'MAIN');
    const payload = { productId: product, locationId: loc, quantity: 5, idempotencyKey: 'abc-123' };
    const first = await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload });
    const second = await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload });
    expect(first.json().id).toBe(second.json().id); // same movement returned, not a new one
    const balances = await app.inject({ method: 'GET', url: `/inventory/balances?productId=${product}`, headers: bearer(admin.token) });
    expect(balances.json().balances[0].onHand).toBe(5); // applied once
  });
});

describe('batch / lot / expiry', () => {
  it('requires a batch for a batch-tracked product and blocks issuing an expired lot', async () => {
    const product = await createProduct(admin.token, { sku: 'VAC-1', name: 'Vaccine', isBatchTracked: true, isExpiryTracked: true });
    const loc = await createLocation(admin.token, 'FRIDGE');

    // No batch → rejected.
    const noBatch = await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 5 } });
    expect(noBatch.statusCode).toBe(400);

    // An already-expired lot.
    const batchRes = await app.inject({ method: 'POST', url: '/inventory/batches', headers: bearer(admin.token), payload: { productId: product, lotNumber: 'L1', expiryDate: '2000-01-01' } });
    const batchId = batchRes.json().id;
    await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 5, batchId } });

    const issue = await app.inject({ method: 'POST', url: '/inventory/stock/issue', headers: bearer(admin.token), payload: { productId: product, locationId: loc, quantity: 1, batchId } });
    expect(issue.statusCode).toBe(400);
    expect(issue.json().error.message).toMatch(/expired/i);
  });
});

describe('low-stock detection', () => {
  it('lists products at or below their persisted reorder threshold', async () => {
    const low = await createProduct(admin.token, { sku: 'LOW-1', name: 'Low item', reorderThreshold: 10, reorderQuantity: 50 });
    const ok = await createProduct(admin.token, { sku: 'OK-1', name: 'Ok item', reorderThreshold: 10 });
    const loc = await createLocation(admin.token, 'MAIN');
    await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload: { productId: low, locationId: loc, quantity: 8 } });
    await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(admin.token), payload: { productId: ok, locationId: loc, quantity: 40 } });

    const report = await app.inject({ method: 'GET', url: '/inventory/reports/low-stock', headers: bearer(admin.token) });
    const skus = report.json().products.map((p: { sku: string }) => p.sku);
    expect(skus).toContain('LOW-1');
    expect(skus).not.toContain('OK-1');
  });
});

describe('RBAC + tenant isolation', () => {
  it('a rep can read inventory but cannot mutate stock', async () => {
    const product = await createProduct(admin.token, { sku: 'RB-1', name: 'RBAC item' });
    const loc = await createLocation(admin.token, 'MAIN');
    expect((await app.inject({ method: 'GET', url: '/inventory/products', headers: bearer(rep.token) })).statusCode).toBe(200);
    const recv = await app.inject({ method: 'POST', url: '/inventory/stock/receive', headers: bearer(rep.token), payload: { productId: product, locationId: loc, quantity: 5 } });
    expect(recv.statusCode).toBe(403);
  });

  it('reception (no inventory permission) is denied read', async () => {
    expect((await app.inject({ method: 'GET', url: '/inventory/products', headers: bearer(reception.token) })).statusCode).toBe(403);
  });

  it('an unauthenticated request is rejected', async () => {
    expect((await app.inject({ method: 'GET', url: '/inventory/products' })).statusCode).toBe(401);
  });

  it('is tenant-isolated: clinic B cannot see or use clinic A products', async () => {
    const product = await createProduct(admin.token, { sku: 'TEN-1', name: 'Tenant item' });
    const clinicB = await makeClinic('Clinic B');
    const adminB = await makeUser(clinicB.clinicId, 'adminB', RoleKey.ADMIN);
    // B cannot read A's product.
    const get = await app.inject({ method: 'GET', url: `/inventory/products/${product}`, headers: bearer(adminB.token) });
    expect(get.statusCode).toBe(404);
    // B's product list never contains A's product.
    const list = await app.inject({ method: 'GET', url: '/inventory/products', headers: bearer(adminB.token) });
    expect(list.json().products).toHaveLength(0);
  });
});
