import { ForbiddenError } from '../../domain/errors.js';

/**
 * STAGE 1 OF THE FIREWALL — classification.
 *
 * Nothing enters the intelligence pipeline unclassified. Each contribution
 * declares what kind of subject it describes, and the pipeline decides what may
 * proceed based on that declaration rather than on who is asking. This ordering
 * is the whole point: holding a pharma permission must never be what makes
 * patient data reachable (§45).
 */
export const DataClass = {
  /** A record that identifies a patient (directly or by a resolvable key). */
  PATIENT_IDENTIFIABLE: 'patient_identifiable',
  /**
   * A patient record whose direct identifiers were replaced by a key that still
   * exists somewhere. Pseudonymous is NOT anonymous — re-identification remains
   * possible for whoever holds the mapping, so pharma may not receive it either.
   */
  PATIENT_PSEUDONYMOUS: 'patient_pseudonymous',
  /** A professional fact about an HCP, or this company's engagement with them. */
  HCP_PROFESSIONAL: 'hcp_professional',
  /** A count over a cohort, with no individual recoverable. */
  AGGREGATE: 'aggregate',
  /** Published reference data (drug register, taxonomy). */
  PUBLIC_REFERENCE: 'public_reference',
} as const;
export type DataClass = (typeof DataClass)[keyof typeof DataClass];

/**
 * The only classes that may be fed into an intelligence run destined for pharma.
 * Patient classes are absent by construction, not by configuration: there is no
 * flag, role or policy value anywhere in this codebase that adds them.
 */
export const PHARMA_PERMITTED_CLASSES: ReadonlySet<DataClass> = new Set([
  DataClass.HCP_PROFESSIONAL,
  DataClass.AGGREGATE,
  DataClass.PUBLIC_REFERENCE,
]);

export function isPatientClass(dataClass: DataClass): boolean {
  return (
    dataClass === DataClass.PATIENT_IDENTIFIABLE || dataClass === DataClass.PATIENT_PSEUDONYMOUS
  );
}

/**
 * Reject a contribution whose class may not reach pharma.
 *
 * Deliberately independent of the caller's permissions — an ADMIN principal
 * gets the same refusal as a representative. Classification is a property of the
 * data, not of the requester.
 */
export function assertClassPermittedForPharma(dataClass: DataClass): void {
  if (!PHARMA_PERMITTED_CLASSES.has(dataClass)) {
    throw new ForbiddenError(
      `Data classified "${dataClass}" cannot enter a pharma intelligence signal. ` +
        'Patient-level data never crosses the clinical/commercial boundary (§45).',
    );
  }
}
