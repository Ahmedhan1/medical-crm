import type { Locale } from '../../lib/i18n/dictionaries.js';

const localeTag: Record<Locale, string> = { en: 'en-GB', ar: 'ar-EG' };

/**
 * Format an integer MINOR-unit amount (piastres/cents) as a localized currency
 * string. Display only — the backend is the source of truth and all arithmetic
 * stays server-side in integer minor units. Assumes 2 minor digits (EGP/USD…).
 */
export function formatMoney(minor: number, currency = 'EGP', locale: Locale = 'en'): string {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat(localeTag[locale], {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(major);
  } catch {
    // Unknown currency code → plain number with the code appended.
    return `${major.toFixed(2)} ${currency}`;
  }
}

/** Parse a major-unit string (e.g. "150.00") into integer minor units, or null. */
export function parseMoneyToMinor(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  const minor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(minor) ? minor : null;
}
