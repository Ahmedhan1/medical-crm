import { NotFoundError } from '../../domain/errors.js';
import { audit } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { hasPermission, requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById, type Patient } from '../identity/patients.repo.js';
import {
  listContacts,
  listIdentifiers,
  type PatientContact,
  type PatientIdentifier,
} from '../identity/patients.lifecycle.service.js';
import { listAllergies, type Allergy } from './allergies.service.js';
import { listPatientObservations, type Observation } from './observations.service.js';
import { getPatientAppointments, type ScheduleEntry } from './scheduling.service.js';
import { listPrescriptionsForPatient, type Prescription } from './prescriptions.service.js';
import { listPatientDocuments, type DocumentReference } from './documents.service.js';
import { listEpisodes, type TreatmentEpisode } from './episodes.service.js';
import { listFollowUpsForPatient, type FollowUp } from './followups.service.js';
import { listPreviousVisits, type PreviousVisit } from './workspace.service.js';
import { todayIso } from './dates.js';

/**
 * Patient 360 (Phase 16) — a read-only VIEW MODEL, never a second source of
 * truth. It composes the existing permission-checked readers into one summary;
 * it introduces no table and duplicates no query. Each section is included only
 * if the caller holds the relevant read permission (the same shape as the
 * encounter workspace), so a reception 360 and a doctor 360 differ by content,
 * not by a filter applied after the fact — an omitted section never implies the
 * caller was allowed to see it.
 */
export interface Patient360 {
  patient: {
    id: string;
    mrn: string;
    fullName: string;
    sex: string;
    birthDate: string | null;
    status: Patient['status'];
    preferredLanguage: string | null;
    phone: string | null;
    email: string | null;
    /** Set when this record was merged into another; the caller should redirect. */
    mergedIntoId: string | null;
  };
  identifiers?: PatientIdentifier[];
  contacts?: PatientContact[];
  allergies?: Allergy[];
  recentObservations?: Observation[];
  upcomingAppointments?: ScheduleEntry[];
  recentVisits?: PreviousVisit[];
  activePrescriptions?: Prescription[];
  documents?: DocumentReference[];
  treatmentEpisodes?: TreatmentEpisode[];
  openFollowUps?: FollowUp[];
}

/** Best-effort section load: a section the caller may see, or undefined. */
async function section<T>(
  principal: Principal,
  permission: Permission,
  load: () => Promise<T>,
): Promise<T | undefined> {
  if (!hasPermission(principal, permission)) return undefined;
  return load();
}

export async function getPatient360(
  principal: Principal,
  patientId: string,
): Promise<Patient360> {
  requirePermission(principal, Permission.PATIENT_READ);

  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const [
    identifiers,
    contacts,
    allergies,
    recentObservations,
    upcomingAppointments,
    recentVisits,
    activePrescriptions,
    documents,
    treatmentEpisodes,
    openFollowUps,
  ] = await Promise.all([
    section(principal, Permission.PATIENT_IDENTIFIER_READ, () =>
      listIdentifiers(principal, patient.id),
    ),
    section(principal, Permission.PATIENT_CONTACT_READ, () =>
      listContacts(principal, patient.id),
    ),
    section(principal, Permission.ALLERGY_READ, () => listAllergies(principal, patient.id)),
    section(principal, Permission.OBSERVATION_READ, () =>
      listPatientObservations(principal, patient.id, { limit: 20 }),
    ),
    section(principal, Permission.APPOINTMENT_READ, () =>
      // Upcoming only: from the start of today, still-live statuses.
      getPatientAppointments(principal, patient.id, { from: `${todayIso()}T00:00:00.000Z` }).then(
        (rows) => rows.filter((a) => ['scheduled', 'confirmed'].includes(a.status)).slice(0, 10),
      ),
    ),
    section(principal, Permission.ENCOUNTER_READ, () =>
      listPreviousVisits(principal.clinicId, patient.id, null, 10),
    ),
    section(principal, Permission.PRESCRIPTION_READ, () =>
      listPrescriptionsForPatient(principal, patient.id, { status: 'active', limit: 20 }),
    ),
    section(principal, Permission.DOCUMENT_READ, () =>
      listPatientDocuments(principal, patient.id, { limit: 20 }),
    ),
    section(principal, Permission.TREATMENT_EPISODE_READ, () =>
      listEpisodes(principal, patient.id, { limit: 20 }),
    ),
    section(principal, Permission.FOLLOWUP_READ, () =>
      listFollowUpsForPatient(principal, patient.id, { status: 'scheduled', limit: 20 }),
    ),
  ]);

  // Reading a full patient summary is a high-value access; record it (no PHI).
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'patient.360.read',
    outcome: 'success',
    targetType: 'patient',
    targetId: patient.id,
    metadata: { sections: sectionNames({ identifiers, contacts, allergies, recentObservations, upcomingAppointments, recentVisits, activePrescriptions, documents, treatmentEpisodes, openFollowUps }) },
  });

  const view: Patient360 = {
    patient: {
      id: patient.id,
      mrn: patient.mrn,
      fullName: patient.fullName,
      sex: patient.sex,
      birthDate: patient.birthDate,
      status: patient.status,
      preferredLanguage: patient.preferredLanguage,
      phone: patient.phone,
      email: patient.email,
      mergedIntoId: patient.mergedIntoId,
    },
  };
  if (identifiers !== undefined) view.identifiers = identifiers;
  if (contacts !== undefined) view.contacts = contacts;
  if (allergies !== undefined) view.allergies = allergies;
  if (recentObservations !== undefined) view.recentObservations = recentObservations;
  if (upcomingAppointments !== undefined) view.upcomingAppointments = upcomingAppointments;
  if (recentVisits !== undefined) view.recentVisits = recentVisits;
  if (activePrescriptions !== undefined) view.activePrescriptions = activePrescriptions;
  if (documents !== undefined) view.documents = documents;
  if (treatmentEpisodes !== undefined) view.treatmentEpisodes = treatmentEpisodes;
  if (openFollowUps !== undefined) view.openFollowUps = openFollowUps;
  return view;
}

/** The names of the sections the caller was allowed to see — for the audit row. */
function sectionNames(sections: Record<string, unknown>): string[] {
  return Object.entries(sections)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
}
