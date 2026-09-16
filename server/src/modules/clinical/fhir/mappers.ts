/**
 * FHIR R4 mapping foundation (Agent 2 — clinical interoperability boundary).
 *
 * PURE functions: internal MEDCORE domain object → FHIR-shaped plain object.
 * No I/O, no clock, no logging, deterministic (all timestamps/ids pass through
 * from the input). Terminology this system does not own (drug, allergen,
 * ICD/SNOMED systems) is passed through verbatim — codes are never invented; a
 * record with no code emits only `text`.
 *
 * These are an INTERNAL contract, not a product API. Do not expose raw FHIR
 * through product endpoints.
 */
import type { Patient } from '../../identity/patients.repo.js';
import type { Encounter } from '../encounter.repo.js';
import type { Observation } from '../observations.service.js';
import type { Allergy } from '../allergies.service.js';
import type { Prescription } from '../prescriptions.service.js';
import type { Diagnosis } from '../encounter.clinical.repo.js';
import type { Referral } from '../referrals.service.js';
import type { Procedure } from '../procedures.service.js';
import type { CarePlan } from '../care-plans.service.js';
import type {
  FhirAllergyIntolerance, FhirCarePlan, FhirCondition, FhirEncounter, FhirMedicationRequest,
  FhirObservation, FhirPatient, FhirProcedure, FhirServiceRequest,
} from './types.js';

const ref = (type: string, id: string) => ({ reference: `${type}/${id}` });
const cc = (text: string, system?: string | null, code?: string | null) =>
  code ? { coding: [{ system: system ?? undefined, code }], text } : { text };

// -- Patient -----------------------------------------------------------------
// status active/inactive -> active true; deceased/merged -> active false.
export function toFhirPatient(p: Patient): FhirPatient {
  const telecom: { system: 'phone' | 'email'; value: string }[] = [];
  if (p.phone) telecom.push({ system: 'phone', value: p.phone });
  if (p.email) telecom.push({ system: 'email', value: p.email });
  const out: FhirPatient = {
    resourceType: 'Patient',
    id: p.id,
    identifier: [{ system: 'urn:medcore:mrn', value: p.mrn }],
    name: [{ text: p.fullName }],
    gender: p.sex,
    active: p.status === 'active' || p.status === 'inactive',
  };
  if (p.birthDate) out.birthDate = p.birthDate;
  if (p.status === 'deceased') { if (p.deceasedDate) out.deceasedDateTime = p.deceasedDate; else out.deceasedBoolean = true; }
  if (telecom.length) out.telecom = telecom;
  if (p.preferredLanguage) out.communication = [{ language: { text: p.preferredLanguage } }];
  return out;
}

// -- Encounter ---------------------------------------------------------------
const ENCOUNTER_STATUS: Record<string, string> = {
  checked_in: 'arrived', intake: 'in-progress', ready: 'in-progress',
  in_progress: 'in-progress', completed: 'finished', cancelled: 'cancelled',
};
export function toFhirEncounter(e: Encounter): FhirEncounter {
  return {
    resourceType: 'Encounter',
    id: e.id,
    status: ENCOUNTER_STATUS[e.status] ?? 'unknown',
    subject: ref('Patient', e.patientId),
    period: { start: e.checkedInAt },
  };
}

// -- Observation -------------------------------------------------------------
export function toFhirObservation(o: Observation): FhirObservation {
  const out: FhirObservation = {
    resourceType: 'Observation',
    id: o.id,
    status: 'final',
    code: { text: o.definitionKey },
    subject: ref('Patient', o.patientId),
    effectiveDateTime: o.performedAt,
  };
  if (o.encounterId) out.encounter = ref('Encounter', o.encounterId);
  if (o.valueNumber !== null && o.valueNumber !== undefined) out.valueQuantity = { value: o.valueNumber, unit: o.unit ?? undefined };
  else if (o.valueText !== null && o.valueText !== undefined) out.valueString = o.valueText;
  else if (o.valueBoolean !== null && o.valueBoolean !== undefined) out.valueBoolean = o.valueBoolean;
  else if (o.valueCode !== null && o.valueCode !== undefined) out.valueCodeableConcept = { text: o.valueCode };
  if (o.isAbnormal === true) out.interpretation = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'A' }], text: 'Abnormal' }];
  return out;
}

// -- AllergyIntolerance ------------------------------------------------------
const ALLERGY_CLINICAL: Record<string, string> = { active: 'active', inactive: 'inactive', resolved: 'resolved', entered_in_error: 'inactive' };
const ALLERGY_VERIFICATION: Record<string, string> = { unconfirmed: 'unconfirmed', confirmed: 'confirmed', refuted: 'refuted' };
const ALLERGY_CRITICALITY: Record<string, string> = { mild: 'low', moderate: 'low', severe: 'high', life_threatening: 'high' };
export function toFhirAllergyIntolerance(a: Allergy): FhirAllergyIntolerance {
  const out: FhirAllergyIntolerance = {
    resourceType: 'AllergyIntolerance',
    id: a.id,
    clinicalStatus: cc(ALLERGY_CLINICAL[a.status] ?? a.status),
    verificationStatus: cc(a.status === 'entered_in_error' ? 'entered-in-error' : (ALLERGY_VERIFICATION[a.verification] ?? a.verification)),
    type: a.kind,
    category: [a.category],
    criticality: ALLERGY_CRITICALITY[a.severity] ?? undefined,
    code: cc(a.substance, a.substanceRef ? 'urn:medcore:allergen' : null, a.substanceRef),
    patient: ref('Patient', a.patientId),
  };
  if (a.onsetDate) out.onsetDateTime = a.onsetDate;
  if (a.reaction) out.reaction = [{ manifestation: [{ text: a.reaction }], severity: a.severity === 'mild' ? 'mild' : a.severity === 'moderate' ? 'moderate' : 'severe' }];
  return out;
}

// -- MedicationRequest (one per prescription item) ---------------------------
const RX_STATUS: Record<string, string> = { active: 'active', cancelled: 'cancelled' };
export function toFhirMedicationRequests(p: Prescription): FhirMedicationRequest[] {
  return p.items.map((item) => {
    const out: FhirMedicationRequest = {
      resourceType: 'MedicationRequest',
      id: `${p.id}:${item.lineNo}`,
      status: RX_STATUS[p.status] ?? p.status,
      intent: 'order',
      medicationCodeableConcept: cc(item.medicationName, item.medicationRef ? 'urn:medcore:medication' : null, item.medicationRef),
      subject: ref('Patient', p.patientId),
      authoredOn: p.issuedAt,
      requester: ref('Practitioner', p.prescriberId),
      dosageInstruction: [{
        text: [item.dose, item.frequency, item.durationDays ? `for ${item.durationDays} days` : null].filter(Boolean).join(' — ') || undefined,
        route: cc(item.route),
      }],
    };
    if (p.encounterId) out.encounter = ref('Encounter', p.encounterId);
    return out;
  });
}

// -- Condition (from Diagnosis) ----------------------------------------------
const DX_CLINICAL: Record<string, string> = { active: 'active', resolved: 'resolved', ruled_out: 'inactive' };
const DX_VERIFICATION: Record<string, string> = { suspected: 'provisional', probable: 'provisional', confirmed: 'confirmed' };
export function toFhirCondition(d: Diagnosis): FhirCondition {
  const out: FhirCondition = {
    resourceType: 'Condition',
    id: d.id,
    clinicalStatus: cc(DX_CLINICAL[d.status] ?? d.status),
    verificationStatus: cc(d.status === 'ruled_out' ? 'refuted' : (DX_VERIFICATION[d.certainty] ?? 'unconfirmed')),
    category: [cc(d.category)],
    code: cc(d.description, d.codeSystem, d.code),
    subject: ref('Patient', d.patientId),
    encounter: ref('Encounter', d.encounterId),
  };
  if (d.onsetDate) out.onsetDateTime = d.onsetDate;
  return out;
}

// -- ServiceRequest (from Referral) ------------------------------------------
const REFERRAL_STATUS: Record<string, string> = {
  draft: 'draft', ordered: 'active', sent: 'active', accepted: 'active',
  scheduled: 'active', completed: 'completed', cancelled: 'revoked',
  declined: 'revoked', expired: 'revoked',
};
export function toFhirServiceRequest(r: Referral): FhirServiceRequest {
  const out: FhirServiceRequest = {
    resourceType: 'ServiceRequest',
    id: r.id,
    status: REFERRAL_STATUS[r.status] ?? 'unknown',
    intent: 'order',
    priority: r.urgency === 'emergency' ? 'stat' : r.urgency === 'urgent' ? 'urgent' : 'routine',
    subject: ref('Patient', r.patientId),
    reasonCode: [{ text: r.reason }],
  };
  if (r.receivingSpecialty) out.code = { text: r.receivingSpecialty };
  if (r.originEncounterId) out.encounter = ref('Encounter', r.originEncounterId);
  return out;
}

// -- Procedure ---------------------------------------------------------------
const PROC_STATUS: Record<string, string> = {
  planned: 'preparation', in_progress: 'in-progress', completed: 'completed',
  not_done: 'not-done', entered_in_error: 'entered-in-error',
};
export function toFhirProcedure(p: Procedure): FhirProcedure {
  const out: FhirProcedure = {
    resourceType: 'Procedure',
    id: p.id,
    status: PROC_STATUS[p.status] ?? 'unknown',
    code: cc(p.name, p.codeSystem, p.code),
    subject: ref('Patient', p.patientId),
  };
  if (p.encounterId) out.encounter = ref('Encounter', p.encounterId);
  if (p.performedAt) out.performedDateTime = p.performedAt;
  if (p.bodySite) out.bodySite = [{ text: p.bodySite }];
  if (p.outcome) out.outcome = { text: p.outcome };
  return out;
}

// -- CarePlan ----------------------------------------------------------------
const CAREPLAN_STATUS: Record<string, string> = {
  draft: 'draft', active: 'active', on_hold: 'on-hold', completed: 'completed', revoked: 'revoked',
};
export function toFhirCarePlan(c: CarePlan): FhirCarePlan {
  const out: FhirCarePlan = {
    resourceType: 'CarePlan',
    id: c.id,
    status: CAREPLAN_STATUS[c.status] ?? 'unknown',
    intent: c.intent === 'proposal' ? 'proposal' : c.intent === 'order' ? 'order' : 'plan',
    title: c.title,
    subject: ref('Patient', c.patientId),
    period: { start: c.periodStart, end: c.periodEnd ?? undefined },
  };
  if (c.description) out.description = c.description;
  return out;
}
