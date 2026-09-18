import { api } from '../../../lib/api/client.js';

/**
 * Finance/Billing API layer — thin typed wrappers over the existing backend
 * endpoints, all through the shared `api` client (bearer token, ApiError
 * normalization, 401 fail-closed, cancellation). No raw fetch, no invented
 * endpoints, no money maths on the client — amounts are integer minor units
 * exactly as the backend returns them.
 */

export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'void' | 'cancelled';
export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'insurance' | 'wallet' | 'other';

export interface BillableService {
  id: string;
  code: string;
  name: string;
  unitPriceMinor: number;
  currency: string;
  taxRateBp: number;
  isActive: boolean;
}

export interface InvoiceItem {
  id: string;
  lineNo: number;
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
  patientId: string;
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
  voidReason?: string | null;
  createdAt: string;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amountMinor: number;
  currency: string;
  method: PaymentMethod;
  reference: string | null;
  status: 'completed' | 'reversed';
  paidAt: string;
}

export interface InvoiceDetail extends Invoice {
  items: InvoiceItem[];
  payments: Payment[];
}

export interface ItemInput {
  serviceId?: string;
  description?: string;
  quantity: number;
  unitPriceMinor?: number;
  discountMinor?: number;
  taxRateBp?: number;
}

export interface PatientSummary {
  id: string;
  mrn: string;
  fullName: string;
}

// Patient lookup reuses the existing shared endpoint (reception holds patient:search);
// finance never re-models patients.
export function searchPatients(query: string, signal?: AbortSignal): Promise<PatientSummary[]> {
  return api
    .get<{ results: PatientSummary[] }>('/patients/search', { query: { query }, signal })
    .then((r) => r.results);
}

export function listServices(signal?: AbortSignal): Promise<BillableService[]> {
  return api.get<{ services: BillableService[] }>('/billing/services', { signal }).then((r) => r.services);
}

export interface ListInvoicesResult {
  invoices: Invoice[];
  total: number;
}
export function listInvoices(
  params: { status?: InvoiceStatus; patientId?: string; limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<ListInvoicesResult> {
  return api.get<ListInvoicesResult>('/invoices', { query: { ...params }, signal });
}

export function getInvoice(id: string, signal?: AbortSignal): Promise<InvoiceDetail> {
  return api.get<InvoiceDetail>(`/invoices/${id}`, { signal });
}

export function createInvoice(body: { patientId: string; items: ItemInput[]; notes?: string; dueDate?: string }): Promise<InvoiceDetail> {
  return api.post<InvoiceDetail>('/invoices', body);
}

export function issueInvoice(id: string): Promise<Invoice> {
  return api.post<Invoice>(`/invoices/${id}/issue`);
}
export function voidInvoice(id: string, reason: string): Promise<Invoice> {
  return api.post<Invoice>(`/invoices/${id}/void`, { reason });
}
export function cancelInvoice(id: string): Promise<Invoice> {
  return api.post<Invoice>(`/invoices/${id}/cancel`);
}

export interface PaymentResult {
  payment: Payment;
  invoice: Invoice;
}
export function recordPayment(
  invoiceId: string,
  body: { amountMinor: number; method: PaymentMethod; reference?: string; idempotencyKey?: string },
): Promise<PaymentResult> {
  return api.post<PaymentResult>(`/invoices/${invoiceId}/payments`, body);
}
export function reversePayment(paymentId: string, reason: string): Promise<PaymentResult> {
  return api.post<PaymentResult>(`/payments/${paymentId}/reverse`, { reason });
}

export interface FinancialSummary {
  from: string;
  to: string;
  currency: string;
  revenueMinor: number;
  paymentCount: number;
  issuedInvoiceCount: number;
  paidInvoiceCount: number;
  outstandingMinor: number;
  outstandingInvoiceCount: number;
  byMethod: Array<{ method: string; amountMinor: number; count: number }>;
}
export function getSummary(params: { from?: string; to?: string }, signal?: AbortSignal): Promise<FinancialSummary> {
  return api.get<FinancialSummary>('/billing/reports/summary', { query: { ...params }, signal });
}
