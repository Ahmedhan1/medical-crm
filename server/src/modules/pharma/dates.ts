/**
 * Calendar-date handling for pharma records.
 *
 * `pg` decodes a Postgres `date` column into a JavaScript `Date` at local
 * midnight. That is the wrong shape for a calendar date in two ways: comparing
 * it against a `YYYY-MM-DD` string silently yields `false` (which would defeat
 * an expiry check), and serialising it with `toISOString()` can shift the day
 * across a timezone boundary.
 *
 * Every mapper that reads a `date` column therefore normalises it here, so a
 * calendar date is a `YYYY-MM-DD` string everywhere above the repository layer —
 * comparable, serialisable and timezone-free. Timestamps (`timestamptz`) are a
 * different thing and keep their instant semantics.
 */
export function toDateString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  // Local components: the Date was decoded at local midnight for this calendar
  // day, so reading it back in UTC could move it to the previous day.
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Today as a calendar date in the server's timezone. */
export function today(): string {
  return toDateString(new Date())!;
}
