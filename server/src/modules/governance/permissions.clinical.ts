import { RoleKey, type WorkstreamPermissions } from './roles.js';

/**
 * CLINICAL CORE permissions — owned by Agent 2.
 *
 * Add clinical permissions here (patient, encounter, intake, vitals, notes,
 * timeline, prescription, reports) and grant them to existing roles via
 * `roleGrants`. ADMIN automatically receives every permission, so never list
 * ADMIN here. Do not edit other workstreams' permission files.
 */
export const ClinicalPermission = {
  PATIENT_REGISTER: 'patient:register',
  PATIENT_READ: 'patient:read',
  PATIENT_SEARCH: 'patient:search',
  QR_ISSUE: 'qr:issue',
  QR_RESOLVE: 'qr:resolve',
  ENCOUNTER_CHECKIN: 'encounter:checkin',
  ENCOUNTER_READ: 'encounter:read',
  QUEUE_READ: 'queue:read',
} as const;

export const clinicalPermissions: WorkstreamPermissions = {
  permissions: ClinicalPermission,
  descriptions: {
    [ClinicalPermission.PATIENT_REGISTER]: 'Register a new patient',
    [ClinicalPermission.PATIENT_READ]: 'View a patient record',
    [ClinicalPermission.PATIENT_SEARCH]: 'Search patients',
    [ClinicalPermission.QR_ISSUE]: 'Issue a patient QR identity token',
    [ClinicalPermission.QR_RESOLVE]: 'Resolve a QR token to a patient',
    [ClinicalPermission.ENCOUNTER_CHECKIN]: 'Check a patient in (start an encounter)',
    [ClinicalPermission.ENCOUNTER_READ]: 'View encounters',
    [ClinicalPermission.QUEUE_READ]: 'View the reception/clinical queue',
  },
  roleGrants: {
    [RoleKey.RECEPTION]: [
      ClinicalPermission.PATIENT_REGISTER,
      ClinicalPermission.PATIENT_READ,
      ClinicalPermission.PATIENT_SEARCH,
      ClinicalPermission.QR_ISSUE,
      ClinicalPermission.QR_RESOLVE,
      ClinicalPermission.ENCOUNTER_CHECKIN,
      ClinicalPermission.ENCOUNTER_READ,
      ClinicalPermission.QUEUE_READ,
    ],
    [RoleKey.NURSE]: [
      ClinicalPermission.PATIENT_READ,
      ClinicalPermission.PATIENT_SEARCH,
      ClinicalPermission.QR_RESOLVE,
      ClinicalPermission.ENCOUNTER_READ,
      ClinicalPermission.QUEUE_READ,
    ],
    [RoleKey.DOCTOR]: [
      ClinicalPermission.PATIENT_READ,
      ClinicalPermission.PATIENT_SEARCH,
      ClinicalPermission.ENCOUNTER_READ,
      ClinicalPermission.QUEUE_READ,
    ],
  },
};
