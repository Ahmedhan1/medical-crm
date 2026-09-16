import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import {
  getEncounterOrThrow,
  lockEncounter,
  TERMINAL_STATUSES,
} from './encounter.repo.js';
import { applyStatusTx, canTransition } from './status.service.js';
import { getIntakeByEncounter, upsertIntake, type Intake } from './intake.repo.js';

const freeText = (max: number) => z.string().trim().max(max).optional();

/**
 * INTAKE WRITE CONTRACT (also consumed by Agent 3's A004 AI intake extraction).
 *
 * `source` records provenance. `ai_assisted` means an AI produced a DRAFT that a
 * human reviewed and confirmed — the confirming human is the authenticated
 * principal and is stored in `confirmed_by`. AI never calls this endpoint
 * unattended: there is no machine principal, and the database rejects an
 * `ai_assisted` row without a confirming user (blueprint §12).
 *
 * `sourceRef` is an opaque provenance string owned by the producing workstream
 * (e.g. an `ai_draft` id). The clinical schema deliberately holds no foreign key
 * to it, so no cross-workstream database coupling is created.
 */
export const RecordIntakeSchema = z.object({
  chiefComplaint: z.string().trim().min(2).max(2_000),
  historyPresentIllness: freeText(8_000),
  pastMedicalHistory: freeText(8_000),
  medicationHistory: freeText(8_000),
  allergies: freeText(2_000),
  familyHistory: freeText(4_000),
  socialHistory: freeText(4_000),
  notes: freeText(4_000),
  source: z.enum(['staff', 'ai_assisted']).default('staff'),
  sourceRef: z.string().trim().min(1).max(200).optional(),
  /**
   * Explicit acknowledgement that a human reviewed an AI-produced draft.
   * Required when `source` is `ai_assisted`; ignored otherwise.
   */
  confirmed: z.boolean().optional(),
});

export type RecordIntakeInput = z.input<typeof RecordIntakeSchema>;

/**
 * Record (or revise) the structured intake for an encounter and advance the
 * encounter into `intake` if it is still `checked_in`. The write, the status
 * transition, the event and the audit row all commit in one transaction.
 */
export async function recordIntake(
  principal: Principal,
  encounterId: string,
  raw: unknown,
): Promise<{ intake: Intake; encounterStatus: string }> {
  requirePermission(principal, Permission.INTAKE_RECORD);

  const parsed = RecordIntakeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid intake data', parsed.error.flatten());
  }
  const input = parsed.data;

  if (input.source === 'ai_assisted' && input.confirmed !== true) {
    throw new ValidationError(
      'An AI-assisted intake must be confirmed by a human reviewer before it is written',
    );
  }

  return withTransaction(async (client) => {
    const encounter = await lockEncounter(client, principal.clinicId, encounterId);
    if (TERMINAL_STATUSES.includes(encounter.status)) {
      throw new ConflictError(`Encounter is ${encounter.status}; intake can no longer be recorded`);
    }

    const { intake, created } = await upsertIntake(client, {
      clinicId: principal.clinicId,
      encounterId: encounter.id,
      patientId: encounter.patientId,
      chiefComplaint: input.chiefComplaint,
      historyPresentIllness: input.historyPresentIllness ?? null,
      pastMedicalHistory: input.pastMedicalHistory ?? null,
      medicationHistory: input.medicationHistory ?? null,
      allergies: input.allergies ?? null,
      familyHistory: input.familyHistory ?? null,
      socialHistory: input.socialHistory ?? null,
      notes: input.notes ?? null,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      confirmedBy: input.source === 'ai_assisted' ? principal.userId : null,
      recordedBy: principal.userId,
    });

    // Event payload carries identifiers and provenance only — never the
    // complaint or history text, which is PHI.
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.INTAKE_RECORDED,
      subjectType: 'encounter',
      subjectId: encounter.id,
      actorId: principal.userId,
      payload: {
        patientId: encounter.patientId,
        intakeId: intake.id,
        revision: created ? 'initial' : 'revised',
        source: intake.source,
      },
    });

    let status = encounter.status;
    if (canTransition(status, 'intake')) {
      const moved = await applyStatusTx(client, principal, encounter, 'intake', 'intake_recorded');
      status = moved.status;
    }

    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'intake.record',
      outcome: 'success',
      targetType: 'encounter',
      targetId: encounter.id,
      // Identifiers and shape only: no complaint text, no history text.
      metadata: {
        patientId: encounter.patientId,
        intakeId: intake.id,
        created,
        source: intake.source,
      },
    });

    return { intake, encounterStatus: status };
  });
}

export async function getIntake(principal: Principal, encounterId: string): Promise<Intake> {
  requirePermission(principal, Permission.INTAKE_READ);
  const encounter = await getEncounterOrThrow(principal.clinicId, encounterId);
  const intake = await getIntakeByEncounter(principal.clinicId, encounter.id);
  if (!intake) throw new NotFoundError('Intake');
  return intake;
}
