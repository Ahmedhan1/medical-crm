/**
 * Date-only helpers for the clinical domain.
 *
 * `pg` hydrates a Postgres `date` column into a JS `Date` at local midnight, so
 * serializing it straight to JSON yields a full timestamp
 * (`"1980-04-02T00:00:00.000Z"`) for a field that has no time and no timezone.
 * West of UTC that timestamp renders as the PREVIOUS day, which for a date of
 * birth is a patient-identification error, not a formatting nit.
 *
 * Every `date` column crossing the API boundary goes through `toIsoDate`.
 */

/** Render a `date` column as `YYYY-MM-DD`. Returns null for null. */
export function toIsoDate(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    // getUTC* because pg builds the Date from the date literal in UTC.
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // Already text (e.g. `date::text`, or a driver configured to pass through).
  return value.slice(0, 10);
}

/** Same as `toIsoDate` for values known to be non-null. */
export function toIsoDateRequired(value: string | Date): string {
  return toIsoDate(value)!;
}

/** Today in the clinic's calendar, as `YYYY-MM-DD`. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
