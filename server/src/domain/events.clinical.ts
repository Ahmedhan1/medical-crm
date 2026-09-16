/**
 * CLINICAL CORE event types — owned by Agent 2.
 * Add clinical domain events here (intake, vitals, encounter lifecycle,
 * treatment episodes, follow-ups). Do not edit other workstreams' event files.
 */
export const ClinicalEventType = {
  PATIENT_REGISTERED: 'PATIENT_REGISTERED',
  PATIENT_CHECKED_IN: 'PATIENT_CHECKED_IN',
  ENCOUNTER_STATUS_CHANGED: 'ENCOUNTER_STATUS_CHANGED',
  QR_ISSUED: 'QR_ISSUED',
  QR_RESOLVED: 'QR_RESOLVED',
  INTAKE_RECORDED: 'INTAKE_RECORDED',
  VITALS_RECORDED: 'VITALS_RECORDED',
} as const;
