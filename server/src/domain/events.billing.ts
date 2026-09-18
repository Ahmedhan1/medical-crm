/**
 * BILLING & FINANCE event types — owned by Agent 2 (Finance workstream).
 * Financial lifecycle events. Payloads carry identifiers, status and integer
 * money amounts + currency only — never patient PHI or free-text notes.
 */
export const BillingEventType = {
  INVOICE_CREATED: 'INVOICE_CREATED',
  INVOICE_ISSUED: 'INVOICE_ISSUED',
  INVOICE_CANCELLED: 'INVOICE_CANCELLED',
  INVOICE_VOIDED: 'INVOICE_VOIDED',
  INVOICE_PAID: 'INVOICE_PAID',
  PAYMENT_RECORDED: 'PAYMENT_RECORDED',
  PAYMENT_REVERSED: 'PAYMENT_REVERSED',
} as const;

export type BillingEventType = (typeof BillingEventType)[keyof typeof BillingEventType];
