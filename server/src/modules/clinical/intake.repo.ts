import { getPool, type PoolClient } from '../../db/pool.js';

export interface Intake {
  id: string;
  clinicId: string;
  encounterId: string;
  patientId: string;
  chiefComplaint: string;
  historyPresentIllness: string | null;
  pastMedicalHistory: string | null;
  medicationHistory: string | null;
  allergies: string | null;
  familyHistory: string | null;
  socialHistory: string | null;
  notes: string | null;
  source: 'staff' | 'ai_assisted';
  sourceRef: string | null;
  confirmedBy: string | null;
  recordedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface IntakeRow {
  id: string;
  clinic_id: string;
  encounter_id: string;
  patient_id: string;
  chief_complaint: string;
  history_present_illness: string | null;
  past_medical_history: string | null;
  medication_history: string | null;
  allergies: string | null;
  family_history: string | null;
  social_history: string | null;
  notes: string | null;
  source: 'staff' | 'ai_assisted';
  source_ref: string | null;
  confirmed_by: string | null;
  recorded_by: string;
  created_at: string;
  updated_at: string;
}

export function mapIntake(r: IntakeRow): Intake {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    encounterId: r.encounter_id,
    patientId: r.patient_id,
    chiefComplaint: r.chief_complaint,
    historyPresentIllness: r.history_present_illness,
    pastMedicalHistory: r.past_medical_history,
    medicationHistory: r.medication_history,
    allergies: r.allergies,
    familyHistory: r.family_history,
    socialHistory: r.social_history,
    notes: r.notes,
    source: r.source,
    sourceRef: r.source_ref,
    confirmedBy: r.confirmed_by,
    recordedBy: r.recorded_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface UpsertIntakeInput {
  clinicId: string;
  encounterId: string;
  patientId: string;
  chiefComplaint: string;
  historyPresentIllness: string | null;
  pastMedicalHistory: string | null;
  medicationHistory: string | null;
  allergies: string | null;
  familyHistory: string | null;
  socialHistory: string | null;
  notes: string | null;
  source: 'staff' | 'ai_assisted';
  sourceRef: string | null;
  confirmedBy: string | null;
  recordedBy: string;
}

/**
 * Insert or revise the encounter's intake record. One row per encounter, so a
 * re-submission updates in place; the revision history lives in the append-only
 * event store rather than in duplicated rows.
 */
export async function upsertIntake(
  client: PoolClient,
  input: UpsertIntakeInput,
): Promise<{ intake: Intake; created: boolean }> {
  const { rows } = await client.query<IntakeRow & { was_insert: boolean }>(
    `INSERT INTO intake
       (clinic_id, encounter_id, patient_id, chief_complaint, history_present_illness,
        past_medical_history, medication_history, allergies, family_history,
        social_history, notes, source, source_ref, confirmed_by, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (encounter_id) DO UPDATE SET
       chief_complaint         = EXCLUDED.chief_complaint,
       history_present_illness = EXCLUDED.history_present_illness,
       past_medical_history    = EXCLUDED.past_medical_history,
       medication_history      = EXCLUDED.medication_history,
       allergies               = EXCLUDED.allergies,
       family_history          = EXCLUDED.family_history,
       social_history          = EXCLUDED.social_history,
       notes                   = EXCLUDED.notes,
       source                  = EXCLUDED.source,
       source_ref              = EXCLUDED.source_ref,
       confirmed_by            = EXCLUDED.confirmed_by,
       recorded_by             = EXCLUDED.recorded_by,
       updated_at              = now()
     RETURNING *, (xmax = 0) AS was_insert`,
    [
      input.clinicId,
      input.encounterId,
      input.patientId,
      input.chiefComplaint,
      input.historyPresentIllness,
      input.pastMedicalHistory,
      input.medicationHistory,
      input.allergies,
      input.familyHistory,
      input.socialHistory,
      input.notes,
      input.source,
      input.sourceRef,
      input.confirmedBy,
      input.recordedBy,
    ],
  );
  const row = rows[0]!;
  return { intake: mapIntake(row), created: row.was_insert };
}

export async function getIntakeByEncounter(
  clinicId: string,
  encounterId: string,
  runner: Pick<PoolClient, 'query'> = getPool(),
): Promise<Intake | null> {
  const { rows } = await runner.query<IntakeRow>(
    `SELECT * FROM intake WHERE encounter_id = $1 AND clinic_id = $2`,
    [encounterId, clinicId],
  );
  return rows[0] ? mapIntake(rows[0]) : null;
}
