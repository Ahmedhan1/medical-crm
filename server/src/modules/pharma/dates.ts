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

/**
 * Whether a dated claim is in force on a given day.
 *
 * `hcp_credential` (0306) carries `valid_from` / `valid_to` and nothing read
 * them: a board certification that lapsed in 2019 was returned looking exactly
 * like one renewed last month, so a rep could cite it and a report could count
 * it. This is the same shape of answer the rest of the domain already derives —
 * `pharma_effective_verification`, `pharma_effective_signal_status`, the SLA
 * breach flag — computed rather than stored, so it is true without a sweep.
 *
 * Kept deliberately separate from VERIFICATION status: a credential can be
 * verified and expired at once (we checked it, and it has since lapsed), and
 * collapsing the two would lose that distinction.
 */
export type ValidityState = 'in_force' | 'not_yet_effective' | 'expired' | 'undated';

export function validityOn(
  validFrom: string | null,
  validTo: string | null,
  onDate: string = today(),
): ValidityState {
  if (validFrom === null && validTo === null) return 'undated';
  if (validFrom !== null && validFrom > onDate) return 'not_yet_effective';
  if (validTo !== null && validTo < onDate) return 'expired';
  return 'in_force';
}
