import { getPool, withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import { getPatientById } from '../identity/patients.repo.js';

export interface Encounter {
  id: string;
  clinicId: string;
  patientId: string;
  status: 'checked_in' | 'intake' | 'ready' | 'in_progress' | 'completed' | 'cancelled';
  checkedInAt: string;
}

interface EncounterRow {
  id: string;
  clinic_id: string;
  patient_id: string;
  status: Encounter['status'];
  checked_in_at: string;
}

function mapEncounter(r: EncounterRow): Encounter {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    patientId: r.patient_id,
    status: r.status,
    checkedInAt: r.checked_in_at,
  };
}

/**
 * Check a patient in — opens an encounter in `checked_in` status and emits
 * PATIENT_CHECKED_IN. The partial unique index guarantees a patient cannot hold
 * two active encounters; we translate that DB violation into a clean 409.
 */
export async function checkIn(principal: Principal, patientId: string): Promise<Encounter> {
  requirePermission(principal, Permission.ENCOUNTER_CHECKIN);

  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query<EncounterRow>(
        `INSERT INTO encounter (clinic_id, patient_id, status, checked_in_by)
         VALUES ($1, $2, 'checked_in', $3)
         RETURNING *`,
        [principal.clinicId, patient.id, principal.userId],
      );
      const encounter = mapEncounter(rows[0]!);

      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.PATIENT_CHECKED_IN,
        subjectType: 'encounter',
        subjectId: encounter.id,
        actorId: principal.userId,
        payload: { patientId: patient.id },
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'encounter.checkin',
        outcome: 'success',
        targetType: 'encounter',
        targetId: encounter.id,
        metadata: { patientId: patient.id },
      });
      return encounter;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'uq_encounter_active_patient')) {
      throw new ConflictError('Patient already has an active visit');
    }
    throw err;
  }
}

export interface QueueEntry extends Encounter {
  patientName: string;
  mrn: string;
}

/** The reception/clinical queue: active encounters oldest-first. */
export async function getQueue(principal: Principal): Promise<QueueEntry[]> {
  requirePermission(principal, Permission.QUEUE_READ);
  const { rows } = await getPool().query<EncounterRow & { full_name: string; mrn: string }>(
    `SELECT e.*, p.full_name, p.mrn
       FROM encounter e
       JOIN patient p ON p.id = e.patient_id
      WHERE e.clinic_id = $1
        AND e.status IN ('checked_in','intake','ready','in_progress')
      ORDER BY e.checked_in_at ASC`,
    [principal.clinicId],
  );
  return rows.map((r) => ({ ...mapEncounter(r), patientName: r.full_name, mrn: r.mrn }));
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505' &&
    'constraint' in err &&
    (err as { constraint?: string }).constraint === constraint
  );
}
