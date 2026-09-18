import { withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { syncAppointmentFromEncounterTx } from './scheduling.service.js';
import {
  lockEncounter,
  mapEncounter,
  type Encounter,
  type EncounterRow,
  type EncounterStatus,
} from './encounter.repo.js';

/**
 * The encounter state machine (FHIR Encounter-aligned). Transitions are an
 * explicit allow-list: anything not listed here is rejected, so a caller can
 * never drive an encounter into an order the clinic workflow does not permit
 * (e.g. straight from `checked_in` to `completed`, skipping the consultation).
 */
const ALLOWED_TRANSITIONS: Record<EncounterStatus, readonly EncounterStatus[]> = {
  checked_in: ['intake', 'cancelled'],
  intake: ['ready', 'cancelled'],
  ready: ['in_progress', 'cancelled'],
  // A doctor may hand a patient back to the queue instead of completing.
  in_progress: ['completed', 'ready', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canTransition(from: EncounterStatus, to: EncounterStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Statuses reachable through the generic workflow endpoint. `in_progress` and
 * `completed` represent *clinical* authority (a doctor taking and closing a
 * consultation) and are only reachable through the doctor endpoints, so an
 * operational role can never open or close a consultation.
 */
const WORKFLOW_ASSIGNABLE: readonly EncounterStatus[] = ['intake', 'ready', 'cancelled'];

export function assertTransitionAllowed(from: EncounterStatus, to: EncounterStatus): void {
  if (from === to) {
    throw new ConflictError(`Encounter is already ${to}`);
  }
  if (!canTransition(from, to)) {
    throw new ConflictError(`Cannot move an encounter from ${from} to ${to}`, {
      from,
      to,
      allowed: ALLOWED_TRANSITIONS[from],
    });
  }
}

/**
 * Apply a status change to an already-locked encounter and record it as a
 * domain event. Callers must hold the row lock (see `lockEncounter`) and run
 * inside a transaction so the state change and its event commit together.
 */
export async function applyStatusTx(
  client: PoolClient,
  principal: Principal,
  encounter: Encounter,
  to: EncounterStatus,
  reason?: string,
): Promise<Encounter> {
  assertTransitionAllowed(encounter.status, to);

  const { rows } = await client.query<EncounterRow>(
    `UPDATE encounter SET status = $1, updated_at = now()
      WHERE id = $2 AND clinic_id = $3
      RETURNING id, clinic_id, patient_id, status, checked_in_at`,
    [to, encounter.id, principal.clinicId],
  );
  const updated = mapEncounter(rows[0]!);

  await emitEvent(client, {
    clinicId: principal.clinicId,
    type: EventType.ENCOUNTER_STATUS_CHANGED,
    subjectType: 'encounter',
    subjectId: updated.id,
    actorId: principal.userId,
    // `reason` is a controlled workflow note, never free-text PHI (validated
    // by the route schema), so it is safe in the event payload.
    payload: { from: encounter.status, to, ...(reason ? { reason } : {}) },
  });

  return updated;
}

/**
 * Operational status advance (`checked_in → intake → ready`, or cancel).
 * Requires `encounter:status`, held by reception, nurse and doctor.
 */
export async function advanceStatus(
  principal: Principal,
  encounterId: string,
  to: EncounterStatus,
  reason?: string,
): Promise<Encounter> {
  requirePermission(principal, Permission.ENCOUNTER_STATUS);

  if (!WORKFLOW_ASSIGNABLE.includes(to)) {
    throw new ValidationError(
      `Status '${to}' is not settable through this endpoint; use the consultation endpoints`,
      { assignable: WORKFLOW_ASSIGNABLE },
    );
  }

  return withTransaction(async (client) => {
    const encounter = await lockEncounter(client, principal.clinicId, encounterId);
    const updated = await applyStatusTx(client, principal, encounter, to, reason);

    // A cancelled encounter closes its linked appointment (if any) in the same
    // transaction, so a live appointment is never stranded and its room slot is
    // released. The patient had already arrived (that is what opens the linked
    // encounter), so the appointment closes as `left_without_being_seen` rather
    // than `cancelled`. No-op for a walk-in with no appointment.
    if (to === 'cancelled') {
      await syncAppointmentFromEncounterTx(
        client,
        principal,
        encounter.id,
        'left_without_being_seen',
      );
    }

    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'encounter.status',
      outcome: 'success',
      targetType: 'encounter',
      targetId: updated.id,
      metadata: { from: encounter.status, to },
    });

    return updated;
  });
}
