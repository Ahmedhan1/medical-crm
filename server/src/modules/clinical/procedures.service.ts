import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';
import { findEncounter } from './encounter.repo.js';
import { resolvePatientLineage } from '../identity/patients.lifecycle.service.js';

/**
 * Structured procedure documentation (FHIR Procedure-aligned).
 *
 * Doctor-owned. A completed procedure is an IMMUTABLE clinical fact: the
 * database (migration 0111) locks its clinical content once completed, allowing
 * only an audit-safe correction to `entered_in_error`. Terminology is not owned
 * here — the code system is recorded alongside the code, both or neither, with
 * no cross-workstream key.
 */

export type ProcedureStatus =
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'not_done'
  | 'entered_in_error';

const ALLOWED: Record<ProcedureStatus, readonly ProcedureStatus[]> = {
  planned: ['in_progress', 'completed', 'not_done', 'entered_in_error'],
  in_progress: ['completed', 'not_done', 'entered_in_error'],
  completed: ['entered_in_error'],
  not_done: [],
  entered_in_error: [],
};

const codePair = z
  .object({
    codeSystem: z.enum(['CPT', 'ICD-10-PCS', 'SNOMED-CT', 'local']).optional(),
    code: z.string().trim().min(1).max(40).optional(),
  })
  .refine((v) => (v.code === undefined) === (v.codeSystem === undefined), {
    message: 'code and codeSystem must be supplied together',
    path: ['code'],
  });

export const RecordProcedureSchema = z
  .object({
    patientId: z.string().uuid(),
    encounterId: z.string().uuid().optional(),
    episodeId: z.string().uuid().optional(),
    name: z.string().trim().min(2).max(300),
    codeSystem: z.enum(['CPT', 'ICD-10-PCS', 'SNOMED-CT', 'local']).optional(),
    code: z.string().trim().min(1).max(40).optional(),
    bodySite: z.string().trim().max(120).optional(),
    /** Record straight to completed, or leave planned/in_progress. */
    status: z.enum(['planned', 'in_progress', 'completed']).default('completed'),
    performedAt: z.string().datetime({ offset: true }).optional(),
    outcome: z.string().trim().max(2_000).optional(),
    complication: z.string().trim().max(2_000).optional(),
    notes: z.string().trim().max(4_000).optional(),
  })
  .refine((v) => (v.code === undefined) === (v.codeSystem === undefined), {
    message: 'code and codeSystem must be supplied together',
    path: ['code'],
  });

export const UpdateProcedureSchema = z
  .object({
    status: z.enum(['in_progress', 'completed', 'not_done']).optional(),
    outcome: z.string().trim().max(2_000).nullable().optional(),
    complication: z.string().trim().max(2_000).nullable().optional(),
    bodySite: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(4_000).nullable().optional(),
    notDoneReason: z.string().trim().min(2).max(500).optional(),
    performedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export interface Procedure {
  id: string;
  patientId: string;
  encounterId: string | null;
  episodeId: string | null;
  name: string;
  codeSystem: string | null;
  code: string | null;
  bodySite: string | null;
  status: ProcedureStatus;
  performedBy: string | null;
  performedAt: string | null;
  outcome: string | null;
  complication: string | null;
  notDoneReason: string | null;
  notes: string | null;
  createdAt: string;
}

interface ProcedureRow {
  id: string;
  patient_id: string;
  encounter_id: string | null;
  episode_id: string | null;
  name: string;
  code_system: string | null;
  code: string | null;
  body_site: string | null;
  status: ProcedureStatus;
  performed_by: string | null;
  performed_at: string | null;
  outcome: string | null;
  complication: string | null;
  not_done_reason: string | null;
  notes: string | null;
  created_at: string;
}

function mapProcedure(r: ProcedureRow): Procedure {
  return {
    id: r.id,
    patientId: r.patient_id,
    encounterId: r.encounter_id,
    episodeId: r.episode_id,
    name: r.name,
    codeSystem: r.code_system,
    code: r.code,
    bodySite: r.body_site,
    status: r.status,
    performedBy: r.performed_by,
    performedAt: r.performed_at,
    outcome: r.outcome,
    complication: r.complication,
    notDoneReason: r.not_done_reason,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

const COLS = `id, patient_id, encounter_id, episode_id, name, code_system, code, body_site,
  status, performed_by, performed_at, outcome, complication, not_done_reason, notes, created_at`;

async function assertEncounterForPatient(clinicId: string, encounterId: string, patientId: string): Promise<void> {
  const encounter = await findEncounter(clinicId, encounterId);
  if (!encounter || encounter.patientId !== patientId) {
    throw new ValidationError('encounterId does not belong to this patient');
  }
}

async function assertEpisodeForPatient(client: PoolClient, clinicId: string, episodeId: string, patientId: string): Promise<void> {
  const lineage = await resolvePatientLineage(clinicId, patientId, client);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM treatment_episode WHERE id = $1 AND clinic_id = $2 AND patient_id = ANY($3::uuid[])`,
    [episodeId, clinicId, lineage],
  );
  if (!rows[0]) throw new ValidationError('episodeId does not belong to this patient');
}

export async function recordProcedure(principal: Principal, raw: unknown): Promise<Procedure> {
  requirePermission(principal, Permission.PROCEDURE_WRITE);

  const parsed = RecordProcedureSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid procedure', parsed.error.flatten());
  const input = parsed.data;

  const patient = await getPatientById(principal.clinicId, input.patientId);
  if (!patient) throw new NotFoundError('Patient');
  if (patient.status === 'merged') {
    throw new ConflictError('This record was merged; document on the surviving patient', { mergedIntoId: patient.mergedIntoId });
  }

  return withTransaction(async (client) => {
    if (input.encounterId) await assertEncounterForPatient(principal.clinicId, input.encounterId, patient.id);
    if (input.episodeId) await assertEpisodeForPatient(client, principal.clinicId, input.episodeId, patient.id);

    const completing = input.status === 'completed';
    const { rows } = await client.query<ProcedureRow>(
      `INSERT INTO procedure
         (clinic_id, patient_id, encounter_id, episode_id, name, code_system, code, body_site,
          status, performed_by, performed_at, outcome, complication, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               CASE WHEN $9 = 'completed' THEN COALESCE($11::timestamptz, now()) ELSE $11::timestamptz END,
               $12,$13,$14,$15)
       RETURNING ${COLS}`,
      [
        principal.clinicId,
        patient.id,
        input.encounterId ?? null,
        input.episodeId ?? null,
        input.name,
        input.codeSystem ?? null,
        input.code ?? null,
        input.bodySite ?? null,
        input.status,
        completing ? principal.userId : null,
        input.performedAt ?? null,
        input.outcome ?? null,
        input.complication ?? null,
        input.notes ?? null,
        principal.userId,
      ],
    );
    const procedure = mapProcedure(rows[0]!);

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: completing ? EventType.PROCEDURE_COMPLETED : EventType.PROCEDURE_RECORDED,
      subjectType: 'procedure',
      subjectId: procedure.id,
      actorId: principal.userId,
      // Identifiers, status and coded fields only — name/outcome/notes are
      // clinical narrative and stay in the record.
      payload: {
        patientId: patient.id,
        encounterId: procedure.encounterId,
        status: procedure.status,
        ...(procedure.code ? { code: procedure.code, codeSystem: procedure.codeSystem } : {}),
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'procedure.record',
      outcome: 'success',
      targetType: 'procedure',
      targetId: procedure.id,
      metadata: { patientId: patient.id, status: procedure.status },
    });

    return procedure;
  });
}

export async function updateProcedure(principal: Principal, procedureId: string, raw: unknown): Promise<Procedure> {
  requirePermission(principal, Permission.PROCEDURE_WRITE);

  const parsed = UpdateProcedureSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid update', parsed.error.flatten());
  const patch = parsed.data;

  return withTransaction(async (client) => {
    const { rows: locked } = await client.query<ProcedureRow>(
      `SELECT ${COLS}, status AS status FROM procedure WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [procedureId, principal.clinicId],
    );
    if (!locked[0]) throw new NotFoundError('Procedure');
    const existing = mapProcedure(locked[0]);

    // A completed (or errored/not-done) procedure is immutable here; the only
    // post-completion move is voiding, via the dedicated endpoint.
    if (existing.status === 'completed' || existing.status === 'entered_in_error' || existing.status === 'not_done') {
      throw new ConflictError(`A ${existing.status} procedure can no longer be edited`);
    }

    const nextStatus = patch.status ?? existing.status;
    if (patch.status && patch.status !== existing.status && !ALLOWED[existing.status].includes(patch.status)) {
      throw new ConflictError(`Cannot move a procedure from ${existing.status} to ${patch.status}`, {
        from: existing.status, allowed: ALLOWED[existing.status],
      });
    }
    if (nextStatus === 'not_done' && !patch.notDoneReason && !existing.notDoneReason) {
      throw new ValidationError('A not_done procedure needs notDoneReason');
    }

    const completing = nextStatus === 'completed';
    const { rows } = await client.query<ProcedureRow>(
      `UPDATE procedure SET
          status = $3::text,
          outcome = CASE WHEN $4 THEN $5 ELSE outcome END,
          complication = CASE WHEN $6 THEN $7 ELSE complication END,
          body_site = CASE WHEN $8 THEN $9 ELSE body_site END,
          notes = CASE WHEN $10 THEN $11 ELSE notes END,
          not_done_reason = CASE WHEN $3::text = 'not_done' THEN COALESCE($12, not_done_reason) ELSE not_done_reason END,
          performed_by = CASE WHEN $3::text = 'completed' THEN COALESCE(performed_by, $13::uuid) ELSE performed_by END,
          performed_at = CASE WHEN $3::text = 'completed' THEN COALESCE(performed_at, COALESCE($14::timestamptz, now())) ELSE performed_at END,
          updated_by = $13::uuid,
          updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING ${COLS}`,
      [
        procedureId, principal.clinicId, nextStatus,
        'outcome' in patch, patch.outcome ?? null,
        'complication' in patch, patch.complication ?? null,
        'bodySite' in patch, patch.bodySite ?? null,
        'notes' in patch, patch.notes ?? null,
        patch.notDoneReason ?? null,
        principal.userId, patch.performedAt ?? null,
      ],
    );
    const updated = mapProcedure(rows[0]!);

    if (completing) {
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.PROCEDURE_COMPLETED,
        subjectType: 'procedure',
        subjectId: updated.id,
        actorId: principal.userId,
        payload: { patientId: updated.patientId, encounterId: updated.encounterId, status: updated.status },
      });
    }
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'procedure.update',
      outcome: 'success',
      targetType: 'procedure',
      targetId: updated.id,
      metadata: { patientId: updated.patientId, from: existing.status, to: updated.status },
    });

    return updated;
  });
}

export async function voidProcedure(principal: Principal, procedureId: string, raw: unknown): Promise<Procedure> {
  requirePermission(principal, Permission.PROCEDURE_WRITE);

  const parsed = z.object({ reason: z.string().trim().min(4).max(500) }).safeParse(raw);
  if (!parsed.success) throw new ValidationError('A reason is required', parsed.error.flatten());

  return withTransaction(async (client) => {
    const { rows: locked } = await client.query<ProcedureRow>(
      `SELECT ${COLS} FROM procedure WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [procedureId, principal.clinicId],
    );
    if (!locked[0]) throw new NotFoundError('Procedure');
    const existing = mapProcedure(locked[0]);
    if (existing.status === 'entered_in_error') throw new ConflictError('The procedure is already voided');
    if (!ALLOWED[existing.status].includes('entered_in_error')) {
      throw new ConflictError(`A ${existing.status} procedure cannot be voided`);
    }

    // The immutability trigger permits completed -> entered_in_error only when
    // the clinical content is unchanged, so this UPDATE touches status only.
    const { rows } = await client.query<ProcedureRow>(
      `UPDATE procedure SET status = 'entered_in_error', updated_by = $3, updated_at = now()
        WHERE id = $1 AND clinic_id = $2 RETURNING ${COLS}`,
      [procedureId, principal.clinicId, principal.userId],
    );

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.PROCEDURE_VOIDED,
      subjectType: 'procedure',
      subjectId: procedureId,
      actorId: principal.userId,
      payload: { patientId: existing.patientId },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'procedure.void',
      outcome: 'success',
      targetType: 'procedure',
      targetId: procedureId,
      metadata: { patientId: existing.patientId, from: existing.status },
    });

    return mapProcedure(rows[0]!);
  });
}

export const ListProceduresQuery = z.object({
  status: z.enum(['planned', 'in_progress', 'completed', 'not_done', 'entered_in_error']).optional(),
  encounterId: z.string().uuid().optional(),
  episodeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function listPatientProcedures(principal: Principal, patientId: string, rawQuery: unknown): Promise<Procedure[]> {
  requirePermission(principal, Permission.PROCEDURE_READ);
  const parsed = ListProceduresQuery.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());
  const q = parsed.data;

  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');
  const lineage = await resolvePatientLineage(principal.clinicId, patient.id);

  const { rows } = await getPool().query<ProcedureRow>(
    `SELECT ${COLS} FROM procedure
      WHERE clinic_id = $1 AND patient_id = ANY($2::uuid[])
        -- A voided (entered_in_error) procedure is a correction, not part of the
        -- active record, so it is hidden unless explicitly requested by status.
        AND ($3::text IS NOT NULL OR status <> 'entered_in_error')
        AND ($3::text IS NULL OR status = $3)
        AND ($4::uuid IS NULL OR encounter_id = $4)
        AND ($5::uuid IS NULL OR episode_id = $5)
      ORDER BY created_at DESC LIMIT $6`,
    [principal.clinicId, lineage, q.status ?? null, q.encounterId ?? null, q.episodeId ?? null, q.limit],
  );
  return rows.map(mapProcedure);
}

export async function getProcedure(principal: Principal, procedureId: string): Promise<Procedure> {
  requirePermission(principal, Permission.PROCEDURE_READ);
  const { rows } = await getPool().query<ProcedureRow>(
    `SELECT ${COLS} FROM procedure WHERE id = $1 AND clinic_id = $2`,
    [procedureId, principal.clinicId],
  );
  if (!rows[0]) throw new NotFoundError('Procedure');
  return mapProcedure(rows[0]);
}

/** Encounter-scoped procedures — used by the workspace read. */
export async function listEncounterProcedures(clinicId: string, encounterId: string): Promise<Procedure[]> {
  const { rows } = await getPool().query<ProcedureRow>(
    `SELECT ${COLS} FROM procedure WHERE clinic_id = $1 AND encounter_id = $2 ORDER BY created_at DESC`,
    [clinicId, encounterId],
  );
  return rows.map(mapProcedure);
}
