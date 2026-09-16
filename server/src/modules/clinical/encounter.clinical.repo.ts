import { getPool, type PoolClient } from '../../db/pool.js';

/** Row-mapping helpers for the consultation record (migration 0101). */

type Runner = Pick<PoolClient, 'query'>;

// --------------------------------------------------------------------------
// encounter_clinical
// --------------------------------------------------------------------------
export interface EncounterClinical {
  id: string;
  encounterId: string;
  patientId: string;
  complaint: string | null;
  examination: string | null;
  attendingDoctorId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface EncounterClinicalRow {
  id: string;
  encounter_id: string;
  patient_id: string;
  complaint: string | null;
  examination: string | null;
  attending_doctor_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

function mapClinical(r: EncounterClinicalRow): EncounterClinical {
  return {
    id: r.id,
    encounterId: r.encounter_id,
    patientId: r.patient_id,
    complaint: r.complaint,
    examination: r.examination,
    attendingDoctorId: r.attending_doctor_id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    updatedAt: r.updated_at,
  };
}

const CLINICAL_COLS = `id, encounter_id, patient_id, complaint, examination,
  attending_doctor_id, started_at, completed_at, updated_at`;

/** Create the consultation record if absent; returns the current row either way. */
export async function ensureEncounterClinical(
  client: PoolClient,
  clinicId: string,
  encounterId: string,
  patientId: string,
  updatedBy: string,
): Promise<EncounterClinical> {
  const { rows } = await client.query<EncounterClinicalRow>(
    `INSERT INTO encounter_clinical (clinic_id, encounter_id, patient_id, updated_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (encounter_id) DO UPDATE SET encounter_id = EXCLUDED.encounter_id
     RETURNING ${CLINICAL_COLS}`,
    [clinicId, encounterId, patientId, updatedBy],
  );
  return mapClinical(rows[0]!);
}

export interface ClinicalFieldPatch {
  complaint?: string | null;
  examination?: string | null;
}

/**
 * Apply a partial update to the consultation's free-text fields. Only keys
 * present in the patch are written, so an omitted field is left untouched
 * rather than silently cleared.
 */
export async function updateEncounterClinical(
  client: PoolClient,
  clinicId: string,
  encounterId: string,
  patch: ClinicalFieldPatch,
  updatedBy: string,
): Promise<EncounterClinical> {
  const sets: string[] = [];
  const values: unknown[] = [clinicId, encounterId, updatedBy];
  for (const key of ['complaint', 'examination'] as const) {
    if (key in patch) {
      values.push(patch[key] ?? null);
      sets.push(`${key} = $${values.length}`);
    }
  }
  const { rows } = await client.query<EncounterClinicalRow>(
    `UPDATE encounter_clinical
        SET ${[...sets, 'updated_by = $3', 'updated_at = now()'].join(', ')}
      WHERE clinic_id = $1 AND encounter_id = $2
      RETURNING ${CLINICAL_COLS}`,
    values,
  );
  return mapClinical(rows[0]!);
}

export async function markStarted(
  client: PoolClient,
  clinicId: string,
  encounterId: string,
  doctorId: string,
): Promise<EncounterClinical> {
  const { rows } = await client.query<EncounterClinicalRow>(
    `UPDATE encounter_clinical
        SET attending_doctor_id = $3,
            started_at = COALESCE(started_at, now()),
            updated_by = $3,
            updated_at = now()
      WHERE clinic_id = $1 AND encounter_id = $2
      RETURNING ${CLINICAL_COLS}`,
    [clinicId, encounterId, doctorId],
  );
  return mapClinical(rows[0]!);
}

export async function markCompleted(
  client: PoolClient,
  clinicId: string,
  encounterId: string,
  doctorId: string,
): Promise<void> {
  await client.query(
    `UPDATE encounter_clinical
        SET completed_at = now(), updated_by = $3, updated_at = now()
      WHERE clinic_id = $1 AND encounter_id = $2`,
    [clinicId, encounterId, doctorId],
  );
}

export async function getEncounterClinical(
  clinicId: string,
  encounterId: string,
  runner: Runner = getPool(),
): Promise<EncounterClinical | null> {
  const { rows } = await runner.query<EncounterClinicalRow>(
    `SELECT ${CLINICAL_COLS} FROM encounter_clinical
      WHERE clinic_id = $1 AND encounter_id = $2`,
    [clinicId, encounterId],
  );
  return rows[0] ? mapClinical(rows[0]) : null;
}

// --------------------------------------------------------------------------
// assessment
// --------------------------------------------------------------------------
export interface Assessment {
  id: string;
  encounterId: string;
  summary: string;
  severity: string | null;
  recordedBy: string;
  updatedAt: string;
}

interface AssessmentRow {
  id: string;
  encounter_id: string;
  summary: string;
  severity: string | null;
  recorded_by: string;
  updated_at: string;
}

const mapAssessment = (r: AssessmentRow): Assessment => ({
  id: r.id,
  encounterId: r.encounter_id,
  summary: r.summary,
  severity: r.severity,
  recordedBy: r.recorded_by,
  updatedAt: r.updated_at,
});

export async function upsertAssessment(
  client: PoolClient,
  input: {
    clinicId: string;
    encounterId: string;
    patientId: string;
    summary: string;
    severity: string | null;
    recordedBy: string;
  },
): Promise<Assessment> {
  const { rows } = await client.query<AssessmentRow>(
    `INSERT INTO assessment (clinic_id, encounter_id, patient_id, summary, severity, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (encounter_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       severity = EXCLUDED.severity,
       recorded_by = EXCLUDED.recorded_by,
       updated_at = now()
     RETURNING id, encounter_id, summary, severity, recorded_by, updated_at`,
    [
      input.clinicId,
      input.encounterId,
      input.patientId,
      input.summary,
      input.severity,
      input.recordedBy,
    ],
  );
  return mapAssessment(rows[0]!);
}

export async function getAssessment(
  clinicId: string,
  encounterId: string,
  runner: Runner = getPool(),
): Promise<Assessment | null> {
  const { rows } = await runner.query<AssessmentRow>(
    `SELECT id, encounter_id, summary, severity, recorded_by, updated_at
       FROM assessment WHERE clinic_id = $1 AND encounter_id = $2`,
    [clinicId, encounterId],
  );
  return rows[0] ? mapAssessment(rows[0]) : null;
}

// --------------------------------------------------------------------------
// diagnosis
// --------------------------------------------------------------------------
export interface Diagnosis {
  id: string;
  encounterId: string;
  patientId: string;
  description: string;
  codeSystem: string | null;
  code: string | null;
  category: 'primary' | 'secondary' | 'differential';
  certainty: 'suspected' | 'probable' | 'confirmed';
  status: 'active' | 'resolved' | 'ruled_out';
  onsetDate: string | null;
  recordedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface DiagnosisRow {
  id: string;
  encounter_id: string;
  patient_id: string;
  description: string;
  code_system: string | null;
  code: string | null;
  category: Diagnosis['category'];
  certainty: Diagnosis['certainty'];
  status: Diagnosis['status'];
  onset_date: string | null;
  recorded_by: string;
  created_at: string;
  updated_at: string;
}

export function mapDiagnosis(r: DiagnosisRow): Diagnosis {
  return {
    id: r.id,
    encounterId: r.encounter_id,
    patientId: r.patient_id,
    description: r.description,
    codeSystem: r.code_system,
    code: r.code,
    category: r.category,
    certainty: r.certainty,
    status: r.status,
    onsetDate: r.onset_date,
    recordedBy: r.recorded_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const DIAGNOSIS_COLS = `id, encounter_id, patient_id, description, code_system, code,
  category, certainty, status, onset_date, recorded_by, created_at, updated_at`;

export async function insertDiagnosis(
  client: PoolClient,
  input: {
    clinicId: string;
    encounterId: string;
    patientId: string;
    description: string;
    codeSystem: string | null;
    code: string | null;
    category: Diagnosis['category'];
    certainty: Diagnosis['certainty'];
    onsetDate: string | null;
    recordedBy: string;
  },
): Promise<Diagnosis> {
  const { rows } = await client.query<DiagnosisRow>(
    `INSERT INTO diagnosis
       (clinic_id, encounter_id, patient_id, description, code_system, code,
        category, certainty, onset_date, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${DIAGNOSIS_COLS}`,
    [
      input.clinicId,
      input.encounterId,
      input.patientId,
      input.description,
      input.codeSystem,
      input.code,
      input.category,
      input.certainty,
      input.onsetDate,
      input.recordedBy,
    ],
  );
  return mapDiagnosis(rows[0]!);
}

export async function findDiagnosis(
  client: Runner,
  clinicId: string,
  diagnosisId: string,
): Promise<Diagnosis | null> {
  const { rows } = await client.query<DiagnosisRow>(
    `SELECT ${DIAGNOSIS_COLS} FROM diagnosis WHERE id = $1 AND clinic_id = $2`,
    [diagnosisId, clinicId],
  );
  return rows[0] ? mapDiagnosis(rows[0]) : null;
}

export interface DiagnosisPatch {
  description?: string;
  category?: Diagnosis['category'];
  certainty?: Diagnosis['certainty'];
  status?: Diagnosis['status'];
}

export async function updateDiagnosis(
  client: PoolClient,
  clinicId: string,
  diagnosisId: string,
  patch: DiagnosisPatch,
  updatedBy: string,
): Promise<Diagnosis> {
  const sets: string[] = [];
  const values: unknown[] = [clinicId, diagnosisId, updatedBy];
  for (const key of ['description', 'category', 'certainty', 'status'] as const) {
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  const { rows } = await client.query<DiagnosisRow>(
    `UPDATE diagnosis
        SET ${[...sets, 'recorded_by = $3', 'updated_at = now()'].join(', ')}
      WHERE clinic_id = $1 AND id = $2
      RETURNING ${DIAGNOSIS_COLS}`,
    values,
  );
  return mapDiagnosis(rows[0]!);
}

export async function listDiagnoses(
  clinicId: string,
  encounterId: string,
  runner: Runner = getPool(),
): Promise<Diagnosis[]> {
  const { rows } = await runner.query<DiagnosisRow>(
    `SELECT ${DIAGNOSIS_COLS} FROM diagnosis
      WHERE clinic_id = $1 AND encounter_id = $2
      ORDER BY (category = 'primary') DESC, created_at ASC`,
    [clinicId, encounterId],
  );
  return rows.map(mapDiagnosis);
}

// --------------------------------------------------------------------------
// treatment_plan
// --------------------------------------------------------------------------
export interface TreatmentPlan {
  id: string;
  encounterId: string;
  summary: string;
  instructions: string | null;
  followUpInDays: number | null;
  recordedBy: string;
  updatedAt: string;
}

interface TreatmentPlanRow {
  id: string;
  encounter_id: string;
  summary: string;
  instructions: string | null;
  follow_up_in_days: number | null;
  recorded_by: string;
  updated_at: string;
}

const mapPlan = (r: TreatmentPlanRow): TreatmentPlan => ({
  id: r.id,
  encounterId: r.encounter_id,
  summary: r.summary,
  instructions: r.instructions,
  followUpInDays: r.follow_up_in_days,
  recordedBy: r.recorded_by,
  updatedAt: r.updated_at,
});

export async function upsertTreatmentPlan(
  client: PoolClient,
  input: {
    clinicId: string;
    encounterId: string;
    patientId: string;
    summary: string;
    instructions: string | null;
    followUpInDays: number | null;
    recordedBy: string;
  },
): Promise<TreatmentPlan> {
  const { rows } = await client.query<TreatmentPlanRow>(
    `INSERT INTO treatment_plan
       (clinic_id, encounter_id, patient_id, summary, instructions, follow_up_in_days, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (encounter_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       instructions = EXCLUDED.instructions,
       follow_up_in_days = EXCLUDED.follow_up_in_days,
       recorded_by = EXCLUDED.recorded_by,
       updated_at = now()
     RETURNING id, encounter_id, summary, instructions, follow_up_in_days, recorded_by, updated_at`,
    [
      input.clinicId,
      input.encounterId,
      input.patientId,
      input.summary,
      input.instructions,
      input.followUpInDays,
      input.recordedBy,
    ],
  );
  return mapPlan(rows[0]!);
}

export async function getTreatmentPlan(
  clinicId: string,
  encounterId: string,
  runner: Runner = getPool(),
): Promise<TreatmentPlan | null> {
  const { rows } = await runner.query<TreatmentPlanRow>(
    `SELECT id, encounter_id, summary, instructions, follow_up_in_days, recorded_by, updated_at
       FROM treatment_plan WHERE clinic_id = $1 AND encounter_id = $2`,
    [clinicId, encounterId],
  );
  return rows[0] ? mapPlan(rows[0]) : null;
}

// --------------------------------------------------------------------------
// clinical_note (append-only)
// --------------------------------------------------------------------------
export interface ClinicalNote {
  id: string;
  encounterId: string;
  noteType: string;
  body: string;
  supersedesId: string | null;
  authorId: string;
  createdAt: string;
}

interface ClinicalNoteRow {
  id: string;
  encounter_id: string;
  note_type: string;
  body: string;
  supersedes_id: string | null;
  author_id: string;
  created_at: string;
}

const mapNote = (r: ClinicalNoteRow): ClinicalNote => ({
  id: r.id,
  encounterId: r.encounter_id,
  noteType: r.note_type,
  body: r.body,
  supersedesId: r.supersedes_id,
  authorId: r.author_id,
  createdAt: r.created_at,
});

export async function insertNote(
  client: PoolClient,
  input: {
    clinicId: string;
    encounterId: string;
    patientId: string;
    noteType: string;
    body: string;
    supersedesId: string | null;
    authorId: string;
  },
): Promise<ClinicalNote> {
  const { rows } = await client.query<ClinicalNoteRow>(
    `INSERT INTO clinical_note
       (clinic_id, encounter_id, patient_id, note_type, body, supersedes_id, author_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, encounter_id, note_type, body, supersedes_id, author_id, created_at`,
    [
      input.clinicId,
      input.encounterId,
      input.patientId,
      input.noteType,
      input.body,
      input.supersedesId,
      input.authorId,
    ],
  );
  return mapNote(rows[0]!);
}

export async function listNotes(
  clinicId: string,
  encounterId: string,
  runner: Runner = getPool(),
): Promise<ClinicalNote[]> {
  const { rows } = await runner.query<ClinicalNoteRow>(
    `SELECT id, encounter_id, note_type, body, supersedes_id, author_id, created_at
       FROM clinical_note
      WHERE clinic_id = $1 AND encounter_id = $2
      ORDER BY created_at ASC, id ASC`,
    [clinicId, encounterId],
  );
  return rows.map(mapNote);
}
