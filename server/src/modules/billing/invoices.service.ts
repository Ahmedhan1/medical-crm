import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';
import { computeLine, computeInvoiceTotals, type LineTotals } from './money.js';
import { getServicesByIds } from './catalog.service.js';
import {
  INVOICE_COLS,
  ITEM_COLS,
  PAYMENT_COLS,
  mapInvoice,
  mapItem,
  mapPayment,
  type Invoice,
  type InvoiceItem,
  type InvoiceStatus,
  type Payment,
} from './billing.repo.js';

// ---------------------------------------------------------------------------
// Shared invoice helpers (used by the payment service too)
// ---------------------------------------------------------------------------

/** Lock an invoice row for a money mutation; throws NotFound (never leaks across clinics). */
export async function lockInvoiceTx(
  client: PoolClient,
  clinicId: string,
  invoiceId: string,
): Promise<Invoice> {
  const { rows } = await client.query(
    `SELECT ${INVOICE_COLS} FROM invoice WHERE clinic_id = $1 AND id = $2 FOR UPDATE`,
    [clinicId, invoiceId],
  );
  if (!rows[0]) throw new NotFoundError('Invoice');
  return mapInvoice(rows[0]);
}

/**
 * Re-derive amount_paid / balance / status from the invoice's completed payments
 * and persist it, inside the caller's transaction. This is the ONE place invoice
 * money is recomputed after a payment or reversal, so the header can never drift
 * from the payment ledger. Returns the updated invoice.
 */
export async function recomputeInvoiceFromPaymentsTx(
  client: PoolClient,
  invoice: Invoice,
): Promise<Invoice> {
  const { rows } = await client.query<{ paid: string }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS paid
       FROM payment WHERE invoice_id = $1 AND status = 'completed'`,
    [invoice.id],
  );
  const amountPaid = Number(rows[0]!.paid);
  if (amountPaid > invoice.totalMinor) {
    // Guarded against upstream (overpayment refused), but never let the header
    // violate the schema invariant.
    throw new ConflictError('Payments exceed the invoice total');
  }
  const balance = invoice.totalMinor - amountPaid;
  let status: InvoiceStatus = invoice.status;
  // Payment-driven transitions only apply to a live, issued invoice.
  if (invoice.status === 'issued' || invoice.status === 'partially_paid' || invoice.status === 'paid') {
    if (balance === 0 && invoice.totalMinor > 0) status = 'paid';
    else if (amountPaid > 0) status = 'partially_paid';
    else status = 'issued';
  }
  const paidAt = status === 'paid' ? 'now()' : 'NULL';
  const { rows: updated } = await client.query(
    `UPDATE invoice
        SET amount_paid_minor = $3, balance_due_minor = $4, status = $5,
            paid_at = ${paidAt}, updated_at = now()
      WHERE clinic_id = $1 AND id = $2
      RETURNING ${INVOICE_COLS}`,
    [invoice.clinicId, invoice.id, amountPaid, balance, status],
  );
  return mapInvoice(updated[0]!);
}

// ---------------------------------------------------------------------------
// Create / edit draft
// ---------------------------------------------------------------------------
const ItemInput = z.object({
  serviceId: z.string().uuid().optional(),
  sourceRef: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(200).optional(),
  quantity: z.number().int().min(1).max(100000).default(1),
  unitPriceMinor: z.number().int().min(0).optional(),
  discountMinor: z.number().int().min(0).default(0),
  taxRateBp: z.number().int().min(0).max(10000).optional(),
});

export const CreateInvoiceSchema = z.object({
  patientId: z.string().uuid(),
  encounterId: z.string().uuid().optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default('EGP'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().trim().max(2000).optional(),
  items: z.array(ItemInput).min(1).max(200),
});

interface ResolvedLine extends LineTotals {
  serviceId: string | null;
  sourceRef: string | null;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxRateBp: number;
}

/** Resolve each requested item against the catalog (price/tax/description) and
 * compute its integer money. A catalog line inherits price+tax unless overridden;
 * an ad-hoc line must supply its own description and unit price. */
async function resolveLines(
  clinicId: string,
  currency: string,
  items: z.infer<typeof ItemInput>[],
  runner: Pick<PoolClient, 'query'>,
): Promise<ResolvedLine[]> {
  const serviceIds = [...new Set(items.map((i) => i.serviceId).filter((x): x is string => !!x))];
  const services = await getServicesByIds(clinicId, serviceIds, runner);
  return items.map((it) => {
    let unitPriceMinor = it.unitPriceMinor;
    let taxRateBp = it.taxRateBp;
    let description = it.description;
    let serviceId: string | null = null;
    if (it.serviceId) {
      const svc = services.get(it.serviceId);
      if (!svc) throw new ValidationError('serviceId does not belong to this clinic');
      if (!svc.isActive) throw new ConflictError(`Service "${svc.code}" is not active`);
      if (svc.currency !== currency) {
        throw new ValidationError(`Service "${svc.code}" is priced in ${svc.currency}, not ${currency}`);
      }
      serviceId = svc.id;
      unitPriceMinor = unitPriceMinor ?? svc.unitPriceMinor;
      taxRateBp = taxRateBp ?? svc.taxRateBp;
      description = description ?? svc.name;
    }
    if (description === undefined) throw new ValidationError('description is required for an ad-hoc line');
    if (unitPriceMinor === undefined) throw new ValidationError('unitPriceMinor is required for an ad-hoc line');
    const totals = computeLine({ quantity: it.quantity, unitPriceMinor, discountMinor: it.discountMinor, taxRateBp: taxRateBp ?? 0 });
    return {
      ...totals,
      serviceId,
      sourceRef: it.sourceRef ?? null,
      description,
      quantity: it.quantity,
      unitPriceMinor,
      discountMinor: it.discountMinor,
      taxRateBp: taxRateBp ?? 0,
    };
  });
}

export interface InvoiceWithItems extends Invoice {
  items: InvoiceItem[];
}

async function loadItems(invoiceId: string, runner: Pick<PoolClient, 'query'>): Promise<InvoiceItem[]> {
  const { rows } = await runner.query(
    `SELECT ${ITEM_COLS} FROM invoice_item WHERE invoice_id = $1 ORDER BY line_no`,
    [invoiceId],
  );
  return rows.map(mapItem);
}

async function insertLinesTx(
  client: PoolClient,
  clinicId: string,
  invoiceId: string,
  lines: ResolvedLine[],
): Promise<void> {
  let lineNo = 1;
  for (const l of lines) {
    await client.query(
      `INSERT INTO invoice_item
         (clinic_id, invoice_id, line_no, service_id, source_ref, description, quantity,
          unit_price_minor, discount_minor, tax_rate_bp, line_subtotal_minor, tax_minor, line_total_minor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        clinicId, invoiceId, lineNo, l.serviceId, l.sourceRef, l.description, l.quantity,
        l.unitPriceMinor, l.discountMinor, l.taxRateBp, l.lineSubtotalMinor, l.taxMinor, l.lineTotalMinor,
      ],
    );
    lineNo += 1;
  }
}

export async function createInvoice(principal: Principal, raw: unknown): Promise<InvoiceWithItems> {
  requirePermission(principal, Permission.INVOICE_CREATE);
  const parsed = CreateInvoiceSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid invoice', parsed.error.flatten());
  const d = parsed.data;

  const patient = await getPatientById(principal.clinicId, d.patientId);
  if (!patient) throw new NotFoundError('Patient');
  if (patient.status === 'merged') {
    throw new ConflictError('This record was merged; bill the surviving patient', {
      mergedIntoId: patient.mergedIntoId,
    });
  }

  return withTransaction(async (client) => {
    const lines = await resolveLines(principal.clinicId, d.currency, d.items, client);
    const totals = computeInvoiceTotals(lines);
    const { rows } = await client.query(
      `INSERT INTO invoice
         (clinic_id, patient_id, encounter_id, status, currency, subtotal_minor, discount_minor,
          tax_minor, total_minor, amount_paid_minor, balance_due_minor, notes, due_date, created_by)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,0,$8,$9,$10,$11)
       RETURNING ${INVOICE_COLS}`,
      [
        principal.clinicId, patient.id, d.encounterId ?? null, d.currency,
        totals.subtotalMinor, totals.discountMinor, totals.taxMinor, totals.totalMinor,
        d.notes ?? null, d.dueDate ?? null, principal.userId,
      ],
    );
    const invoice = mapInvoice(rows[0]!);
    await insertLinesTx(client, principal.clinicId, invoice.id, lines);
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.INVOICE_CREATED,
      subjectType: 'invoice',
      subjectId: invoice.id,
      actorId: principal.userId,
      payload: { patientId: patient.id, totalMinor: totals.totalMinor, currency: d.currency },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'invoice.create',
      outcome: 'success',
      targetType: 'invoice',
      targetId: invoice.id,
      metadata: { patientId: patient.id, totalMinor: totals.totalMinor, lineCount: lines.length },
    });
    return { ...invoice, items: await loadItems(invoice.id, client) };
  });
}

/** Replace a DRAFT invoice's line items (and optional notes/due date). Only a
 * draft is editable — an issued invoice is financially fixed. */
export async function updateDraftInvoice(
  principal: Principal,
  invoiceId: string,
  raw: unknown,
): Promise<InvoiceWithItems> {
  requirePermission(principal, Permission.INVOICE_CREATE);
  const parsed = CreateInvoiceSchema.partial({ patientId: true }).safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid invoice update', parsed.error.flatten());
  const d = parsed.data;
  if (!d.items || d.items.length === 0) throw new ValidationError('At least one line item is required');

  return withTransaction(async (client) => {
    const invoice = await lockInvoiceTx(client, principal.clinicId, invoiceId);
    if (invoice.status !== 'draft') {
      throw new ConflictError(`Only a draft invoice can be edited (this invoice is ${invoice.status})`);
    }
    const lines = await resolveLines(principal.clinicId, invoice.currency, d.items, client);
    const totals = computeInvoiceTotals(lines);
    await client.query(`DELETE FROM invoice_item WHERE invoice_id = $1`, [invoice.id]);
    await insertLinesTx(client, principal.clinicId, invoice.id, lines);
    const { rows } = await client.query(
      `UPDATE invoice SET subtotal_minor=$3, discount_minor=$4, tax_minor=$5, total_minor=$6,
              balance_due_minor=$6, notes=COALESCE($7, notes), due_date=COALESCE($8, due_date),
              updated_at=now()
        WHERE clinic_id=$1 AND id=$2 RETURNING ${INVOICE_COLS}`,
      [principal.clinicId, invoice.id, totals.subtotalMinor, totals.discountMinor, totals.taxMinor,
       totals.totalMinor, d.notes ?? null, d.dueDate ?? null],
    );
    await auditTx(client, {
      clinicId: principal.clinicId, actorId: principal.userId, action: 'invoice.update',
      outcome: 'success', targetType: 'invoice', targetId: invoice.id,
      metadata: { totalMinor: totals.totalMinor, lineCount: lines.length },
    });
    const updated = mapInvoice(rows[0]!);
    return { ...updated, items: await loadItems(invoice.id, client) };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------
export async function issueInvoice(principal: Principal, invoiceId: string): Promise<Invoice> {
  requirePermission(principal, Permission.INVOICE_ISSUE);
  return withTransaction(async (client) => {
    const invoice = await lockInvoiceTx(client, principal.clinicId, invoiceId);
    if (invoice.status !== 'draft') {
      throw new ConflictError(`Only a draft can be issued (this invoice is ${invoice.status})`);
    }
    if (invoice.totalMinor <= 0) {
      throw new ConflictError('Cannot issue an invoice with a zero total');
    }
    // Per-clinic monotonic number under the sequence row lock.
    const { rows: seq } = await client.query<{ assigned: string }>(
      `INSERT INTO billing_sequence (clinic_id, next_invoice_no) VALUES ($1, 2)
         ON CONFLICT (clinic_id) DO UPDATE SET next_invoice_no = billing_sequence.next_invoice_no + 1
       RETURNING next_invoice_no - 1 AS assigned`,
      [principal.clinicId],
    );
    const number = `INV-${String(seq[0]!.assigned).padStart(6, '0')}`;
    const { rows } = await client.query(
      `UPDATE invoice SET status='issued', invoice_number=$3, issued_at=now(), updated_at=now()
        WHERE clinic_id=$1 AND id=$2 RETURNING ${INVOICE_COLS}`,
      [principal.clinicId, invoice.id, number],
    );
    const updated = mapInvoice(rows[0]!);
    await emitEvent(client, {
      clinicId: principal.clinicId, type: EventType.INVOICE_ISSUED, subjectType: 'invoice',
      subjectId: invoice.id, actorId: principal.userId,
      payload: { patientId: invoice.patientId, invoiceNumber: number, totalMinor: invoice.totalMinor, currency: invoice.currency },
    });
    await auditTx(client, {
      clinicId: principal.clinicId, actorId: principal.userId, action: 'invoice.issue',
      outcome: 'success', targetType: 'invoice', targetId: invoice.id,
      metadata: { invoiceNumber: number, totalMinor: invoice.totalMinor },
    });
    return updated;
  });
}

export async function cancelDraftInvoice(principal: Principal, invoiceId: string): Promise<Invoice> {
  requirePermission(principal, Permission.INVOICE_CREATE);
  return withTransaction(async (client) => {
    const invoice = await lockInvoiceTx(client, principal.clinicId, invoiceId);
    if (invoice.status !== 'draft') {
      throw new ConflictError(`Only a draft can be cancelled (this invoice is ${invoice.status})`);
    }
    const { rows } = await client.query(
      `UPDATE invoice SET status='cancelled', updated_at=now()
        WHERE clinic_id=$1 AND id=$2 RETURNING ${INVOICE_COLS}`,
      [principal.clinicId, invoice.id],
    );
    await emitEvent(client, {
      clinicId: principal.clinicId, type: EventType.INVOICE_CANCELLED, subjectType: 'invoice',
      subjectId: invoice.id, actorId: principal.userId, payload: { patientId: invoice.patientId },
    });
    await auditTx(client, {
      clinicId: principal.clinicId, actorId: principal.userId, action: 'invoice.cancel',
      outcome: 'success', targetType: 'invoice', targetId: invoice.id,
    });
    return mapInvoice(rows[0]!);
  });
}

const VoidSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export async function voidInvoice(principal: Principal, invoiceId: string, raw: unknown): Promise<Invoice> {
  requirePermission(principal, Permission.INVOICE_VOID);
  const parsed = VoidSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('A reason is required to void an invoice', parsed.error.flatten());
  return withTransaction(async (client) => {
    const invoice = await lockInvoiceTx(client, principal.clinicId, invoiceId);
    if (invoice.status !== 'issued' && invoice.status !== 'partially_paid') {
      throw new ConflictError(`Cannot void an invoice that is ${invoice.status}`);
    }
    if (invoice.amountPaidMinor > 0) {
      throw new ConflictError('Reverse the invoice payments before voiding it');
    }
    const { rows } = await client.query(
      `UPDATE invoice SET status='void', voided_at=now(), void_reason=$3, updated_at=now()
        WHERE clinic_id=$1 AND id=$2 RETURNING ${INVOICE_COLS}`,
      [principal.clinicId, invoice.id, parsed.data.reason],
    );
    await emitEvent(client, {
      clinicId: principal.clinicId, type: EventType.INVOICE_VOIDED, subjectType: 'invoice',
      subjectId: invoice.id, actorId: principal.userId,
      payload: { patientId: invoice.patientId, invoiceNumber: invoice.invoiceNumber },
    });
    await auditTx(client, {
      clinicId: principal.clinicId, actorId: principal.userId, action: 'invoice.void',
      outcome: 'success', targetType: 'invoice', targetId: invoice.id,
      metadata: { invoiceNumber: invoice.invoiceNumber },
    });
    return mapInvoice(rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export const ListInvoicesQuery = z.object({
  status: z.enum(['draft', 'issued', 'partially_paid', 'paid', 'void', 'cancelled']).optional(),
  patientId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function listInvoices(principal: Principal, rawQuery: unknown): Promise<{ invoices: Invoice[]; total: number }> {
  requirePermission(principal, Permission.BILLING_READ);
  const parsed = ListInvoicesQuery.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());
  const q = parsed.data;
  const where = [`clinic_id = $1`];
  const values: unknown[] = [principal.clinicId];
  if (q.status) { values.push(q.status); where.push(`status = $${values.length}`); }
  if (q.patientId) { values.push(q.patientId); where.push(`patient_id = $${values.length}`); }
  if (q.from) { values.push(q.from); where.push(`created_at >= $${values.length}::date`); }
  if (q.to) { values.push(q.to); where.push(`created_at < ($${values.length}::date + 1)`); }
  const clause = where.join(' AND ');
  const pool = getPool();
  const totalRes = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoice WHERE ${clause}`, values);
  values.push(q.limit); const limIdx = values.length;
  values.push(q.offset); const offIdx = values.length;
  const { rows } = await pool.query(
    `SELECT ${INVOICE_COLS} FROM invoice WHERE ${clause}
      ORDER BY created_at DESC LIMIT $${limIdx} OFFSET $${offIdx}`,
    values,
  );
  return { invoices: rows.map(mapInvoice), total: Number(totalRes.rows[0]!.n) };
}

export interface InvoiceDetail extends InvoiceWithItems {
  payments: Payment[];
}

export async function getInvoice(principal: Principal, invoiceId: string): Promise<InvoiceDetail> {
  requirePermission(principal, Permission.BILLING_READ);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ${INVOICE_COLS} FROM invoice WHERE clinic_id = $1 AND id = $2`,
    [principal.clinicId, invoiceId],
  );
  if (!rows[0]) throw new NotFoundError('Invoice');
  const invoice = mapInvoice(rows[0]);
  const items = await loadItems(invoice.id, pool);
  const { rows: pay } = await pool.query(
    `SELECT ${PAYMENT_COLS} FROM payment WHERE clinic_id = $1 AND invoice_id = $2 ORDER BY created_at`,
    [principal.clinicId, invoice.id],
  );
  return { ...invoice, items, payments: pay.map(mapPayment) };
}

export async function listPatientInvoices(principal: Principal, patientId: string): Promise<Invoice[]> {
  requirePermission(principal, Permission.BILLING_READ);
  const { rows } = await getPool().query(
    `SELECT ${INVOICE_COLS} FROM invoice WHERE clinic_id = $1 AND patient_id = $2 ORDER BY created_at DESC LIMIT 200`,
    [principal.clinicId, patientId],
  );
  return rows.map(mapInvoice);
}
