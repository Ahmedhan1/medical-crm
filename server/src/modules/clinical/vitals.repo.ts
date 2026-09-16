import { getPool, type PoolClient } from '../../db/pool.js';

export interface Vital {
  id: string;
  clinicId: string;
  encounterId: string;
  patientId: string;
  systolicBp: number | null;
  diastolicBp: number | null;
  heartRate: number | null;
  respiratoryRate: number | null;
  temperatureC: number | null;
  spo2: number | null;
  weightKg: number | null;
  heightCm: number | null;
  bloodGlucoseMgdl: number | null;
  painScore: number | null;
  bmi: number | null;
  notes: string | null;
  recordedBy: string;
  recordedAt: string;
}

interface VitalRow {
  id: string;
  clinic_id: string;
  encounter_id: string;
  patient_id: string;
  systolic_bp: number | null;
  diastolic_bp: number | null;
  heart_rate: number | null;
  respiratory_rate: number | null;
  // numeric columns come back from `pg` as strings to avoid precision loss.
  temperature_c: string | null;
  spo2: number | null;
  weight_kg: string | null;
  height_cm: string | null;
  blood_glucose_mgdl: number | null;
  pain_score: number | null;
  bmi: string | null;
  notes: string | null;
  recorded_by: string;
  recorded_at: string;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export function mapVital(r: VitalRow): Vital {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    encounterId: r.encounter_id,
    patientId: r.patient_id,
    systolicBp: r.systolic_bp,
    diastolicBp: r.diastolic_bp,
    heartRate: r.heart_rate,
    respiratoryRate: r.respiratory_rate,
    temperatureC: num(r.temperature_c),
    spo2: r.spo2,
    weightKg: num(r.weight_kg),
    heightCm: num(r.height_cm),
    bloodGlucoseMgdl: r.blood_glucose_mgdl,
    painScore: r.pain_score,
    bmi: num(r.bmi),
    notes: r.notes,
    recordedBy: r.recorded_by,
    recordedAt: r.recorded_at,
  };
}

export interface InsertVitalInput {
  clinicId: string;
  encounterId: string;
  patientId: string;
  systolicBp: number | null;
  diastolicBp: number | null;
  heartRate: number | null;
  respiratoryRate: number | null;
  temperatureC: number | null;
  spo2: number | null;
  weightKg: number | null;
  heightCm: number | null;
  bloodGlucoseMgdl: number | null;
  painScore: number | null;
  notes: string | null;
  recordedBy: string;
}

export async function insertVital(
  client: PoolClient,
  input: InsertVitalInput,
): Promise<Vital> {
  const { rows } = await client.query<VitalRow>(
    `INSERT INTO vital
       (clinic_id, encounter_id, patient_id, systolic_bp, diastolic_bp, heart_rate,
        respiratory_rate, temperature_c, spo2, weight_kg, height_cm,
        blood_glucose_mgdl, pain_score, notes, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      input.clinicId,
      input.encounterId,
      input.patientId,
      input.systolicBp,
      input.diastolicBp,
      input.heartRate,
      input.respiratoryRate,
      input.temperatureC,
      input.spo2,
      input.weightKg,
      input.heightCm,
      input.bloodGlucoseMgdl,
      input.painScore,
      input.notes,
      input.recordedBy,
    ],
  );
  return mapVital(rows[0]!);
}

export async function listVitalsByEncounter(
  clinicId: string,
  encounterId: string,
  runner: Pick<PoolClient, 'query'> = getPool(),
): Promise<Vital[]> {
  const { rows } = await runner.query<VitalRow>(
    `SELECT * FROM vital
      WHERE encounter_id = $1 AND clinic_id = $2
      ORDER BY recorded_at DESC, id DESC`,
    [encounterId, clinicId],
  );
  return rows.map(mapVital);
}
