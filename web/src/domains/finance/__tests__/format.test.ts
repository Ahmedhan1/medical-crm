import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoneyToMinor } from '../format.js';

describe('finance format — parseMoneyToMinor', () => {
  it('parses major-unit strings to integer minor units', () => {
    expect(parseMoneyToMinor('150')).toBe(15000);
    expect(parseMoneyToMinor('150.5')).toBe(15050);
    expect(parseMoneyToMinor('150.55')).toBe(15055);
    expect(parseMoneyToMinor('0')).toBe(0);
  });
  it('rejects invalid, negative or over-precise input', () => {
    expect(parseMoneyToMinor('')).toBeNull();
    expect(parseMoneyToMinor('-5')).toBeNull();
    expect(parseMoneyToMinor('1.234')).toBeNull();
    expect(parseMoneyToMinor('abc')).toBeNull();
  });
});

describe('finance format — formatMoney', () => {
  it('formats minor units as currency (2 dp)', () => {
    const s = formatMoney(15055, 'EGP', 'en');
    expect(s).toMatch(/150[.,]55/);
  });
  it('never divides into floating cents in the stored value (display only)', () => {
    // Round-trip: parse then format keeps the value.
    const minor = parseMoneyToMinor('49.99');
    expect(minor).toBe(4999);
    expect(formatMoney(minor!, 'USD', 'en')).toMatch(/49[.,]99/);
  });
});
