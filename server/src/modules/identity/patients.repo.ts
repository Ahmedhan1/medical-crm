import { getPool, type PoolClient } from '../../db/pool.js';

export interface Patient {
  id: string;
  clinicId: string;
  mrn: string;
  fullName: string;
  sex: 'male' | 'female' | 'other' | 'unknown';
  birthDate: string | null;
  phone: string | null;
  nationalId: string | null;
  createdAt: string;
}

interface PatientDbRow {
  id: string;
  clinic_id: string;
  mrn: string;
  full_name: string;
  sex: Patient['sex'];
  birth_date: string | null;
  phone: string | null;
  national_id: string | null;
  created_at: string;
}

function mapPatient(row: PatientDbRow): Patient {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    mrn: row.mrn,
    fullName: row.full_name,
    sex: row.sex,
    birthDate: row.birth_date,
    phone: row.phone,
    nationalId: row.national_id,
    createdAt: row.created_at,
  };
}

export async function nextMrn(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT nextval('patient_mrn_seq') AS n`,
  );
  return `MRN-${String(rows[0]!.n).padStart(6, '0')}`;
}

export interface InsertPatientInput {
  clinicId: string;
  mrn: string;
  fullName: string;
  sex: Patient['sex'];
  birthDate: string | null;
  phone: string | null;
  nationalId: string | null;
  createdBy: string;
}

export async function insertPatient(
  client: PoolClient,
  input: InsertPatientInput,
): Promise<Patient> {
  const { rows } = await client.query<PatientDbRow>(
    `INSERT INTO patient
       (clinic_id, mrn, full_name, sex, birth_date, phone, national_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      input.clinicId,
      input.mrn,
      input.fullName,
      input.sex,
      input.birthDate,
      input.phone,
      input.nationalId,
      input.createdBy,
    ],
  );
  return mapPatient(rows[0]!);
}

/** Find a potential duplicate within the clinic (national id, or name+phone). */
export async function findDuplicate(
  client: Pick<PoolClient, 'query'>,
  clinicId: string,
  fullName: string,
  phone: string | null,
  nationalId: string | null,
): Promise<Patient | null> {
  const { rows } = await client.query<PatientDbRow>(
    `SELECT * FROM patient
      WHERE clinic_id = $1
        AND (
          ($2::text IS NOT NULL AND national_id = $2)
          OR ($3::text IS NOT NULL AND lower(full_name) = lower($4) AND phone = $3)
        )
      LIMIT 1`,
    [clinicId, nationalId, phone, fullName],
  );
  return rows[0] ? mapPatient(rows[0]) : null;
}

export async function getPatientById(clinicId: string, id: string): Promise<Patient | null> {
  const { rows } = await getPool().query<PatientDbRow>(
    `SELECT * FROM patient WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapPatient(rows[0]) : null;
}

export async function searchPatients(
  clinicId: string,
  query: string,
  limit: number,
): Promise<Patient[]> {
  const trimmed = query.trim();
  const like = `%${trimmed.toLowerCase()}%`;
  const { rows } = await getPool().query<PatientDbRow>(
    `SELECT * FROM patient
      WHERE clinic_id = $1
        AND (lower(full_name) LIKE $2 OR phone LIKE $3 OR mrn ILIKE $3)
      ORDER BY created_at DESC
      LIMIT $4`,
    [clinicId, like, `%${trimmed}%`, limit],
  );
  return rows.map(mapPatient);
}
