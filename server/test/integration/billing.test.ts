import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;
let clinicId: string;
let admin: TestUser;
let reception: TestUser;
let doctor: TestUser;

const bearer = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

async function newPatient(user: TestUser = reception, name = 'Billing Patient'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/patients', headers: bearer(user), payload: { fullName: name, sex: 'female' } });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function draftInvoice(patientId: string, items: object[], user: TestUser = reception) {
  return app.inject({ method: 'POST', url: '/invoices', headers: bearer(user), payload: { patientId, items } });
}

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  doctor = await makeUser(clinicId, 'doctor', RoleKey.DOCTOR);
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

describe('Billing — invoice creation & totals', () => {
  it('creates a draft with catalog + ad-hoc lines and computes integer totals', async () => {
    const patientId = await newPatient();
    const svc = (
      await app.inject({ method: 'POST', url: '/billing/services', headers: bearer(admin), payload: { code: 'CONSULT', name: 'Consultation', unitPriceMinor: 20000, taxRateBp: 1400 } })
    ).json();

    const res = await draftInvoice(patientId, [
      { serviceId: svc.id, quantity: 2 }, // 2 × 200.00, 14% tax
      { description: 'Dressing', quantity: 1, unitPriceMinor: 5000, discountMinor: 1000 },
    ]);
    expect(res.statusCode).toBe(201);
    const inv = res.json();
    expect(inv.status).toBe('draft');
    expect(inv.invoiceNumber).toBeNull();
    // subtotal (gross) = 40000 + 5000 = 45000; discount = 1000; tax = floor(40000*0.14)=5600; total = 45000-1000+5600 = 49600
    expect(inv.subtotalMinor).toBe(45000);
    expect(inv.discountMinor).toBe(1000);
    expect(inv.taxMinor).toBe(5600);
    expect(inv.totalMinor).toBe(49600);
    expect(inv.balanceDueMinor).toBe(49600);
    expect(inv.items).toHaveLength(2);
  });

  it('rejects an invoice with no items and a negative amount', async () => {
    const patientId = await newPatient();
    expect((await draftInvoice(patientId, [])).statusCode).toBe(400);
    expect((await draftInvoice(patientId, [{ description: 'X', quantity: 1, unitPriceMinor: -5 }])).statusCode).toBe(400);
  });

  it('requires invoice:create — a doctor (read-only) cannot create', async () => {
    const patientId = await newPatient();
    expect((await draftInvoice(patientId, [{ description: 'X', quantity: 1, unitPriceMinor: 100 }], doctor)).statusCode).toBe(403);
  });

  it('refuses to bill a merged patient', async () => {
    const survivor = await newPatient(reception, 'Survivor');
    const dup = await newPatient(reception, 'Duplicate');
    await app.inject({ method: 'POST', url: `/patients/${survivor}/merge`, headers: bearer(admin), payload: { sourcePatientId: dup, reason: 'duplicate registration' } });
    const res = await draftInvoice(dup, [{ description: 'X', quantity: 1, unitPriceMinor: 100 }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.mergedIntoId).toBe(survivor);
  });
});

describe('Billing — invoice lifecycle', () => {
  async function issuedInvoice(totalItems = [{ description: 'Visit', quantity: 1, unitPriceMinor: 10000 }]) {
    const patientId = await newPatient();
    const inv = (await draftInvoice(patientId, totalItems)).json();
    const issued = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/issue`, headers: bearer(reception) });
    return { patientId, invoice: issued.json(), res: issued, draftId: inv.id };
  }

  it('issues a draft, assigning a sequential number', async () => {
    const a = await issuedInvoice();
    expect(a.res.statusCode).toBe(200);
    expect(a.invoice.status).toBe('issued');
    expect(a.invoice.invoiceNumber).toMatch(/^INV-\d{6}$/);
    expect(a.invoice.issuedAt).toBeTruthy();
    // Next issue increments per-clinic.
    const b = await issuedInvoice();
    expect(Number(b.invoice.invoiceNumber.slice(4))).toBe(Number(a.invoice.invoiceNumber.slice(4)) + 1);
  });

  it('cannot edit or re-issue an issued invoice; can edit a draft', async () => {
    const patientId = await newPatient();
    const inv = (await draftInvoice(patientId, [{ description: 'A', quantity: 1, unitPriceMinor: 10000 }])).json();
    // edit draft OK
    const edited = await app.inject({ method: 'PATCH', url: `/invoices/${inv.id}`, headers: bearer(reception), payload: { items: [{ description: 'B', quantity: 2, unitPriceMinor: 10000 }] } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().totalMinor).toBe(20000);
    await app.inject({ method: 'POST', url: `/invoices/${inv.id}/issue`, headers: bearer(reception) });
    // edit after issue rejected
    expect((await app.inject({ method: 'PATCH', url: `/invoices/${inv.id}`, headers: bearer(reception), payload: { items: [{ description: 'C', quantity: 1, unitPriceMinor: 100 }] } })).statusCode).toBe(409);
    // re-issue rejected
    expect((await app.inject({ method: 'POST', url: `/invoices/${inv.id}/issue`, headers: bearer(reception) })).statusCode).toBe(409);
  });

  it('cancels a draft but not an issued invoice', async () => {
    const patientId = await newPatient();
    const inv = (await draftInvoice(patientId, [{ description: 'A', quantity: 1, unitPriceMinor: 10000 }])).json();
    expect((await app.inject({ method: 'POST', url: `/invoices/${inv.id}/cancel`, headers: bearer(reception) })).json().status).toBe('cancelled');
    const a = await issuedInvoice();
    expect((await app.inject({ method: 'POST', url: `/invoices/${a.draftId}/cancel`, headers: bearer(reception) })).statusCode).toBe(409);
  });

  it('voids an unpaid issued invoice (admin, reason required); reception cannot', async () => {
    const a = await issuedInvoice();
    expect((await app.inject({ method: 'POST', url: `/invoices/${a.draftId}/void`, headers: bearer(reception), payload: { reason: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/invoices/${a.draftId}/void`, headers: bearer(admin), payload: {} })).statusCode).toBe(400); // no reason
    const voided = await app.inject({ method: 'POST', url: `/invoices/${a.draftId}/void`, headers: bearer(admin), payload: { reason: 'entered in error' } });
    expect(voided.json().status).toBe('void');
  });
});

describe('Billing — payments', () => {
  async function issued(amount = 10000) {
    const patientId = await newPatient();
    const inv = (await draftInvoice(patientId, [{ description: 'Visit', quantity: 1, unitPriceMinor: amount }])).json();
    await app.inject({ method: 'POST', url: `/invoices/${inv.id}/issue`, headers: bearer(reception) });
    return inv.id as string;
  }
  const pay = (id: string, body: object, user: TestUser = reception) =>
    app.inject({ method: 'POST', url: `/invoices/${id}/payments`, headers: bearer(user), payload: body });

  it('records a partial payment then settles to paid', async () => {
    const id = await issued(10000);
    const p1 = await pay(id, { amountMinor: 4000, method: 'cash' });
    expect(p1.statusCode).toBe(201);
    expect(p1.json().invoice.status).toBe('partially_paid');
    expect(p1.json().invoice.balanceDueMinor).toBe(6000);
    const p2 = await pay(id, { amountMinor: 6000, method: 'card' });
    expect(p2.json().invoice.status).toBe('paid');
    expect(p2.json().invoice.balanceDueMinor).toBe(0);
    expect(p2.json().invoice.paidAt).toBeTruthy();
    // Paying a settled invoice is refused.
    expect((await pay(id, { amountMinor: 1, method: 'cash' })).statusCode).toBe(409);
  });

  it('refuses overpayment, zero and negative amounts', async () => {
    const id = await issued(10000);
    expect((await pay(id, { amountMinor: 10001, method: 'cash' })).statusCode).toBe(400);
    expect((await pay(id, { amountMinor: 0, method: 'cash' })).statusCode).toBe(400);
    expect((await pay(id, { amountMinor: -100, method: 'cash' })).statusCode).toBe(400);
  });

  it('is idempotent on idempotencyKey (no double payment)', async () => {
    const id = await issued(10000);
    const key = 'idem-key-12345678';
    const a = await pay(id, { amountMinor: 4000, method: 'cash', idempotencyKey: key });
    const b = await pay(id, { amountMinor: 4000, method: 'cash', idempotencyKey: key });
    expect(a.json().payment.id).toBe(b.json().payment.id);
    const inv = (await app.inject({ method: 'GET', url: `/invoices/${id}`, headers: bearer(reception) })).json();
    expect(inv.amountPaidMinor).toBe(4000); // charged once
    expect(inv.payments).toHaveLength(1);
  });

  it('reverses a payment (admin), restoring the balance; reception cannot reverse', async () => {
    const id = await issued(10000);
    const p = (await pay(id, { amountMinor: 10000, method: 'cash' })).json();
    expect(p.invoice.status).toBe('paid');
    expect((await app.inject({ method: 'POST', url: `/payments/${p.payment.id}/reverse`, headers: bearer(reception), payload: { reason: 'x' } })).statusCode).toBe(403);
    const rev = await app.inject({ method: 'POST', url: `/payments/${p.payment.id}/reverse`, headers: bearer(admin), payload: { reason: 'refunded at desk' } });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().payment.status).toBe('reversed');
    expect(rev.json().invoice.status).toBe('issued');
    expect(rev.json().invoice.balanceDueMinor).toBe(10000);
    // Double reversal refused.
    expect((await app.inject({ method: 'POST', url: `/payments/${p.payment.id}/reverse`, headers: bearer(admin), payload: { reason: 'again' } })).statusCode).toBe(409);
  });

  it('a recorded payment is immutable at the database level', async () => {
    const id = await issued(10000);
    const p = (await pay(id, { amountMinor: 5000, method: 'cash' })).json();
    await expect(
      getPool().query(`UPDATE payment SET amount_minor = 1 WHERE id = $1`, [p.payment.id]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      getPool().query(`DELETE FROM payment WHERE id = $1`, [p.payment.id]),
    ).rejects.toThrow(/append-only/i);
  });
});

describe('Billing — tenant isolation', () => {
  it('never lets another clinic read, pay, or void an invoice', async () => {
    const patientId = await newPatient();
    const inv = (await draftInvoice(patientId, [{ description: 'A', quantity: 1, unitPriceMinor: 10000 }])).json();
    await app.inject({ method: 'POST', url: `/invoices/${inv.id}/issue`, headers: bearer(reception) });

    const other = await makeClinic('Other Clinic');
    const otherReception = await makeUser(other.clinicId, 'r2', RoleKey.RECEPTION);
    const otherAdmin = await makeUser(other.clinicId, 'a2', RoleKey.ADMIN);

    expect((await app.inject({ method: 'GET', url: `/invoices/${inv.id}`, headers: bearer(otherReception) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/invoices/${inv.id}/payments`, headers: bearer(otherReception), payload: { amountMinor: 100, method: 'cash' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: bearer(otherAdmin), payload: { reason: 'cross tenant attempt' } })).statusCode).toBe(404);
    // The invoice does not appear in the other clinic's list.
    expect((await app.inject({ method: 'GET', url: '/invoices', headers: bearer(otherReception) })).json().total).toBe(0);
  });
});

describe('Billing — reports (DB source of truth)', () => {
  it('reports revenue from completed payments only, excluding reversed', async () => {
    const patientId = await newPatient();
    async function issuedPaid(amount: number): Promise<string> {
      const inv = (await draftInvoice(patientId, [{ description: 'V', quantity: 1, unitPriceMinor: amount }])).json();
      await app.inject({ method: 'POST', url: `/invoices/${inv.id}/issue`, headers: bearer(reception) });
      return inv.id;
    }
    const i1 = await issuedPaid(10000);
    await app.inject({ method: 'POST', url: `/invoices/${i1}/payments`, headers: bearer(reception), payload: { amountMinor: 10000, method: 'cash' } });
    const i2 = await issuedPaid(5000);
    const p2 = (await app.inject({ method: 'POST', url: `/invoices/${i2}/payments`, headers: bearer(reception), payload: { amountMinor: 5000, method: 'card' } })).json();
    // Reverse the second payment → it must drop out of revenue.
    await app.inject({ method: 'POST', url: `/payments/${p2.payment.id}/reverse`, headers: bearer(admin), payload: { reason: 'refund' } });
    // A third issued-but-unpaid invoice → outstanding.
    await issuedPaid(8000);

    const summary = (await app.inject({ method: 'GET', url: '/billing/reports/summary', headers: bearer(admin) })).json();
    expect(summary.revenueMinor).toBe(10000); // only the non-reversed payment
    expect(summary.paymentCount).toBe(1);
    expect(summary.outstandingMinor).toBe(13000); // i2 (5000, reversed→owed again) + i3 (8000)
    expect(summary.byMethod).toEqual([{ method: 'cash', amountMinor: 10000, count: 1 }]);
  });

  it('requires billing:report — reception cannot read reports', async () => {
    expect((await app.inject({ method: 'GET', url: '/billing/reports/summary', headers: bearer(reception) })).statusCode).toBe(403);
  });
});

describe('Billing — audit (no PHI)', () => {
  it('audits invoice.create and payment.record without patient name', async () => {
    const patientId = await newPatient(reception, 'Sensitive Name');
    const inv = (await draftInvoice(patientId, [{ description: 'V', quantity: 1, unitPriceMinor: 10000 }])).json();
    await app.inject({ method: 'POST', url: `/invoices/${inv.id}/issue`, headers: bearer(reception) });
    await app.inject({ method: 'POST', url: `/invoices/${inv.id}/payments`, headers: bearer(reception), payload: { amountMinor: 10000, method: 'cash' } });
    const { rows } = await getPool().query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM audit_log WHERE action IN ('invoice.create','payment.record')`,
    );
    expect(rows.map((r) => r.action).sort()).toEqual(['invoice.create', 'payment.record']);
    expect(JSON.stringify(rows)).not.toMatch(/sensitive name/i);
  });
});
