import type { Locale } from '../i18n/dictionaries.js';

/**
 * Locale-aware date/time formatting via the platform `Intl` API (no dependency).
 * Arabic uses the Gregorian calendar with Arabic digits by default, matching how
 * Egyptian/Gulf clinics record clinical dates; a deployment can override later.
 */
const localeTag: Record<Locale, string> = { en: 'en-GB', ar: 'ar-EG' };

function toDate(value: string | number | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(value: string | number | Date, locale: Locale = 'en'): string {
  const d = toDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat(localeTag[locale], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(d);
}

export function formatDateTime(value: string | number | Date, locale: Locale = 'en'): string {
  const d = toDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat(localeTag[locale], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function formatNumber(value: number, locale: Locale = 'en'): string {
  return new Intl.NumberFormat(localeTag[locale]).format(value);
}
