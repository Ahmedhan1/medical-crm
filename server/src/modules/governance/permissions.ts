/**
 * Permission catalog and default role → permission mapping (Governance engine).
 *
 * Permissions are fine-grained `resource:action` strings. Roles are bundles of
 * permissions. This module is the single source of truth used both to seed the
 * database and to type-check authorization calls (no magic strings §48).
 *
 * NOTE on the pharma boundary (§45): PHARMA_REP is intentionally granted NO
 * patient/clinical permissions. Pharma users can never read patient records;
 * this is enforced by RBAC and covered by a dedicated security test.
 */
export const Permission = {
  PATIENT_REGISTER: 'patient:register',
  PATIENT_READ: 'patient:read',
  PATIENT_SEARCH: 'patient:search',
  QR_ISSUE: 'qr:issue',
  QR_RESOLVE: 'qr:resolve',
  ENCOUNTER_CHECKIN: 'encounter:checkin',
  ENCOUNTER_READ: 'encounter:read',
  QUEUE_READ: 'queue:read',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  [Permission.PATIENT_REGISTER]: 'Register a new patient',
  [Permission.PATIENT_READ]: 'View a patient record',
  [Permission.PATIENT_SEARCH]: 'Search patients',
  [Permission.QR_ISSUE]: 'Issue a patient QR identity token',
  [Permission.QR_RESOLVE]: 'Resolve a QR token to a patient',
  [Permission.ENCOUNTER_CHECKIN]: 'Check a patient in (start an encounter)',
  [Permission.ENCOUNTER_READ]: 'View encounters',
  [Permission.QUEUE_READ]: 'View the reception/clinical queue',
};

export const RoleKey = {
  ADMIN: 'ADMIN',
  RECEPTION: 'RECEPTION',
  NURSE: 'NURSE',
  DOCTOR: 'DOCTOR',
  PHARMA_REP: 'PHARMA_REP',
} as const;

export type RoleKey = (typeof RoleKey)[keyof typeof RoleKey];

const ALL_PERMISSIONS = Object.values(Permission);

export const ROLE_DEFINITIONS: Record<RoleKey, { description: string; permissions: Permission[] }> = {
  [RoleKey.ADMIN]: {
    description: 'Clinic administrator — full operational access',
    permissions: [...ALL_PERMISSIONS],
  },
  [RoleKey.RECEPTION]: {
    description: 'Front desk — registration, identification, check-in, queue',
    permissions: [
      Permission.PATIENT_REGISTER,
      Permission.PATIENT_READ,
      Permission.PATIENT_SEARCH,
      Permission.QR_ISSUE,
      Permission.QR_RESOLVE,
      Permission.ENCOUNTER_CHECKIN,
      Permission.ENCOUNTER_READ,
      Permission.QUEUE_READ,
    ],
  },
  [RoleKey.NURSE]: {
    description: 'Nursing/intake — identification, intake, queue',
    permissions: [
      Permission.PATIENT_READ,
      Permission.PATIENT_SEARCH,
      Permission.QR_RESOLVE,
      Permission.ENCOUNTER_READ,
      Permission.QUEUE_READ,
    ],
  },
  [RoleKey.DOCTOR]: {
    description: 'Physician — clinical read access and queue',
    permissions: [
      Permission.PATIENT_READ,
      Permission.PATIENT_SEARCH,
      Permission.ENCOUNTER_READ,
      Permission.QUEUE_READ,
    ],
  },
  [RoleKey.PHARMA_REP]: {
    description: 'Pharma field representative — NO patient/clinical access',
    permissions: [],
  },
};
