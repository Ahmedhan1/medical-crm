import { ValidationError } from '../../domain/errors.js';

/**
 * PHARMA DATA FIREWALL — input side (blueprint §45).
 *
 * The structural half of the firewall is the schema: no pharma table has a
 * foreign key to `patient` or `encounter`, and no pharma query joins a clinical
 * table. But pharma records carry free text written by humans in the field
 * (call-report summaries, objections, scientific questions), and free text is
 * the one place a patient identifier could be copied into the commercial side
 * of the system by hand.
 *
 * These guards reject identifier-shaped tokens in pharma free text before it is
 * stored. They are deliberately conservative — a pharma note has no legitimate
 * reason to contain an MRN, a 14-digit national id, or a record UUID.
 */
const IDENTIFIER_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  // Medical record number as issued by the clinical core (`MRN-000042`).
  { kind: 'mrn', pattern: /\bMRN[-\s]?\d{3,}\b/i },
  // National-identifier-shaped runs (Egyptian national id is 14 digits).
  { kind: 'national_id', pattern: /(?<!\d)\d{11,20}(?!\d)/ },
  // A record identifier copied out of a clinical URL or screen.
  {
    kind: 'record_uuid',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  },
];

/**
 * Throw if `text` contains a patient-identifier-shaped token.
 *
 * `field` names the offending input so the caller gets an actionable 400 rather
 * than a generic rejection. The offending text itself is NEVER echoed back or
 * logged — that would defeat the purpose.
 */
export function assertNoPatientIdentifiers(field: string, text: string | null | undefined): void {
  if (!text) return;
  for (const { kind, pattern } of IDENTIFIER_PATTERNS) {
    if (pattern.test(text)) {
      throw new ValidationError(
        `${field} appears to contain a patient identifier (${kind}). ` +
          'Pharma records must never contain patient-identifiable data.',
        { field, detected: kind },
      );
    }
  }
}

/** Apply {@link assertNoPatientIdentifiers} to several fields at once. */
export function assertFreeTextClean(fields: Record<string, string | null | undefined>): void {
  for (const [field, value] of Object.entries(fields)) {
    assertNoPatientIdentifiers(field, value);
  }
}
