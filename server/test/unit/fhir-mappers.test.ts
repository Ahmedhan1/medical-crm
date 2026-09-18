import { describe, expect, it } from 'vitest';
import {
  toFhirAllergyIntolerance, toFhirCarePlan, toFhirCondition, toFhirEncounter,
  toFhirMedicationRequests, toFhirObservation, toFhirPatient, toFhirProcedure,
  toFhirServiceRequest,
} from '../../src/modules/clinical/fhir/mappers.js';
import { FHIR_RESOURCE_TYPES } from '../../src/modules/clinical/fhir/types.js';

const PID = '11111111-1111-1111-1111-111111111111';
const EID = '22222222-2222-2222-2222-222222222222';

describe('FHIR mappers — Patient', () => {
  const base = { id: PID, clinicId: 'c', mrn: 'MRN-000042', fullName: 'Jane Q', sex: 'female' as const, birthDate: '1985-06-15', phone: '+201000000001', nationalId: null, status: 'active' as const, deceasedDate: null, mergedIntoId: null, preferredLanguage: 'ar-EG', email: 'j@example.com', address: null, createdAt: 't' };
  it('maps identifiers, name, gender, telecom, language, active', () => {
    const f = toFhirPatient(base);
    expect(f.resourceType).toBe('Patient');
    expect(f.id).toBe(PID);
    expect(f.identifier).toEqual([{ system: 'urn:medcore:mrn', value: 'MRN-000042' }]);
    expect(f.name).toEqual([{ text: 'Jane Q' }]);
    expect(f.gender).toBe('female');
    expect(f.birthDate).toBe('1985-06-15');
    expect(f.telecom).toEqual(expect.arrayContaining([{ system: 'phone', value: '+201000000001' }, { system: 'email', value: 'j@example.com' }]));
    expect(f.communication?.[0]!.language.text).toBe('ar-EG');
    expect(f.active).toBe(true);
  });
  it('marks a deceased patient inactive with a datetime, a merged patient inactive', () => {
    expect(toFhirPatient({ ...base, status: 'deceased', deceasedDate: '2026-08-01' }).deceasedDateTime).toBe('2026-08-01');
    expect(toFhirPatient({ ...base, status: 'deceased', deceasedDate: '2026-08-01' }).active).toBe(false);
    expect(toFhirPatient({ ...base, status: 'merged', mergedIntoId: EID }).active).toBe(false);
  });
});

describe('FHIR mappers — status maps & references', () => {
  it('Encounter status maps and subject reference', () => {
    const f = toFhirEncounter({ id: EID, clinicId: 'c', patientId: PID, status: 'completed', checkedInAt: 't0' });
    expect(f.status).toBe('finished');
    expect(f.subject).toEqual({ reference: `Patient/${PID}` });
    expect(f.period?.start).toBe('t0');
  });

  it('Observation maps value[x] and abnormal interpretation', () => {
    const q = toFhirObservation({ id: 'o1', definitionId: 'd', definitionKey: 'pasi_score', patientId: PID, encounterId: EID, valueNumber: 22, valueText: null, valueBoolean: null, valueCode: null, unit: 'score', isAbnormal: true, performedAt: 't', source: 'staff', notes: null });
    expect(q.valueQuantity).toEqual({ value: 22, unit: 'score' });
    expect(q.encounter).toEqual({ reference: `Encounter/${EID}` });
    expect(q.interpretation?.[0]!.coding?.[0]!.code).toBe('A');
    const c = toFhirObservation({ id: 'o2', definitionId: 'd', definitionKey: 'skin_type', patientId: PID, encounterId: null, valueNumber: null, valueText: null, valueBoolean: null, valueCode: 'III', unit: null, isAbnormal: null, performedAt: 't', source: 'staff', notes: null });
    expect(c.valueCodeableConcept?.text).toBe('III');
    expect(c.encounter).toBeUndefined();
  });

  it('AllergyIntolerance maps status, criticality and passes through an opaque code only when present', () => {
    const f = toFhirAllergyIntolerance({ id: 'a1', patientId: PID, substance: 'Penicillin', substanceRef: null, kind: 'allergy', category: 'medication', reaction: 'rash', severity: 'severe', status: 'active', verification: 'confirmed', onsetDate: '2020-01-01', notes: null, createdAt: 't', updatedAt: 't' });
    expect(f.clinicalStatus.text).toBe('active');
    expect(f.verificationStatus.text).toBe('confirmed');
    expect(f.criticality).toBe('high');
    expect(f.code.text).toBe('Penicillin');
    expect(f.code.coding).toBeUndefined(); // no invented code system
    expect(f.patient).toEqual({ reference: `Patient/${PID}` });
  });

  it('MedicationRequest is one-per-item, passes route and dose, invents no drug code', () => {
    const reqs = toFhirMedicationRequests({ id: 'rx1', encounterId: EID, patientId: PID, prescriberId: 'doc', status: 'active', notes: null, issuedAt: 't', cancelledAt: null, cancelledBy: null, cancellationReason: null, items: [
      { id: 'i1', lineNo: 1, medicationName: 'Amoxicillin', medicationRef: null, dose: '500 mg', route: 'oral', frequency: 'tds', durationDays: 7, quantity: null, instructions: null },
      { id: 'i2', lineNo: 2, medicationName: 'Paracetamol', medicationRef: null, dose: '1 g', route: 'oral', frequency: 'prn', durationDays: null, quantity: null, instructions: null },
    ] });
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.id).toBe('rx1:1');
    expect(reqs[0]!.medicationCodeableConcept.text).toBe('Amoxicillin');
    expect(reqs[0]!.medicationCodeableConcept.coding).toBeUndefined();
    expect(reqs[0]!.dosageInstruction?.[0]!.text).toContain('for 7 days');
    expect(reqs[0]!.subject).toEqual({ reference: `Patient/${PID}` });
  });

  it('Condition passes through diagnosis code/system verbatim', () => {
    const f = toFhirCondition({ id: 'd1', encounterId: EID, patientId: PID, description: 'Acute pharyngitis', codeSystem: 'ICD-10', code: 'J02.9', category: 'primary', certainty: 'confirmed', status: 'active', onsetDate: null, recordedBy: 'x', createdAt: 't', updatedAt: 't' } as never);
    expect(f.code.coding!).toEqual([{ system: 'ICD-10', code: 'J02.9' }]);
    expect(f.clinicalStatus.text).toBe('active');
    expect(f.verificationStatus.text).toBe('confirmed');
  });

  it('ServiceRequest maps referral priority and status', () => {
    const f = toFhirServiceRequest({ id: 'r1', patientId: PID, originEncounterId: EID, referringPractitionerId: 'doc', direction: 'external', receivingPractitionerId: null, receivingProvider: 'X', receivingSpecialty: 'Cardiology', reason: 'chest pain', urgency: 'emergency', status: 'sent', dueDate: null, completedAt: null, closureReason: null, linkedAppointmentId: null, linkedDocumentId: null, notes: null, createdAt: 't' });
    expect(f.status).toBe('active');
    expect(f.priority).toBe('stat');
    expect(f.code?.text).toBe('Cardiology');
    expect(f.reasonCode?.[0]!.text).toBe('chest pain');
  });

  it('Procedure maps status and passes code through', () => {
    const f = toFhirProcedure({ id: 'p1', patientId: PID, encounterId: EID, episodeId: null, name: 'Wound suture', codeSystem: 'CPT', code: '12002', bodySite: 'left forearm', status: 'completed', performedBy: 'doc', performedAt: 't', outcome: 'closed', complication: null, notDoneReason: null, notes: null, createdAt: 't' });
    expect(f.status).toBe('completed');
    expect(f.code.coding!).toEqual([{ system: 'CPT', code: '12002' }]);
    expect(f.bodySite?.[0]!.text).toBe('left forearm');
    expect(f.outcome?.text).toBe('closed');
  });

  it('CarePlan maps status, intent and period', () => {
    const f = toFhirCarePlan({ id: 'cp1', patientId: PID, episodeId: null, originEncounterId: null, title: 'Diabetes management', description: 'plan', intent: 'plan', status: 'on_hold', periodStart: '2026-01-01', periodEnd: '2026-06-01', createdAt: 't' });
    expect(f.status).toBe('on-hold');
    expect(f.intent).toBe('plan');
    expect(f.title).toBe('Diabetes management');
    expect(f.period).toEqual({ start: '2026-01-01', end: '2026-06-01' });
  });
});

describe('FHIR mappers — determinism & registry', () => {
  it('is pure: same input yields identical output', () => {
    const enc = { id: EID, clinicId: 'c', patientId: PID, status: 'in_progress' as const, checkedInAt: 't' };
    expect(toFhirEncounter(enc)).toEqual(toFhirEncounter(enc));
  });
  it('lists the supported resource types', () => {
    expect(FHIR_RESOURCE_TYPES).toContain('Patient');
    expect(FHIR_RESOURCE_TYPES).toContain('CarePlan');
    expect(FHIR_RESOURCE_TYPES).toHaveLength(9);
  });
});
