import { ValidationError } from '../../domain/errors.js';

/**
 * Pure money maths in INTEGER MINOR UNITS (piastres/cents). No floating point:
 * every value is a JS integer number of minor units, and tax is derived with
 * integer division on basis points, so results are exact and deterministic.
 *
 * These functions are the single source of truth for how a line and an invoice
 * total are computed; the services call them and persist the result, and the
 * unit tests pin the arithmetic (rounding, zero, discount caps).
 */

export interface LineInput {
  quantity: number;
  unitPriceMinor: number;
  discountMinor?: number;
  taxRateBp?: number;
}

export interface LineTotals {
  grossMinor: number;
  lineSubtotalMinor: number;
  taxMinor: number;
  lineTotalMinor: number;
}

const isInt = (n: number): boolean => Number.isInteger(n);

/**
 * Compute one line's money. `gross = quantity * unitPrice`; the discount is
 * capped at gross (a line can never go negative); tax applies to the discounted
 * subtotal, floored to the minor unit. Throws `ValidationError` on any invalid
 * (non-integer / negative) input so bad money never reaches the database.
 */
export function computeLine(input: LineInput): LineTotals {
  const quantity = input.quantity;
  const unitPriceMinor = input.unitPriceMinor;
  const discountMinor = input.discountMinor ?? 0;
  const taxRateBp = input.taxRateBp ?? 0;

  if (!isInt(quantity) || quantity < 1) {
    throw new ValidationError('quantity must be a positive integer');
  }
  if (!isInt(unitPriceMinor) || unitPriceMinor < 0) {
    throw new ValidationError('unitPriceMinor must be a non-negative integer');
  }
  if (!isInt(discountMinor) || discountMinor < 0) {
    throw new ValidationError('discountMinor must be a non-negative integer');
  }
  if (!isInt(taxRateBp) || taxRateBp < 0 || taxRateBp > 10000) {
    throw new ValidationError('taxRateBp must be an integer between 0 and 10000');
  }

  const grossMinor = quantity * unitPriceMinor;
  if (discountMinor > grossMinor) {
    throw new ValidationError('line discount cannot exceed the line gross amount');
  }
  const lineSubtotalMinor = grossMinor - discountMinor;
  // Integer tax: floor(subtotal * bp / 10000). Math.floor is exact here because
  // all operands are integers well within Number.MAX_SAFE_INTEGER for clinic-scale money.
  const taxMinor = Math.floor((lineSubtotalMinor * taxRateBp) / 10000);
  const lineTotalMinor = lineSubtotalMinor + taxMinor;
  return { grossMinor, lineSubtotalMinor, taxMinor, lineTotalMinor };
}

export interface InvoiceTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/**
 * Roll line totals up into the invoice header. `subtotal` is the gross (before
 * discount), so the stored identity `total = subtotal - discount + tax` holds
 * exactly. Never sums prices from anywhere but the persisted line rows.
 */
export function computeInvoiceTotals(lines: LineTotals[]): InvoiceTotals {
  let subtotalMinor = 0;
  let discountMinor = 0;
  let taxMinor = 0;
  let totalMinor = 0;
  for (const l of lines) {
    subtotalMinor += l.grossMinor;
    discountMinor += l.grossMinor - l.lineSubtotalMinor;
    taxMinor += l.taxMinor;
    totalMinor += l.lineTotalMinor;
  }
  return { subtotalMinor, discountMinor, taxMinor, totalMinor };
}
