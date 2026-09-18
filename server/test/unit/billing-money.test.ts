import { describe, expect, it } from 'vitest';
import { computeLine, computeInvoiceTotals } from '../../src/modules/billing/money.js';

describe('billing money — computeLine (integer minor units)', () => {
  it('computes gross, subtotal, tax and total with no tax', () => {
    const l = computeLine({ quantity: 3, unitPriceMinor: 15000 }); // 3 × 150.00
    expect(l).toEqual({ grossMinor: 45000, lineSubtotalMinor: 45000, taxMinor: 0, lineTotalMinor: 45000 });
  });

  it('applies a line discount before tax', () => {
    const l = computeLine({ quantity: 2, unitPriceMinor: 10000, discountMinor: 5000, taxRateBp: 1400 });
    // gross 20000 − 5000 = 15000 subtotal; tax = floor(15000×1400/10000)=2100; total 17100
    expect(l).toEqual({ grossMinor: 20000, lineSubtotalMinor: 15000, taxMinor: 2100, lineTotalMinor: 17100 });
  });

  it('floors tax to the minor unit (no floating point)', () => {
    const l = computeLine({ quantity: 1, unitPriceMinor: 999, taxRateBp: 1400 });
    // 999 × 0.14 = 139.86 → floor 139
    expect(l.taxMinor).toBe(139);
    expect(l.lineTotalMinor).toBe(1138);
  });

  it('handles a zero-price line', () => {
    const l = computeLine({ quantity: 1, unitPriceMinor: 0, taxRateBp: 1400 });
    expect(l).toEqual({ grossMinor: 0, lineSubtotalMinor: 0, taxMinor: 0, lineTotalMinor: 0 });
  });

  it('rejects a discount larger than the line gross', () => {
    expect(() => computeLine({ quantity: 1, unitPriceMinor: 1000, discountMinor: 2000 })).toThrow(/discount/i);
  });

  it('rejects negative and non-integer money', () => {
    expect(() => computeLine({ quantity: 1, unitPriceMinor: -1 })).toThrow();
    expect(() => computeLine({ quantity: 0, unitPriceMinor: 100 })).toThrow(/positive integer/);
    expect(() => computeLine({ quantity: 1.5, unitPriceMinor: 100 })).toThrow();
    expect(() => computeLine({ quantity: 1, unitPriceMinor: 10.5 })).toThrow();
    expect(() => computeLine({ quantity: 1, unitPriceMinor: 100, taxRateBp: 20000 })).toThrow();
  });
});

describe('billing money — computeInvoiceTotals', () => {
  it('rolls lines up so total = subtotal − discount + tax exactly', () => {
    const a = computeLine({ quantity: 2, unitPriceMinor: 10000, discountMinor: 5000, taxRateBp: 1400 });
    const b = computeLine({ quantity: 1, unitPriceMinor: 30000, taxRateBp: 0 });
    const t = computeInvoiceTotals([a, b]);
    expect(t.subtotalMinor).toBe(50000); // 20000 + 30000 gross
    expect(t.discountMinor).toBe(5000);
    expect(t.taxMinor).toBe(2100);
    expect(t.totalMinor).toBe(47100); // 50000 − 5000 + 2100
    // identity holds
    expect(t.totalMinor).toBe(t.subtotalMinor - t.discountMinor + t.taxMinor);
  });

  it('is zero for an empty set', () => {
    expect(computeInvoiceTotals([])).toEqual({ subtotalMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0 });
  });
});
