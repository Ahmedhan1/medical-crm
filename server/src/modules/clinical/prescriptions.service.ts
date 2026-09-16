import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';
import { getEncounterOrThrow, lockEncounter, TERMINAL_STATUSES } from './encounter.repo.js';
import { resolvePatientLineage } from '../identity/patients.lifecycle.service.js';
import { checkPrescriptionSafety, type SafetyAlert } from './safety.service.js';
import { getEncounterClinical } from './encounter.clinical.repo.js';

/**
 * Prescribing (blueprint: Treatment → Prescription).
 *
 * A prescription is a legal document: once issued it is immutable, and a
 * mistake is corrected by cancelling it and issuing a new one rather than by
 * editing something a pharmacist may already have dispensed against. The
 * database enforces that (migration 0103); this layer enforces who may do it.
 */

export const ROUTES = [
  'oral',
  'topical',
  'inhaled',
  'intravenous',
  'intramuscular',
  'subcutaneous',
  'rectal',
  'ophthalmic',
  'otic',
  'nasal',
  'other',
] as const;

export const PrescriptionItemSchema = z.object({
  medicationName: z.string().trim().min(2).max(200),
  /**
   * Opaque reference to a medication-master concept. A plain string with no
   * foreign key: the catalog belongs to another workstream, and a hard link
   * would make prescribing impossible for anything not yet in it (CCR-001).
   */
  medicationRef: z.string().trim().min(1).max(200).optional(),
  dose: z.string().trim().min(1).max(100),
  route: z.enum(ROUTES),
  frequency: z.string().trim().min(1).max(100),
  durationDays: z.number().int().min(1).max(365).optional(),
  quantity: z.string().trim().min(1).max(100).optional(),
  instructions: z.string().trim().max(2_000).optional(),
});

export const IssuePrescriptionSchema = z.object({
  items: z.array(PrescriptionItemSchema).min(1).max(50),
  notes: z.string().trim().max(2_000).optional(),
  /**
   * Prescribe despite the deterministic safety alerts (allergy /
   * duplicate-medication). Requires `safety:override` and a reason; the
   * decision is recorded in the append-only safety_override ledger.
   */
  acknowledgeAlerts: z.boolean().default(false),
  overrideReason: z.string().trim().min(4).max(500).optional(),
});

export const CancelPrescriptionSchema = z.object({
  reason: z.string().trim().min(2).max(500),
});

export interface PrescriptionItem {
  id: string;
  lineNo: number;
  medicationName: string;
  medicationRef: string | null;
  dose: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  quantity: string | null;
  instructions: string | null;
}

export interface Prescription {
  id: string;
  encounterId: string;
  patientId: string;
  prescriberId: string;
  status: 'active' | 'cancelled';
  notes: string | null;
  issuedAt: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  items: PrescriptionItem[];
}

interface PrescriptionRow {
  id: string;
  encounter_id: string;
  patient_id: string;
  prescriber_id: string;
  status: 'active' | 'cancelled';
  notes: string | null;
  issued_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  items: PrescriptionItem[] | null;
}

/**
 * Prescriptions always travel with their items — a prescription without its
 * lines is not a meaningful clinical object, so the items are aggregated in the
 * query rather than fetched separately and risked being forgotten.
 */
const PRESCRIPTION_SELECT = `
  SELECT p.id, p.encounter_id, p.patient_id, p.prescriber_id, p.status, p.notes,
         p.issued_at, p.cancelled_at, p.cancelled_by, p.cancellation_reason,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'id', i.id, 'lineNo', i.line_no,
                    'medicationName', i.medication_name, 'medicationRef', i.medication_ref,
                    'dose', i.dose, 'route', i.route, 'frequency', i.frequency,
                    'durationDays', i.duration_days, 'quantity', i.quantity,
                    'instructions', i.instructions) ORDER BY i.line_no)
             FROM prescription_item i
            WHERE i.prescription_id = p.id
         ), '[]'::jsonb) AS items
    FROM prescription p`;

function mapPrescription(r: PrescriptionRow): Prescription {
  return {
    id: r.id,
    encounterId: r.encounter_id,
    patientId: r.patient_id,
    prescriberId: r.prescriber_id,
    status: r.status,
    notes: r.notes,
    issuedAt: r.issued_at,
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
    cancellationReason: r.cancellation_reason,
    items: r.items ?? [],
  };
}

async function loadPrescription(
  runner: Pick<PoolClient, 'query'>,
  clinicId: string,
  prescriptionId: string,
): Promise<Prescription | null> {
  const { rows } = await runner.query<PrescriptionRow>(
    `${PRESCRIPTION_SELECT} WHERE p.clinic_id = $1 AND p.id = $2`,
    [clinicId, prescriptionId],
  );
  return rows[0] ? mapPrescription(rows[0]) : null;
}

/**
 * Issue a prescription against an open consultation held by this doctor. The
 * prescription and every line commit together: a partially written prescription
 * must never be dispensable.
 */
export async function issuePrescription(
  principal: Principal,
  encounterId: string,
  raw: unknown,
): Promise<Prescription> {
  requirePermission(principal, Permission.PRESCRIPTION_WRITE);

  const parsed = IssuePrescriptionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid prescription', parsed.error.flatten());
  }
  const input = parsed.data;

  return withTransaction(async (client) => {
    const encounter = await lockEncounter(client, principal.clinicId, encounterId);
    if (TERMINAL_STATUSES.includes(encounter.status)) {
      throw new ConflictError(`Encounter is ${encounter.status}; it can no longer be prescribed on`);
    }
    if (encounter.status !== 'in_progress') {
      throw new ConflictError(
        'The consultation has not been started; call POST /encounters/:id/start first',
        { status: encounter.status },
      );
    }
    const clinical = await getEncounterClinical(principal.clinicId, encounter.id, client);
    if (clinical?.attendingDoctorId && clinical.attendingDoctorId !== principal.userId) {
      // Prescribing is personal clinical responsibility: the prescriber must be
      // the clinician holding the consultation.
      throw new ConflictError('This consultation is held by another clinician');
    }

    // Deterministic safety check (Phase 8). Read allergies across the patient's
    // whole merge lineage, so a duplicate record folded in still protects them.
    const lineage = await resolvePatientLineage(principal.clinicId, encounter.patientId, client);
    const alerts = await checkPrescriptionSafety(client, principal.clinicId, lineage, input.items);
    if (alerts.length > 0 && !input.acknowledgeAlerts) {
      // Refuse by default; the clinician can re-submit with an acknowledgement.
      // The alert detail lets the UI show exactly what is being flagged.
      throw new ConflictError('Prescription blocked by a safety alert', { alerts });
    }
    if (alerts.length > 0) {
      // Overriding a safety alert is a distinct, high-consequence authority.
      requirePermission(principal, Permission.SAFETY_OVERRIDE);
      if (!input.overrideReason) {
        throw new ValidationError('A reason is required to override a safety alert');
      }
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO prescription (clinic_id, encounter_id, patient_id, prescriber_id, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        principal.clinicId,
        encounter.id,
        encounter.patientId,
        principal.userId,
        input.notes ?? null,
      ],
    );
    const prescriptionId = rows[0]!.id;

    for (const [index, item] of input.items.entries()) {
      await client.query(
        `INSERT INTO prescription_item
           (clinic_id, prescription_id, line_no, medication_name, medication_ref,
            dose, route, frequency, duration_days, quantity, instructions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          principal.clinicId,
          prescriptionId,
          index + 1,
          item.medicationName,
          item.medicationRef ?? null,
          item.dose,
          item.route,
          item.frequency,
          item.durationDays ?? null,
          item.quantity ?? null,
          item.instructions ?? null,
        ],
      );
    }

    if (alerts.length > 0) {
      await client.query(
        `INSERT INTO safety_override
           (clinic_id, patient_id, prescription_id, alert_type, alerts, reason, overridden_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          principal.clinicId,
          encounter.patientId,
          prescriptionId,
          alerts.map((a) => a.type).join(','),
          JSON.stringify(alerts),
          input.overrideReason,
          principal.userId,
        ],
      );
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.SAFETY_ALERT_OVERRIDDEN,
        subjectType: 'prescription',
        subjectId: prescriptionId,
        actorId: principal.userId,
        payload: {
          patientId: encounter.patientId,
          alertTypes: [...new Set(alerts.map((a) => a.type))],
          alertCount: alerts.length,
        },
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'safety.override',
        outcome: 'success',
        targetType: 'prescription',
        targetId: prescriptionId,
        metadata: {
          patientId: encounter.patientId,
          alertTypes: [...new Set(alerts.map((a) => a.type))],
          alertCount: alerts.length,
        },
      });
    }

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.PRESCRIPTION_ISSUED,
      subjectType: 'prescription',
      subjectId: prescriptionId,
      actorId: principal.userId,
      // Identifiers and count only: what was prescribed stays in the record.
      payload: {
        patientId: encounter.patientId,
        encounterId: encounter.id,
        itemCount: input.items.length,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'prescription.issue',
      outcome: 'success',
      targetType: 'prescription',
      targetId: prescriptionId,
      metadata: {
        patientId: encounter.patientId,
        encounterId: encounter.id,
        itemCount: input.items.length,
      },
    });

    return (await loadPrescription(client, principal.clinicId, prescriptionId))!;
  });
}

/**
 * Dry-run the safety checks for a set of candidate lines without prescribing.
 * Lets a client show allergy / duplicate alerts as the doctor builds a
 * prescription, before they commit to issuing it.
 */
export async function previewPrescriptionSafety(
  principal: Principal,
  encounterId: string,
  raw: unknown,
): Promise<{ alerts: SafetyAlert[] }> {
  requirePermission(principal, Permission.PRESCRIPTION_WRITE);

  const parsed = z
    .object({ items: z.array(PrescriptionItemSchema).min(1).max(50) })
    .safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid prescription', parsed.error.flatten());
  }

  const encounter = await getEncounterOrThrow(principal.clinicId, encounterId);
  const lineage = await resolvePatientLineage(principal.clinicId, encounter.patientId);
  const alerts = await checkPrescriptionSafety(
    getPool(),
    principal.clinicId,
    lineage,
    parsed.data.items,
  );
  return { alerts };
}

export async function cancelPrescription(
  principal: Principal,
  prescriptionId: string,
  raw: unknown,
): Promise<Prescription> {
  requirePermission(principal, Permission.PRESCRIPTION_WRITE);

  const parsed = CancelPrescriptionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid cancellation', parsed.error.flatten());
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; patient_id: string; status: string }>(
      `SELECT id, patient_id, status FROM prescription
        WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [prescriptionId, principal.clinicId],
    );
    const existing = rows[0];
    if (!existing) throw new NotFoundError('Prescription');
    if (existing.status !== 'active') {
      throw new ConflictError(`Prescription is already ${existing.status}`);
    }

    await client.query(
      `UPDATE prescription
          SET status = 'cancelled', cancelled_at = now(), cancelled_by = $3,
              cancellation_reason = $4
        WHERE id = $1 AND clinic_id = $2`,
      [existing.id, principal.clinicId, principal.userId, parsed.data.reason],
    );

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.PRESCRIPTION_CANCELLED,
      subjectType: 'prescription',
      subjectId: existing.id,
      actorId: principal.userId,
      payload: { patientId: existing.patient_id },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'prescription.cancel',
      outcome: 'success',
      targetType: 'prescription',
      targetId: existing.id,
      metadata: { patientId: existing.patient_id },
    });

    return (await loadPrescription(client, principal.clinicId, existing.id))!;
  });
}

export async function getPrescription(
  principal: Principal,
  prescriptionId: string,
): Promise<Prescription> {
  requirePermission(principal, Permission.PRESCRIPTION_READ);
  const prescription = await loadPrescription(getPool(), principal.clinicId, prescriptionId);
  if (!prescription) throw new NotFoundError('Prescription');
  return prescription;
}

export async function listEncounterPrescriptions(
  clinicId: string,
  encounterId: string,
  runner: Pick<PoolClient, 'query'> = getPool(),
): Promise<Prescription[]> {
  const { rows } = await runner.query<PrescriptionRow>(
    `${PRESCRIPTION_SELECT}
      WHERE p.clinic_id = $1 AND p.encounter_id = $2
      ORDER BY p.issued_at DESC`,
    [clinicId, encounterId],
  );
  return rows.map(mapPrescription);
}

export async function listPrescriptionsForEncounter(
  principal: Principal,
  encounterId: string,
): Promise<Prescription[]> {
  requirePermission(principal, Permission.PRESCRIPTION_READ);
  const encounter = await getEncounterOrThrow(principal.clinicId, encounterId);
  return listEncounterPrescriptions(principal.clinicId, encounter.id);
}

export const ListPrescriptionsSchema = z.object({
  status: z.enum(['active', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function listPrescriptionsForPatient(
  principal: Principal,
  patientId: string,
  rawQuery: unknown,
): Promise<Prescription[]> {
  requirePermission(principal, Permission.PRESCRIPTION_READ);

  const parsed = ListPrescriptionsSchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    throw new ValidationError('Invalid prescription query', parsed.error.flatten());
  }
  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const { rows } = await getPool().query<PrescriptionRow>(
    `${PRESCRIPTION_SELECT}
      WHERE p.clinic_id = $1 AND p.patient_id = $2
        AND ($3::text IS NULL OR p.status = $3)
      ORDER BY p.issued_at DESC
      LIMIT $4`,
    [principal.clinicId, patient.id, parsed.data.status ?? null, parsed.data.limit],
  );
  return rows.map(mapPrescription);
}
