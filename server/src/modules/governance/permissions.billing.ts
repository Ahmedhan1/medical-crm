import { RoleKey, type WorkstreamPermissions } from './roles.js';

/**
 * BILLING & FINANCE permissions — owned by Agent 2 (Finance workstream).
 *
 * Financial data is sensitive, so capabilities are split by separation of
 * duties: the front desk (RECEPTION) does day-to-day billing — read, create and
 * issue invoices, record payments — while the sensitive money-reversing and
 * oversight actions (void an issued invoice, reverse a payment, manage the price
 * catalog, run financial reports) are ADMIN-only. ADMIN receives every
 * permission automatically, so it is never listed here.
 */
export const BillingPermission = {
  BILLING_READ: 'billing:read',
  INVOICE_CREATE: 'invoice:create',
  INVOICE_ISSUE: 'invoice:issue',
  INVOICE_VOID: 'invoice:void',
  PAYMENT_RECORD: 'payment:record',
  PAYMENT_REVERSE: 'payment:reverse',
  BILLING_REPORT: 'billing:report',
  BILLING_CONFIG: 'billing:config',
} as const;

export type BillingPermission = (typeof BillingPermission)[keyof typeof BillingPermission];

export const billingPermissions: WorkstreamPermissions = {
  permissions: BillingPermission,
  descriptions: {
    [BillingPermission.BILLING_READ]: 'View invoices, payments and balances',
    [BillingPermission.INVOICE_CREATE]: 'Create and edit draft invoices',
    [BillingPermission.INVOICE_ISSUE]: 'Issue a draft invoice (assigns a number, makes it payable)',
    [BillingPermission.INVOICE_VOID]: 'Void an issued invoice (reason required)',
    [BillingPermission.PAYMENT_RECORD]: 'Record a payment against an invoice',
    [BillingPermission.PAYMENT_REVERSE]: 'Reverse/refund a recorded payment (reason required)',
    [BillingPermission.BILLING_REPORT]: 'View financial reports (revenue, outstanding, summaries)',
    [BillingPermission.BILLING_CONFIG]: 'Manage the billable-service price catalog',
  },
  roleGrants: {
    [RoleKey.RECEPTION]: [
      BillingPermission.BILLING_READ,
      BillingPermission.INVOICE_CREATE,
      BillingPermission.INVOICE_ISSUE,
      BillingPermission.PAYMENT_RECORD,
    ],
    // DOCTOR may see a patient's billing state as context, nothing more.
    [RoleKey.DOCTOR]: [BillingPermission.BILLING_READ],
  },
};
