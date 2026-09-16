import { withTransaction, type PoolClient } from '../../db/pool.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import {
  mapEncounter,
  type Encounter,
  type EncounterRow,
} from '../clinical/encounter.repo.js';
import {
  attachDoctorTx,
  completeEncounterTx,
  getWorkspace,
  type EncounterWorkspace,
} from '../clinical/workspace.service.js';

/**
 * Atomically claim the longest-waiting `ready` encounter for this doctor.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe under concurrency: two
 * doctors calling at the same moment each lock a different row rather than
 * queueing on the same one, so the same patient is never handed to both and
 * neither doctor waits. Returns null when the queue is empty.
 */
export async function claimNextReadyTx(
  client: PoolClient,
  principal: Principal,
): Promise<Encounter | null> {
  const { rows } = await client.query<EncounterRow>(
    `UPDATE encounter
        SET status = 'in_progress', updated_at = now()
      WHERE id = (
        SELECT id FROM encounter
         WHERE clinic_id = $1 AND status = 'ready'
         ORDER BY checked_in_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, clinic_id, patient_id, status, checked_in_at`,
    [principal.clinicId],
  );
  if (!rows[0]) return null;

  const claimed = mapEncounter(rows[0]);
  await emitEvent(client, {
    clinicId: principal.clinicId,
    type: EventType.ENCOUNTER_STATUS_CHANGED,
    subjectType: 'encounter',
    subjectId: claimed.id,
    actorId: principal.userId,
    payload: { from: 'ready', to: 'in_progress', reason: 'queue_advance' },
  });
  await attachDoctorTx(client, principal, claimed);
  return claimed;
}

export interface CompleteAndNextResult {
  completed: Encounter;
  next: EncounterWorkspace | null;
}

/**
 * "Save & Next" (blueprint §14): close the consultation in hand and take the
 * next waiting patient in one keystroke. Both happen in a single transaction,
 * so a doctor can never end up with the current visit closed but no patient —
 * or, worse, holding a patient whose visit failed to close.
 */
export async function completeAndNext(
  principal: Principal,
  encounterId: string,
): Promise<CompleteAndNextResult> {
  requirePermission(principal, Permission.ENCOUNTER_COMPLETE);
  requirePermission(principal, Permission.ENCOUNTER_CLINICAL_WRITE);

  const { completed, nextId } = await withTransaction(async (client) => {
    const done = await completeEncounterTx(client, principal, encounterId);
    const claimed = await claimNextReadyTx(client, principal);
    return { completed: done, nextId: claimed?.id ?? null };
  });

  // Assembled after the commit so the workspace reflects committed state and
  // the transaction holds no locks while the (read-only) view is built.
  const next = nextId ? await getWorkspace(principal, nextId) : null;
  return { completed, next };
}

/**
 * Take the next waiting patient without completing anything first — the entry
 * point for a doctor starting their list.
 */
export async function claimNext(principal: Principal): Promise<EncounterWorkspace | null> {
  requirePermission(principal, Permission.ENCOUNTER_CLINICAL_WRITE);

  const claimed = await withTransaction((client) => claimNextReadyTx(client, principal));
  return claimed ? getWorkspace(principal, claimed.id) : null;
}
