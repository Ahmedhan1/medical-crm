/**
 * FHIR R4 REST interoperability service (Agent 3).
 *
 * This is the GOVERNED interoperability surface the platform exposes. It does
 * not re-implement clinical logic and it does not bypass clinical security:
 *   - every entry point requires `fhir:read` (who may use interop at all), AND
 *   - it loads data ONLY through the existing permission-checked clinical
 *     services, so the caller also needs the underlying clinical read
 *     permission and every load is tenant-scoped by those services;
 *   - it maps to FHIR through the existing PURE mappers (deterministic, no PHI
 *     invented, terminology passed through);
 *   - it audits every access.
 *
 * It returns read-only resources (no create/update) — the safest interop
 * posture — as individual resources or `searchset` Bundles.
 */
import { getPool } from '../../../db/pool.js';
import { ForbiddenError, NotFoundError } from '../../../domain/errors.js';
import { audit } from '../../governance/audit.js';
import { Permission } from '../../governance/permissions.js';
import { hasPermission, requirePermission, type Principal } from '../../governance/rbac.js';
import { getPatient, findPatients } from '../../identity/patients.service.js';
import { listAllergies } from '../allergies.service.js';
import { listPatientObservations } from '../observations.service.js';
import { listPrescriptionsForPatient } from '../prescriptions.service.js';
import { listPatientProcedures } from '../procedures.service.js';
import { listPatientCarePlans } from '../care-plans.service.js';
import { listPatientReferrals } from '../referrals.service.js';
import {
  toFhirAllergyIntolerance, toFhirCarePlan, toFhirMedicationRequests, toFhirObservation,
  toFhirPatient, toFhirProcedure, toFhirServiceRequest,
} from './mappers.js';
import type { FhirResourceBase } from './types.js';

export interface FhirBundle {
  resourceType: 'Bundle';
  type: 'searchset';
  total: number;
  entry: { resource: FhirResourceBase }[];
}
export interface FhirOrganization extends FhirResourceBase {
  resourceType: 'Organization';
  name: string;
  active: boolean;
}
export interface FhirOperationOutcome {
  resourceType: 'OperationOutcome';
  issue: { severity: 'error' | 'warning'; code: string; diagnostics?: string }[];
}

const bundle = (resources: FhirResourceBase[]): FhirBundle => ({
  resourceType: 'Bundle', type: 'searchset', total: resources.length,
  entry: resources.map((resource) => ({ resource })),
});

async function auditFhir(p: Principal, resourceType: string, targetId: string | null): Promise<void> {
  await audit({
    clinicId: p.clinicId, actorId: p.userId, action: 'fhir.read', outcome: 'success',
    targetType: resourceType, targetId, metadata: { resourceType },
  });
}

/** A patient-scoped section, loaded only if the caller holds the read perm. */
async function section<T>(
  p: Principal, permission: Permission, load: () => Promise<T[]>,
): Promise<T[]> {
  if (!hasPermission(p, permission)) return [];
  return load();
}

// -- Patient -----------------------------------------------------------------
export async function fhirReadPatient(p: Principal, id: string): Promise<FhirResourceBase> {
  requirePermission(p, Permission.FHIR_READ);
  const patient = await getPatient(p, id); // enforces PATIENT_READ + tenant scope
  await auditFhir(p, 'Patient', id);
  return toFhirPatient(patient);
}

export async function fhirSearchPatients(
  p: Principal, params: { identifier?: string; name?: string },
): Promise<FhirBundle> {
  requirePermission(p, Permission.FHIR_READ);
  const query = (params.identifier ?? params.name ?? '').trim();
  const patients = query.length >= 2 ? await findPatients(p, query) : [];
  await auditFhir(p, 'Patient', null);
  return bundle(patients.map(toFhirPatient));
}

// -- Patient/$everything -----------------------------------------------------
/** A compartment Bundle: the patient plus the clinical resources the caller is
 * allowed to see, each loaded through its own permission-checked service. */
export async function fhirPatientEverything(p: Principal, id: string): Promise<FhirBundle> {
  requirePermission(p, Permission.FHIR_READ);
  const patient = await getPatient(p, id);
  const [allergies, observations, prescriptions, procedures, carePlans, referrals] = await Promise.all([
    section(p, Permission.ALLERGY_READ, () => listAllergies(p, id)),
    section(p, Permission.OBSERVATION_READ, () => listPatientObservations(p, id, {})),
    section(p, Permission.PRESCRIPTION_READ, () => listPrescriptionsForPatient(p, id, {})),
    section(p, Permission.PROCEDURE_READ, () => listPatientProcedures(p, id, {})),
    section(p, Permission.CARE_PLAN_READ, () => listPatientCarePlans(p, id, {})),
    section(p, Permission.REFERRAL_READ, () => listPatientReferrals(p, id)),
  ]);
  const resources: FhirResourceBase[] = [
    toFhirPatient(patient),
    ...allergies.map(toFhirAllergyIntolerance),
    ...observations.map(toFhirObservation),
    ...prescriptions.flatMap(toFhirMedicationRequests),
    ...procedures.map(toFhirProcedure),
    ...carePlans.map(toFhirCarePlan),
    ...referrals.map(toFhirServiceRequest),
  ];
  await auditFhir(p, 'Patient.$everything', id);
  return bundle(resources);
}

// -- Per-resource patient-scoped search --------------------------------------
export type PatientCompartmentResource =
  'AllergyIntolerance' | 'Observation' | 'MedicationRequest' | 'Procedure' | 'CarePlan' | 'ServiceRequest';

export async function fhirSearchByPatient(
  p: Principal, resourceType: PatientCompartmentResource, patientId: string,
): Promise<FhirBundle> {
  requirePermission(p, Permission.FHIR_READ);
  // Confirm the patient exists in this clinic before loading (tenant scope +
  // a clean 404 rather than an empty bundle for a foreign id).
  await getPatient(p, patientId);
  let resources: FhirResourceBase[];
  switch (resourceType) {
    case 'AllergyIntolerance':
      resources = (await listAllergies(p, patientId)).map(toFhirAllergyIntolerance); break;
    case 'Observation':
      resources = (await listPatientObservations(p, patientId, {})).map(toFhirObservation); break;
    case 'MedicationRequest':
      resources = (await listPrescriptionsForPatient(p, patientId, {})).flatMap(toFhirMedicationRequests); break;
    case 'Procedure':
      resources = (await listPatientProcedures(p, patientId, {})).map(toFhirProcedure); break;
    case 'CarePlan':
      resources = (await listPatientCarePlans(p, patientId, {})).map(toFhirCarePlan); break;
    case 'ServiceRequest':
      resources = (await listPatientReferrals(p, patientId)).map(toFhirServiceRequest); break;
  }
  await auditFhir(p, resourceType, null);
  return bundle(resources);
}

// -- Organization (the clinic) -----------------------------------------------
export async function fhirReadOrganization(p: Principal, id: string): Promise<FhirOrganization> {
  requirePermission(p, Permission.FHIR_READ);
  // A clinic may only resolve its OWN organization resource.
  if (id !== p.clinicId) throw new ForbiddenError('Organization is outside your clinic scope');
  const { rows } = await getPool().query<{ id: string; name: string }>(
    'SELECT id, name FROM clinic WHERE id=$1', [id],
  );
  if (rows.length === 0) throw new NotFoundError('Organization');
  await auditFhir(p, 'Organization', id);
  return { resourceType: 'Organization', id: rows[0]!.id, name: rows[0]!.name, active: true };
}

// -- CapabilityStatement -----------------------------------------------------
export function fhirCapabilityStatement(): Record<string, unknown> {
  return {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: new Date().toISOString(),
    kind: 'instance',
    fhirVersion: '4.0.1',
    format: ['application/fhir+json'],
    rest: [{
      mode: 'server',
      security: { description: 'Bearer token; requires the fhir:read permission plus the relevant clinical read permission.' },
      resource: [
        { type: 'Patient', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'identifier', type: 'token' }, { name: 'name', type: 'string' }], operation: [{ name: 'everything' }] },
        { type: 'AllergyIntolerance', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }] },
        { type: 'Observation', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }] },
        { type: 'MedicationRequest', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }] },
        { type: 'Procedure', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }] },
        { type: 'CarePlan', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }] },
        { type: 'ServiceRequest', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }] },
        { type: 'Organization', interaction: [{ code: 'read' }] },
      ],
    }],
  };
}

export function operationOutcome(severity: 'error' | 'warning', code: string, diagnostics: string): FhirOperationOutcome {
  return { resourceType: 'OperationOutcome', issue: [{ severity, code, diagnostics }] };
}
