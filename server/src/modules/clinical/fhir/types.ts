/**
 * Minimal FHIR R4 resource shapes — a hand-written internal SUBSET, only the
 * fields MEDCORE populates at the mapping boundary. This is NOT the full spec
 * and is deliberately dependency-free (no FHIR library). Product APIs must not
 * expose these directly; they exist so an interoperability boundary can be
 * built on a stable internal contract.
 */
export interface FhirCoding { system?: string; code?: string; display?: string; }
export interface FhirCodeableConcept { coding?: FhirCoding[]; text?: string; }
export interface FhirReference { reference: string; display?: string; }
export interface FhirIdentifier { system?: string; value: string; }
export interface FhirPeriod { start?: string; end?: string; }

export interface FhirResourceBase { resourceType: string; id: string; }

export interface FhirPatient extends FhirResourceBase {
  resourceType: 'Patient';
  identifier?: FhirIdentifier[];
  name?: { text: string }[];
  gender?: 'male' | 'female' | 'other' | 'unknown';
  birthDate?: string;
  deceasedDateTime?: string;
  deceasedBoolean?: boolean;
  telecom?: { system: 'phone' | 'email'; value: string }[];
  communication?: { language: FhirCodeableConcept }[];
  active: boolean;
}
export interface FhirEncounter extends FhirResourceBase {
  resourceType: 'Encounter';
  status: string;
  subject: FhirReference;
  period?: FhirPeriod;
}
export interface FhirObservation extends FhirResourceBase {
  resourceType: 'Observation';
  status: string;
  code: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  effectiveDateTime?: string;
  valueQuantity?: { value: number; unit?: string };
  valueString?: string;
  valueBoolean?: boolean;
  valueCodeableConcept?: FhirCodeableConcept;
  interpretation?: FhirCodeableConcept[];
}
export interface FhirAllergyIntolerance extends FhirResourceBase {
  resourceType: 'AllergyIntolerance';
  clinicalStatus: FhirCodeableConcept;
  verificationStatus: FhirCodeableConcept;
  type?: 'allergy' | 'intolerance';
  category?: string[];
  criticality?: string;
  code: FhirCodeableConcept;
  patient: FhirReference;
  onsetDateTime?: string;
  reaction?: { manifestation: FhirCodeableConcept[]; severity?: string }[];
}
export interface FhirMedicationRequest extends FhirResourceBase {
  resourceType: 'MedicationRequest';
  status: string;
  intent: string;
  medicationCodeableConcept: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  authoredOn?: string;
  requester?: FhirReference;
  dosageInstruction?: { text?: string; route?: FhirCodeableConcept; timing?: { code?: FhirCodeableConcept } }[];
}
export interface FhirCondition extends FhirResourceBase {
  resourceType: 'Condition';
  clinicalStatus: FhirCodeableConcept;
  verificationStatus: FhirCodeableConcept;
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  onsetDateTime?: string;
}
export interface FhirServiceRequest extends FhirResourceBase {
  resourceType: 'ServiceRequest';
  status: string;
  intent: string;
  priority?: string;
  code?: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  occurrenceDateTime?: string;
  reasonCode?: FhirCodeableConcept[];
}
export interface FhirProcedure extends FhirResourceBase {
  resourceType: 'Procedure';
  status: string;
  code: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  performedDateTime?: string;
  bodySite?: FhirCodeableConcept[];
  outcome?: FhirCodeableConcept;
}
export interface FhirCarePlan extends FhirResourceBase {
  resourceType: 'CarePlan';
  status: string;
  intent: string;
  title: string;
  description?: string;
  subject: FhirReference;
  period?: FhirPeriod;
}

export const FHIR_RESOURCE_TYPES = [
  'Patient', 'Encounter', 'Observation', 'AllergyIntolerance', 'MedicationRequest',
  'Condition', 'ServiceRequest', 'Procedure', 'CarePlan',
] as const;
export type FhirResourceType = (typeof FHIR_RESOURCE_TYPES)[number];
