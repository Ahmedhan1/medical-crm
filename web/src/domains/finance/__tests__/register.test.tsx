import { describe, expect, it, beforeEach } from 'vitest';
import { __resetRegistry, getNavSections, getRoutes } from '../../../lib/nav/registry.js';
import { registerFinanceDomain } from '../register.js';

describe('finance domain registration', () => {
  beforeEach(() => __resetRegistry());

  it('registers a finance nav section in the finance order band (40s)', () => {
    registerFinanceDomain();
    const section = getNavSections().find((s) => s.id === 'finance');
    expect(section).toBeDefined();
    expect(section!.order).toBeGreaterThanOrEqual(40);
    expect(section!.order).toBeLessThan(50);
    expect(section!.items.map((i) => i.to)).toEqual(['/finance', '/finance/invoices']);
  });

  it('registers /finance routes with permission gates', () => {
    registerFinanceDomain();
    const byPath = Object.fromEntries(getRoutes().filter((r) => r.path.startsWith('/finance')).map((r) => [r.path, r.permission]));
    expect(byPath['/finance']).toBe('billing:report');
    expect(byPath['/finance/invoices']).toBe('billing:read');
    expect(byPath['/finance/invoices/new']).toBe('invoice:create');
    expect(byPath['/finance/invoices/:id']).toBe('billing:read');
  });

  it('gates every finance nav item with a permission', () => {
    registerFinanceDomain();
    const section = getNavSections().find((s) => s.id === 'finance')!;
    expect(section.items.every((i) => typeof i.permission === 'string')).toBe(true);
  });
});
