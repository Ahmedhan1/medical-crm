import { api } from '../../../lib/api/client.js';

/**
 * Clinical domain API layer — thin, typed wrappers over the EXISTING backend
 * endpoints. Every call goes through the shared `api` client (bearer token,
 * `ApiError` normalization, 401 fail-closed, cancellation). No raw `fetch`, no
 * invented endpoints, and NO clinical decision logic — the backend is the sole
 * authority; these types only mirror what it returns.
 */

// --- Patients -------------------------------------------------------------
export type PatientSex = 'male' | 'female' | 'other' | 'unknown';
export type PatientStatus = 'active' | 'inactive' | 'deceased' | 'merged';

export interface PatientSummary {
  id: string;
  mrn: string;
  fullName: string;
  sex: PatientSex;
  birthDate: string | null;
  phone: string | null;
  status: PatientStatus;
  mergedIntoId?: string | null;
}

export interface RegisterPatientBody {
  fullName: string;
  sex: PatientSex;
  birthDate?: string;
  phone?: string;
  nationalId?: string;
  overrideDuplicate?: boolean;
}

export function searchPatients(query: string, signal?: AbortSignal): Promise<PatientSummary[]> {
  // The backend search is a GET whose query term is deliberately kept out of
  // request logs server-side (logLevel warn); we honour that existing contract.
  return api
    .get<{ results: PatientSummary[] }>('/patients/search', { query: { query }, signal })
    .then((r) => r.results);
}

export function registerPatient(body: RegisterPatientBody): Promise<PatientSummary> {
  return api.post<PatientSummary>('/patients', body);
}

// --- Patient 360 ----------------------------------------------------------
// The 360 is a permission-shaped read model: a section is present only when the
// caller may see it. The UI renders whatever comes back — it never re-derives a
// section the backend withheld, so an omitted section is never shown as empty.
export interface Patient360Header {
  id: string;
  mrn: string;
  fullName: string;
  sex: PatientSex;
  birthDate: string | null;
  status: PatientStatus;
  preferredLanguage: string | null;
  phone: string | null;
  email: string | null;
  mergedIntoId: string | null;
}

export interface Allergy {
  id: string;
  substance: string;
  severity: string;
  status: string;
}
export interface PrescriptionItem {
  medicationName: string;
  dose: string | null;
  route: string | null;
  frequency: string | null;
}
export interface Prescription {
  id: string;
  status: string;
  issuedAt?: string | null;
  items?: PrescriptionItem[];
}
export interface Appointment {
  id: string;
  status: string;
  startsAt: string;
  appointmentTypeName?: string | null;
}
export interface PreviousVisit {
  encounterId?: string;
  primaryDiagnosis?: string | null;
  visitDate?: string | null;
}
export interface Referral {
  id: string;
  status: string;
  specialty?: string | null;
  direction?: string | null;
  urgency?: string | null;
}
export interface FollowUp {
  id: string;
  status: string;
  dueOn?: string | null;
}
export interface Procedure {
  id: string;
  name: string;
  status: string;
}
export interface CarePlan {
  id: string;
  title: string;
  status: string;
}
export interface TreatmentEpisode {
  id: string;
  label: string;
  status: string;
}
export interface Vital {
  id: string;
  recordedAt: string;
  heartRate: number | null;
  systolicBp: number | null;
  diastolicBp: number | null;
  spo2: number | null;
  temperatureC: number | null;
}

export interface Patient360 {
  patient: Patient360Header;
  allergies?: Allergy[];
  recentVitals?: Vital[];
  activePrescriptions?: Prescription[];
  upcomingAppointments?: Appointment[];
  recentVisits?: PreviousVisit[];
  referrals?: Referral[];
  openFollowUps?: FollowUp[];
  procedures?: Procedure[];
  carePlans?: CarePlan[];
  treatmentEpisodes?: TreatmentEpisode[];
}

export function getPatient360(id: string, signal?: AbortSignal): Promise<Patient360> {
  return api.get<Patient360>(`/patients/${id}/360`, { signal });
}

// --- Queue / encounters ---------------------------------------------------
export interface QueueEntry {
  id: string;
  patientId: string;
  status: string;
  checkedInAt: string;
  patientName: string;
  mrn: string;
}

export function getQueue(signal?: AbortSignal): Promise<QueueEntry[]> {
  return api.get<{ queue: QueueEntry[] }>('/queue', { signal }).then((r) => r.queue);
}

export interface Encounter {
  id: string;
  patientId: string;
  status: string;
  checkedInAt: string;
}

export function checkInPatient(patientId: string): Promise<Encounter> {
  return api.post<Encounter>('/encounters/check-in', { patientId });
}
