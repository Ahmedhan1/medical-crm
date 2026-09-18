/**
 * Billing repository types + row mappers. `pg` returns `bigint`/`numeric` as
 * strings; money is mapped through `Number()` back to integer MINOR UNITS. Clinic
 * money (piastres/cents) stays far below Number.MAX_SAFE_INTEGER, so integer
 * identity is preserved. No arithmetic happens here — mapping only.
 */

export type InvoiceStatus =
  | 'draft'
  | 'issued'
  | 'partially_paid'
  | 'paid'
  | 'void'
  | 'cancelled';

export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'insurance' | 'wallet' | 'other';
export type PaymentStatus = 'completed' | 'reversed';

export interface BillableService {
  id: string;
  clinicId: string;
  code: string;
  name: string;
  unitPriceMinor: number;
  currency: string;
  taxRateBp: number;
  isActive: boolean;
}

export interface InvoiceItem {
  id: string;
  invoiceId: string;
  lineNo: number;
  serviceId: string | null;
  sourceRef: string | null;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxRateBp: number;
  lineSubtotalMinor: number;
  taxMinor: number;
  lineTotalMinor: number;
}

export interface Invoice {
  id: string;
  clinicId: string;
  patientId: string;
  encounterId: string | null;
  invoiceNumber: string | null;
  status: InvoiceStatus;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  amountPaidMinor: number;
  balanceDueMinor: number;
  notes: string | null;
  dueDate: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  clinicId: string;
  invoiceId: string;
  amountMinor: number;
  currency: string;
  method: PaymentMethod;
  reference: string | null;
  status: PaymentStatus;
  paidAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
  createdBy: string;
  createdAt: string;
}

const int = (v: string | number | null): number => (v === null ? 0 : Number(v));

export const SERVICE_COLS = `id, clinic_id, code, name, unit_price_minor, currency, tax_rate_bp, is_active`;
export function mapService(r: Record<string, unknown>): BillableService {
  return {
    id: r.id as string,
    clinicId: r.clinic_id as string,
    code: r.code as string,
    name: r.name as string,
    unitPriceMinor: int(r.unit_price_minor as string),
    currency: r.currency as string,
    taxRateBp: Number(r.tax_rate_bp),
    isActive: r.is_active as boolean,
  };
}

export const INVOICE_COLS = `id, clinic_id, patient_id, encounter_id, invoice_number, status,
  currency, subtotal_minor, discount_minor, tax_minor, total_minor, amount_paid_minor,
  balance_due_minor, notes, due_date, issued_at, paid_at, voided_at, void_reason,
  created_by, created_at, updated_at`;
export function mapInvoice(r: Record<string, unknown>): Invoice {
  return {
    id: r.id as string,
    clinicId: r.clinic_id as string,
    patientId: r.patient_id as string,
    encounterId: (r.encounter_id as string | null) ?? null,
    invoiceNumber: (r.invoice_number as string | null) ?? null,
    status: r.status as InvoiceStatus,
    currency: r.currency as string,
    subtotalMinor: int(r.subtotal_minor as string),
    discountMinor: int(r.discount_minor as string),
    taxMinor: int(r.tax_minor as string),
    totalMinor: int(r.total_minor as string),
    amountPaidMinor: int(r.amount_paid_minor as string),
    balanceDueMinor: int(r.balance_due_minor as string),
    notes: (r.notes as string | null) ?? null,
    dueDate: r.due_date ? String(r.due_date) : null,
    issuedAt: (r.issued_at as string | null) ?? null,
    paidAt: (r.paid_at as string | null) ?? null,
    voidedAt: (r.voided_at as string | null) ?? null,
    voidReason: (r.void_reason as string | null) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export const ITEM_COLS = `id, invoice_id, line_no, service_id, source_ref, description, quantity,
  unit_price_minor, discount_minor, tax_rate_bp, line_subtotal_minor, tax_minor, line_total_minor`;
export function mapItem(r: Record<string, unknown>): InvoiceItem {
  return {
    id: r.id as string,
    invoiceId: r.invoice_id as string,
    lineNo: Number(r.line_no),
    serviceId: (r.service_id as string | null) ?? null,
    sourceRef: (r.source_ref as string | null) ?? null,
    description: r.description as string,
    quantity: Number(r.quantity),
    unitPriceMinor: int(r.unit_price_minor as string),
    discountMinor: int(r.discount_minor as string),
    taxRateBp: Number(r.tax_rate_bp),
    lineSubtotalMinor: int(r.line_subtotal_minor as string),
    taxMinor: int(r.tax_minor as string),
    lineTotalMinor: int(r.line_total_minor as string),
  };
}

export const PAYMENT_COLS = `id, clinic_id, invoice_id, amount_minor, currency, method, reference,
  status, paid_at, reversed_at, reversal_reason, created_by, created_at`;
export function mapPayment(r: Record<string, unknown>): Payment {
  return {
    id: r.id as string,
    clinicId: r.clinic_id as string,
    invoiceId: r.invoice_id as string,
    amountMinor: int(r.amount_minor as string),
    currency: r.currency as string,
    method: r.method as PaymentMethod,
    reference: (r.reference as string | null) ?? null,
    status: r.status as PaymentStatus,
    paidAt: r.paid_at as string,
    reversedAt: (r.reversed_at as string | null) ?? null,
    reversalReason: (r.reversal_reason as string | null) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
  };
}
