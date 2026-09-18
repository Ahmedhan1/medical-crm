import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { toIsoDate } from './dates.js';
import { getPatientById } from '../identity/patients.repo.js';

/**
 * Structured patient allergies (Phase 8). Distinct from `intake.allergies`,
 * which is a free-text note captured during triage: this is the durable,
 * queryable safety record that the prescribing check reads.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const RecordAllergySchema = z.object({
  substance: z.string().trim().min(1).max(200),
  substanceRef: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(['allergy', 'intolerance']).default('allergy'),
  category: z.enum(['medication', 'food', 'environment', 'other']).default('medication'),
  reaction: z.string().trim().max(1_000).optional(),
  severity: z.enum(['mild', 'moderate', 'severe', 'life_threatening']).default('moderate'),
  verification: z.enum(['unconfirmed', 'confirmed', 'refuted']).default('unconfirmed'),
  onsetDate: isoDate.optional(),
  notes: z.string().trim().max(2_000).optional(),
});

export const UpdateAllergySchema = z
  .object({
    severity: z.enum(['mild', 'moderate', 'severe', 'life_threatening']).optional(),
    status: z.enum(['active', 'inactive', 'resolved', 'entered_in_error']).optional(),
    verification: z.enum(['unconfirmed', 'confirmed', 'refuted']).optional(),
    reaction: z.string().trim().max(1_000).nullable().optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export interface Allergy {
  id: string;
  patientId: string;
  substance: string;
  substanceRef: string | null;
  kind: 'allergy' | 'intolerance';
  category: 'medication' | 'food' | 'environment' | 'other';
  reaction: string | null;
  severity: 'mild' | 'moderate' | 'severe' | 'life_threatening';
  status: 'active' | 'inactive' | 'resolved' | 'entered_in_error';
  verification: 'unconfirmed' | 'confirmed' | 'refuted';
  onsetDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AllergyRow {
  id: string;
  patient_id: string;
  substance: string;
  substance_ref: string | null;
  kind: Allergy['kind'];
  category: Allergy['category'];
  reaction: string | null;
  severity: Allergy['severity'];
  status: Allergy['status'];
  verification: Allergy['verification'];
  onset_date: string | Date | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function mapAllergy(r: AllergyRow): Allergy {
  return {
    id: r.id,
    patientId: r.patient_id,
    substance: r.substance,
    substanceRef: r.substance_ref,
    kind: r.kind,
    category: r.category,
    reaction: r.reaction,
    severity: r.severity,
    status: r.status,
    verification: r.verification,
    onsetDate: toIsoDate(r.onset_date),
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const ALLERGY_COLS = `id, patient_id, substance, substance_ref, kind, category, reaction,
  severity, status, verification, onset_date, notes, created_at, updated_at`;

export async function recordAllergy(
  principal: Principal,
  patientId: string,
  raw: unknown,
): Promise<Allergy> {
  requirePermission(principal, Permission.ALLERGY_WRITE);

  const parsed = RecordAllergySchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid allergy', parsed.error.flatten());
  const input = parsed.data;

  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');
  if (patient.status === 'merged') {
    throw new ConflictError('This record was merged; record the allergy on the surviving patient', {
      mergedIntoId: patient.mergedIntoId,
    });
  }

  return withTransaction(async (client) => {
    let allergy: Allergy;
    try {
      const { rows } = await client.query<AllergyRow>(
        `INSERT INTO allergy
           (clinic_id, patient_id, substance, substance_ref, kind, category, reaction,
            severity, verification, onset_date, notes, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING ${ALLERGY_COLS}`,
        [
          principal.clinicId,
          patient.id,
          input.substance,
          input.substanceRef ?? null,
          input.kind,
          input.category,
          input.reaction ?? null,
          input.severity,
          input.verification,
          input.onsetDate ?? null,
          input.notes ?? null,
          principal.userId,
        ],
      );
      allergy = mapAllergy(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('An active allergy to that substance is already recorded');
      }
      throw err;
    }

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.ALLERGY_RECORDED,
      subjectType: 'patient',
      subjectId: patient.id,
      actorId: principal.userId,
      // Category and severity are controlled vocabulary; the substance is
      // clinically identifying and stays in the record.
      payload: { patientId: patient.id, allergyId: allergy.id, category: allergy.category, severity: allergy.severity },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'allergy.record',
      outcome: 'success',
      targetType: 'allergy',
      targetId: allergy.id,
      metadata: { patientId: patient.id, category: allergy.category, severity: allergy.severity },
    });

    return allergy;
  });
}

export async function updateAllergy(
  principal: Principal,
  patientId: string,
  allergyId: string,
  raw: unknown,
): Promise<Allergy> {
  requirePermission(principal, Permission.ALLERGY_WRITE);

  const parsed = UpdateAllergySchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid allergy update', parsed.error.flatten());
  const patch = parsed.data;

  return withTransaction(async (client) => {
    const { rows: locked } = await client.query<AllergyRow>(
      `SELECT ${ALLERGY_COLS} FROM allergy
        WHERE clinic_id = $1 AND id = $2 AND patient_id = $3 FOR UPDATE`,
      [principal.clinicId, allergyId, patientId],
    );
    if (!locked[0]) throw new NotFoundError('Allergy');
    const existing = mapAllergy(locked[0]);

    const columns: Record<string, string> = {
      severity: 'severity',
      status: 'status',
      verification: 'verification',
      reaction: 'reaction',
      notes: 'notes',
    };
    const sets: string[] = [];
    const values: unknown[] = [principal.clinicId, allergyId, principal.userId];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        values.push((patch as Record<string, unknown>)[key] ?? null);
        sets.push(`${column} = $${values.length}`);
      }
    }

    let updated: Allergy;
    try {
      const { rows } = await client.query<AllergyRow>(
        `UPDATE allergy SET ${[...sets, 'updated_by = $3', 'updated_at = now()'].join(', ')}
          WHERE clinic_id = $1 AND id = $2
          RETURNING ${ALLERGY_COLS}`,
        values,
      );
      updated = mapAllergy(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('Reactivating this allergy would duplicate an existing active one');
      }
      throw err;
    }

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.ALLERGY_UPDATED,
      subjectType: 'patient',
      subjectId: existing.patientId,
      actorId: principal.userId,
      payload: { patientId: existing.patientId, allergyId, fields: Object.keys(patch) },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'allergy.update',
      outcome: 'success',
      targetType: 'allergy',
      targetId: allergyId,
      metadata: {
        patientId: existing.patientId,
        fields: Object.keys(patch),
        ...(patch.status ? { from: existing.status, to: patch.status } : {}),
      },
    });

    return updated;
  });
}

export async function listAllergies(
  principal: Principal,
  patientId: string,
  includeInactive = false,
): Promise<Allergy[]> {
  requirePermission(principal, Permission.ALLERGY_READ);
  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const { rows } = await getPool().query<AllergyRow>(
    `SELECT ${ALLERGY_COLS} FROM allergy
      WHERE clinic_id = $1 AND patient_id = $2
        AND ($3::boolean OR status = 'active')
      ORDER BY
        (status = 'active') DESC,
        array_position(ARRAY['life_threatening','severe','moderate','mild'], severity),
        substance`,
    [principal.clinicId, patient.id, includeInactive],
  );
  return rows.map(mapAllergy);
}

/**
 * Active, non-refuted medication allergies for a patient. The prescribing
 * safety check reads exactly this set. Runs on a supplied client so it can be
 * part of the prescribing transaction.
 */
export async function activeMedicationAllergies(
  client: Pick<PoolClient, 'query'>,
  clinicId: string,
  patientIds: string[],
): Promise<Allergy[]> {
  const { rows } = await client.query<AllergyRow>(
    `SELECT ${ALLERGY_COLS} FROM allergy
      WHERE clinic_id = $1 AND patient_id = ANY($2::uuid[])
        AND status = 'active' AND verification <> 'refuted' AND category = 'medication'`,
    [clinicId, patientIds],
  );
  return rows.map(mapAllergy);
}
