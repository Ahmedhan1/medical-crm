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
  ENCOUNTER_STATUS: 'encounter:status',
  QUEUE_READ: 'queue:read',
  INTAKE_RECORD: 'intake:record',
  INTAKE_READ: 'intake:read',
  VITALS_RECORD: 'vitals:record',
  VITALS_READ: 'vitals:read',
  ENCOUNTER_CLINICAL_READ: 'encounter:clinical:read',
  ENCOUNTER_CLINICAL_WRITE: 'encounter:clinical:write',
  ENCOUNTER_COMPLETE: 'encounter:complete',
  DIAGNOSIS_WRITE: 'diagnosis:write',
  TREATMENT_WRITE: 'treatment:write',
  NOTE_WRITE: 'note:write',
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
    [ClinicalPermission.ENCOUNTER_STATUS]: 'Advance an encounter through the visit workflow',
    [ClinicalPermission.QUEUE_READ]: 'View the reception/clinical queue',
    [ClinicalPermission.INTAKE_RECORD]: 'Record or revise clinical intake (complaint + history)',
    [ClinicalPermission.INTAKE_READ]: 'View clinical intake',
    [ClinicalPermission.VITALS_RECORD]: 'Record a set of vital signs',
    [ClinicalPermission.VITALS_READ]: 'View recorded vital signs',
    [ClinicalPermission.ENCOUNTER_CLINICAL_READ]: 'View the clinical record of an encounter',
    [ClinicalPermission.ENCOUNTER_CLINICAL_WRITE]:
      'Open a consultation and write complaint, examination and assessment',
    [ClinicalPermission.ENCOUNTER_COMPLETE]: 'Close a consultation',
    [ClinicalPermission.DIAGNOSIS_WRITE]: 'Record or revise a diagnosis',
    [ClinicalPermission.TREATMENT_WRITE]: 'Record or revise a treatment plan',
    [ClinicalPermission.NOTE_WRITE]: 'Append a clinical note',
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
      ClinicalPermission.ENCOUNTER_STATUS,
      ClinicalPermission.QUEUE_READ,
    ],
    [RoleKey.NURSE]: [
      ClinicalPermission.PATIENT_READ,
      ClinicalPermission.PATIENT_SEARCH,
      ClinicalPermission.QR_RESOLVE,
      ClinicalPermission.ENCOUNTER_READ,
      ClinicalPermission.ENCOUNTER_STATUS,
      ClinicalPermission.QUEUE_READ,
      ClinicalPermission.INTAKE_RECORD,
      ClinicalPermission.INTAKE_READ,
      ClinicalPermission.VITALS_RECORD,
      ClinicalPermission.VITALS_READ,
      ClinicalPermission.ENCOUNTER_CLINICAL_READ,
    ],
    [RoleKey.DOCTOR]: [
      ClinicalPermission.PATIENT_READ,
      ClinicalPermission.PATIENT_SEARCH,
      ClinicalPermission.ENCOUNTER_READ,
      ClinicalPermission.ENCOUNTER_STATUS,
      ClinicalPermission.QUEUE_READ,
      ClinicalPermission.INTAKE_RECORD,
      ClinicalPermission.INTAKE_READ,
      ClinicalPermission.VITALS_RECORD,
      ClinicalPermission.VITALS_READ,
      ClinicalPermission.ENCOUNTER_CLINICAL_READ,
      ClinicalPermission.ENCOUNTER_CLINICAL_WRITE,
      ClinicalPermission.ENCOUNTER_COMPLETE,
      ClinicalPermission.DIAGNOSIS_WRITE,
      ClinicalPermission.TREATMENT_WRITE,
      ClinicalPermission.NOTE_WRITE,
    ],
  },
};
