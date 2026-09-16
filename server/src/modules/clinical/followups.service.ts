import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';
import { findEncounter, getEncounterOrThrow } from './encounter.repo.js';

/**
 * Follow-ups (blueprint: Prescription → Follow-up).
 *
 * Scheduling one is a clinical decision (`followup:write`, doctor). Working the
 * resulting recall list and closing entries out is a reception workflow
 * (`followup:read` / `followup:close`), so front desk can run recalls without
 * ever holding clinical write authority.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const ScheduleFollowUpSchema = z.object({
  dueOn: isoDate,
  reason: z.string().trim().max(1_000).optional(),
});

export const CloseFollowUpSchema = z
  .object({
    status: z.enum(['completed', 'cancelled']),
    encounterId: z.string().uuid().optional(),
  })
  .refine((v) => v.status === 'completed' || v.encounterId === undefined, {
    message: 'Only a completed follow-up may reference the visit that fulfilled it',
    path: ['encounterId'],
  });

export const ListFollowUpsSchema = z.object({
  status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
  dueBefore: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export interface FollowUp {
  id: string;
  patientId: string;
  patientName?: string;
  mrn?: string;
  originEncounterId: string | null;
  completedEncounterId: string | null;
  dueOn: string;
  reason: string | null;
  status: 'scheduled' | 'completed' | 'cancelled';
  createdBy: string;
  closedBy: string | null;
  closedAt: string | null;
}

interface FollowUpRow {
  id: string;
  patient_id: string;
  full_name?: string;
  mrn?: string;
  origin_encounter_id: string | null;
  completed_encounter_id: string | null;
  due_on: string | Date;
  reason: string | null;
  status: FollowUp['status'];
  created_by: string;
  closed_by: string | null;
  closed_at: string | null;
}

const asDay = (v: string | Date): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v;

function mapFollowUp(r: FollowUpRow): FollowUp {
  const followUp: FollowUp = {
    id: r.id,
    patientId: r.patient_id,
    originEncounterId: r.origin_encounter_id,
    completedEncounterId: r.completed_encounter_id,
    dueOn: asDay(r.due_on),
    reason: r.reason,
    status: r.status,
    createdBy: r.created_by,
    closedBy: r.closed_by,
    closedAt: r.closed_at,
  };
  if (r.full_name !== undefined) followUp.patientName = r.full_name;
  if (r.mrn !== undefined) followUp.mrn = r.mrn;
  return followUp;
}

const FOLLOW_UP_COLS = `id, patient_id, origin_encounter_id, completed_encounter_id,
  due_on, reason, status, created_by, closed_by, closed_at`;

/** Schedule a follow-up from the visit at which it was decided. */
export async function scheduleFollowUp(
  principal: Principal,
  encounterId: string,
  raw: unknown,
): Promise<FollowUp> {
  requirePermission(principal, Permission.FOLLOWUP_WRITE);

  const parsed = ScheduleFollowUpSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid follow-up', parsed.error.flatten());
  }
  const encounter = await getEncounterOrThrow(principal.clinicId, encounterId);

  return withTransaction(async (client) => {
    const { rows } = await client.query<FollowUpRow>(
      `INSERT INTO follow_up
         (clinic_id, patient_id, origin_encounter_id, due_on, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING ${FOLLOW_UP_COLS}`,
      [
        principal.clinicId,
        encounter.patientId,
        encounter.id,
        parsed.data.dueOn,
        parsed.data.reason ?? null,
        principal.userId,
      ],
    );
    const followUp = mapFollowUp(rows[0]!);

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.FOLLOW_UP_SCHEDULED,
      subjectType: 'follow_up',
      subjectId: followUp.id,
      actorId: principal.userId,
      // The due date drives recall automation; the reason is clinical and stays out.
      payload: {
        patientId: encounter.patientId,
        encounterId: encounter.id,
        dueOn: followUp.dueOn,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'follow_up.schedule',
      outcome: 'success',
      targetType: 'follow_up',
      targetId: followUp.id,
      metadata: { patientId: encounter.patientId, dueOn: followUp.dueOn },
    });

    return followUp;
  });
}

/** Complete or cancel a scheduled follow-up (a reception workflow). */
export async function closeFollowUp(
  principal: Principal,
  followUpId: string,
  raw: unknown,
): Promise<FollowUp> {
  requirePermission(principal, Permission.FOLLOWUP_CLOSE);

  const parsed = CloseFollowUpSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid follow-up closure', parsed.error.flatten());
  }
  const input = parsed.data;

  return withTransaction(async (client) => {
    const { rows: locked } = await client.query<{
      id: string;
      patient_id: string;
      status: FollowUp['status'];
    }>(
      `SELECT id, patient_id, status FROM follow_up
        WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [followUpId, principal.clinicId],
    );
    const existing = locked[0];
    if (!existing) throw new NotFoundError('Follow-up');
    if (existing.status !== 'scheduled') {
      throw new ConflictError(`Follow-up is already ${existing.status}`);
    }

    if (input.encounterId) {
      const encounter = await findEncounter(principal.clinicId, input.encounterId);
      if (!encounter || encounter.patientId !== existing.patient_id) {
        throw new ValidationError('encounterId does not belong to this patient');
      }
    }

    const { rows } = await client.query<FollowUpRow>(
      `UPDATE follow_up
          SET status = $3, completed_encounter_id = $4, closed_by = $5,
              closed_at = now(), updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING ${FOLLOW_UP_COLS}`,
      [
        existing.id,
        principal.clinicId,
        input.status,
        input.encounterId ?? null,
        principal.userId,
      ],
    );
    const followUp = mapFollowUp(rows[0]!);

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.FOLLOW_UP_CLOSED,
      subjectType: 'follow_up',
      subjectId: followUp.id,
      actorId: principal.userId,
      payload: { patientId: existing.patient_id, status: followUp.status },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'follow_up.close',
      outcome: 'success',
      targetType: 'follow_up',
      targetId: followUp.id,
      metadata: { patientId: existing.patient_id, status: followUp.status },
    });

    return followUp;
  });
}

export async function listFollowUpsForPatient(
  principal: Principal,
  patientId: string,
  rawQuery: unknown,
): Promise<FollowUp[]> {
  requirePermission(principal, Permission.FOLLOWUP_READ);

  const parsed = ListFollowUpsSchema.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());

  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const { rows } = await getPool().query<FollowUpRow>(
    `SELECT ${FOLLOW_UP_COLS} FROM follow_up
      WHERE clinic_id = $1 AND patient_id = $2
        AND ($3::text IS NULL OR status = $3)
        AND ($4::date IS NULL OR due_on <= $4)
      ORDER BY due_on DESC
      LIMIT $5`,
    [
      principal.clinicId,
      patient.id,
      parsed.data.status ?? null,
      parsed.data.dueBefore ?? null,
      parsed.data.limit,
    ],
  );
  return rows.map(mapFollowUp);
}

/**
 * The clinic-wide recall worklist, oldest due first. Carries the patient name
 * and MRN because that is what makes it workable at the front desk — and it is
 * gated on `followup:read`, which no unauthorized role holds.
 */
export async function listRecallWorklist(
  principal: Principal,
  rawQuery: unknown,
): Promise<FollowUp[]> {
  requirePermission(principal, Permission.FOLLOWUP_READ);

  const parsed = ListFollowUpsSchema.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());

  const { rows } = await getPool().query<FollowUpRow>(
    `SELECT f.id, f.patient_id, f.origin_encounter_id, f.completed_encounter_id,
            f.due_on, f.reason, f.status, f.created_by, f.closed_by, f.closed_at,
            p.full_name, p.mrn
       FROM follow_up f
       JOIN patient p ON p.id = f.patient_id AND p.clinic_id = f.clinic_id
      WHERE f.clinic_id = $1
        AND f.status = COALESCE($2::text, 'scheduled')
        AND ($3::date IS NULL OR f.due_on <= $3)
      ORDER BY f.due_on ASC, f.created_at ASC
      LIMIT $4`,
    [
      principal.clinicId,
      parsed.data.status ?? null,
      parsed.data.dueBefore ?? null,
      parsed.data.limit,
    ],
  );
  return rows.map(mapFollowUp);
}

export async function listFollowUpsByEncounter(
  clinicId: string,
  encounterId: string,
  runner: Pick<PoolClient, 'query'> = getPool(),
): Promise<FollowUp[]> {
  const { rows } = await runner.query<FollowUpRow>(
    `SELECT ${FOLLOW_UP_COLS} FROM follow_up
      WHERE clinic_id = $1 AND origin_encounter_id = $2
      ORDER BY due_on ASC`,
    [clinicId, encounterId],
  );
  return rows.map(mapFollowUp);
}
