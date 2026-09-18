import { z } from 'zod';
import { withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { PAYMENT_COLS, mapPayment, type Invoice, type Payment } from './billing.repo.js';
import { lockInvoiceTx, recomputeInvoiceFromPaymentsTx } from './invoices.service.js';

export const RecordPaymentSchema = z.object({
  amountMinor: z.number().int().positive(),
  method: z.enum(['cash', 'card', 'bank_transfer', 'insurance', 'wallet', 'other']),
  reference: z.string().trim().min(1).max(120).optional(),
  paidAt: z.string().datetime({ offset: true }).optional(),
  /** Client-supplied key that makes a retried request safe (no double payment). */
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

export interface PaymentResult {
  payment: Payment;
  invoice: Invoice;
}

async function findByIdempotencyKey(
  client: PoolClient,
  clinicId: string,
  key: string,
): Promise<Payment | null> {
  const { rows } = await client.query(
    `SELECT ${PAYMENT_COLS} FROM payment WHERE clinic_id = $1 AND idempotency_key = $2`,
    [clinicId, key],
  );
  return rows[0] ? mapPayment(rows[0]) : null;
}

export async function recordPayment(
  principal: Principal,
  invoiceId: string,
  raw: unknown,
): Promise<PaymentResult> {
  requirePermission(principal, Permission.PAYMENT_RECORD);
  const parsed = RecordPaymentSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid payment', parsed.error.flatten());
  const d = parsed.data;

  return withTransaction(async (client) => {
    // Lock the invoice first so concurrent payments serialize — two payments
    // that are each within balance can never together overpay.
    const invoice = await lockInvoiceTx(client, principal.clinicId, invoiceId);

    if (d.idempotencyKey) {
      const existing = await findByIdempotencyKey(client, principal.clinicId, d.idempotencyKey);
      if (existing) {
        // Idempotent replay: return the already-recorded payment untouched.
        const fresh = await lockInvoiceTx(client, principal.clinicId, invoiceId);
        return { payment: existing, invoice: fresh };
      }
    }

    if (invoice.status !== 'issued' && invoice.status !== 'partially_paid') {
      throw new ConflictError(`Cannot record a payment against an invoice that is ${invoice.status}`);
    }
    if (d.amountMinor > invoice.balanceDueMinor) {
      throw new ValidationError('Payment exceeds the outstanding balance (overpayment is not supported)', {
        balanceDueMinor: invoice.balanceDueMinor,
      });
    }

    let inserted: Payment;
    try {
      const { rows } = await client.query(
        `INSERT INTO payment
           (clinic_id, invoice_id, amount_minor, currency, method, reference, idempotency_key, paid_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),$9)
         RETURNING ${PAYMENT_COLS}`,
        [
          principal.clinicId, invoice.id, d.amountMinor, invoice.currency, d.method,
          d.reference ?? null, d.idempotencyKey ?? null, d.paidAt ?? null, principal.userId,
        ],
      );
      inserted = mapPayment(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // Concurrent replay hit the idempotency unique index — return the winner.
        const existing = d.idempotencyKey
          ? await findByIdempotencyKey(client, principal.clinicId, d.idempotencyKey)
          : null;
        if (existing) return { payment: existing, invoice };
      }
      throw err;
    }

    const updatedInvoice = await recomputeInvoiceFromPaymentsTx(client, invoice);

    await emitEvent(client, {
      clinicId: principal.clinicId, type: EventType.PAYMENT_RECORDED, subjectType: 'invoice',
      subjectId: invoice.id, actorId: principal.userId,
      payload: {
        patientId: invoice.patientId, paymentId: inserted.id, amountMinor: d.amountMinor,
        currency: invoice.currency, method: d.method, invoiceStatus: updatedInvoice.status,
      },
    });
    if (updatedInvoice.status === 'paid') {
      await emitEvent(client, {
        clinicId: principal.clinicId, type: EventType.INVOICE_PAID, subjectType: 'invoice',
        subjectId: invoice.id, actorId: principal.userId,
        payload: { patientId: invoice.patientId, invoiceNumber: updatedInvoice.invoiceNumber, totalMinor: updatedInvoice.totalMinor, currency: invoice.currency },
      });
    }
    await auditTx(client, {
      clinicId: principal.clinicId, actorId: principal.userId, action: 'payment.record',
      outcome: 'success', targetType: 'payment', targetId: inserted.id,
      metadata: { invoiceId: invoice.id, amountMinor: d.amountMinor, method: d.method },
    });
    return { payment: inserted, invoice: updatedInvoice };
  });
}

const ReverseSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export async function reversePayment(
  principal: Principal,
  paymentId: string,
  raw: unknown,
): Promise<PaymentResult> {
  requirePermission(principal, Permission.PAYMENT_REVERSE);
  const parsed = ReverseSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('A reason is required to reverse a payment', parsed.error.flatten());

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT ${PAYMENT_COLS} FROM payment WHERE clinic_id = $1 AND id = $2 FOR UPDATE`,
      [principal.clinicId, paymentId],
    );
    if (!rows[0]) throw new NotFoundError('Payment');
    const payment = mapPayment(rows[0]);
    if (payment.status === 'reversed') throw new ConflictError('Payment is already reversed');

    // Lock the invoice too before recomputing its balance.
    const invoice = await lockInvoiceTx(client, principal.clinicId, payment.invoiceId);

    const { rows: rev } = await client.query(
      `UPDATE payment SET status='reversed', reversed_at=now(), reversal_reason=$3, reversed_by=$4
        WHERE clinic_id=$1 AND id=$2 RETURNING ${PAYMENT_COLS}`,
      [principal.clinicId, payment.id, parsed.data.reason, principal.userId],
    );
    const reversed = mapPayment(rev[0]!);
    const updatedInvoice = await recomputeInvoiceFromPaymentsTx(client, invoice);

    await emitEvent(client, {
      clinicId: principal.clinicId, type: EventType.PAYMENT_REVERSED, subjectType: 'invoice',
      subjectId: invoice.id, actorId: principal.userId,
      payload: { patientId: invoice.patientId, paymentId: payment.id, amountMinor: payment.amountMinor, currency: invoice.currency, invoiceStatus: updatedInvoice.status },
    });
    await auditTx(client, {
      clinicId: principal.clinicId, actorId: principal.userId, action: 'payment.reverse',
      outcome: 'success', targetType: 'payment', targetId: payment.id,
      metadata: { invoiceId: invoice.id, amountMinor: payment.amountMinor },
    });
    return { payment: reversed, invoice: updatedInvoice };
  });
}
