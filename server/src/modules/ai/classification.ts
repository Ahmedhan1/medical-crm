/**
 * AI data classification (program Phase 3 / this increment).
 *
 * A single, explicit vocabulary for how sensitive a piece of data is, so
 * routing and policy decisions never rely on a developer remembering which
 * field is sensitive. Classification applies to AI inputs, outputs, retrieved
 * context, documents and messages alike.
 *
 * Ordered least→most sensitive; the ordinal drives policy comparisons.
 */
export const DataClass = {
  PUBLIC: 'public',
  INTERNAL: 'internal',
  OPERATIONAL: 'operational',
  SENSITIVE: 'sensitive',
  PHI: 'phi',
  HIGHLY_RESTRICTED: 'highly_restricted',
} as const;

export type DataClass = (typeof DataClass)[keyof typeof DataClass];

const SEVERITY: Record<DataClass, number> = {
  [DataClass.PUBLIC]: 0,
  [DataClass.INTERNAL]: 1,
  [DataClass.OPERATIONAL]: 2,
  [DataClass.SENSITIVE]: 3,
  [DataClass.PHI]: 4,
  [DataClass.HIGHLY_RESTRICTED]: 5,
};

export function severity(cls: DataClass): number {
  return SEVERITY[cls];
}

/** Parse an untrusted string into a DataClass, or null if unrecognised. */
export function parseDataClass(value: string): DataClass | null {
  return (Object.values(DataClass) as string[]).includes(value) ? (value as DataClass) : null;
}

/** True if `a` is at least as sensitive as `b`. */
export function atLeastAsSensitive(a: DataClass, b: DataClass): boolean {
  return severity(a) >= severity(b);
}

/**
 * The classification of an AI capability's INPUT. These capabilities all operate
 * on patient-linked clinical content, so their inputs are PHI by construction —
 * classification is intrinsic to the capability, not guessed from the text. New
 * capabilities must declare their input class here rather than defaulting.
 */
export type AiCapability = 'intake_extraction' | 'summary' | 'transcription';

const CAPABILITY_INPUT_CLASS: Record<AiCapability, DataClass> = {
  intake_extraction: DataClass.PHI, // free-text symptoms/history about a patient
  summary: DataClass.PHI, // longitudinal patient history
  transcription: DataClass.PHI, // clinical voice note
};

export function classifyCapabilityInput(capability: AiCapability): DataClass {
  return CAPABILITY_INPUT_CLASS[capability];
}
