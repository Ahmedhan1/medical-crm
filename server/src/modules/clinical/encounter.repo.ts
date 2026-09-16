import { getPool, type PoolClient } from '../../db/pool.js';
import { NotFoundError } from '../../domain/errors.js';

/**
 * Shared encounter row access for the clinical workstream. Every read takes a
 * `clinicId` and filters on it, so a caller cannot reach another tenant's
 * encounter even with a valid id — a missing row and an out-of-scope row are
 * indistinguishable to the caller (no existence leak).
 */
export type EncounterStatus =
  | 'checked_in'
  | 'intake'
  | 'ready'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface Encounter {
  id: string;
  clinicId: string;
  patientId: string;
  status: EncounterStatus;
  checkedInAt: string;
}

export interface EncounterRow {
  id: string;
  clinic_id: string;
  patient_id: string;
  status: EncounterStatus;
  checked_in_at: string;
}

export function mapEncounter(r: EncounterRow): Encounter {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    patientId: r.patient_id,
    status: r.status,
    checkedInAt: r.checked_in_at,
  };
}

/** Terminal states: no further clinical writes are accepted. */
export const TERMINAL_STATUSES: readonly EncounterStatus[] = ['completed', 'cancelled'];

/** Non-terminal states, i.e. the states that appear on the queue. */
export const ACTIVE_STATUSES: readonly EncounterStatus[] = [
  'checked_in',
  'intake',
  'ready',
  'in_progress',
];

export async function findEncounter(
  clinicId: string,
  encounterId: string,
): Promise<Encounter | null> {
  const { rows } = await getPool().query<EncounterRow>(
    `SELECT id, clinic_id, patient_id, status, checked_in_at
       FROM encounter WHERE id = $1 AND clinic_id = $2`,
    [encounterId, clinicId],
  );
  return rows[0] ? mapEncounter(rows[0]) : null;
}

export async function getEncounterOrThrow(
  clinicId: string,
  encounterId: string,
): Promise<Encounter> {
  const encounter = await findEncounter(clinicId, encounterId);
  if (!encounter) throw new NotFoundError('Encounter');
  return encounter;
}

/**
 * Load an encounter inside a transaction with a row lock. Concurrent writers to
 * the same encounter serialize here, so a status transition can be validated
 * and applied without a read-modify-write race.
 */
export async function lockEncounter(
  client: PoolClient,
  clinicId: string,
  encounterId: string,
): Promise<Encounter> {
  const { rows } = await client.query<EncounterRow>(
    `SELECT id, clinic_id, patient_id, status, checked_in_at
       FROM encounter WHERE id = $1 AND clinic_id = $2
       FOR UPDATE`,
    [encounterId, clinicId],
  );
  if (!rows[0]) throw new NotFoundError('Encounter');
  return mapEncounter(rows[0]);
}
