import { z } from 'zod';
import { getPool, withTransaction } from '../../db/pool.js';
import { ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { toIsoDate, todayIso } from './dates.js';

/**
 * Overdue follow-up DETECTION (Phase 11).
 *
 * This is a read-model + a deterministic event sweep over the existing
 * `follow_up` records (migration 0103). It never diagnoses, prescribes, or
 * modifies a clinical fact — it observes clinician-defined follow-up dates and
 * classifies them, and publishes FOLLOW_UP_DUE / FOLLOW_UP_OVERDUE for Agent 3
 * to act on. It sends nothing itself.
 *
 * Determinism: the only inputs are a follow-up's `due_on`, its status, and a
 * reference date. No heuristics, no thresholds beyond an explicit
 * `approachingDays`, no probabilistic or AI logic. The same inputs always yield
 * the same state.
 */

export type FollowUpDueState = 'overdue' | 'due' | 'approaching' | 'upcoming';

/**
 * Classify a scheduled follow-up's due state relative to a reference date.
 * `overdue` = past due; `due` = due on the reference date; `approaching` = due
 * within `approachingDays`; `upcoming` = further out. Pure and total.
 */
export function classifyDueState(
  dueOn: string,
  asOf: string,
  approachingDays: number,
): FollowUpDueState {
  if (dueOn < asOf) return 'overdue';
  if (dueOn === asOf) return 'due';
  const horizon = new Date(`${asOf}T00:00:00.000Z`);
  horizon.setUTCDate(horizon.getUTCDate() + approachingDays);
  const horizonIso = horizon.toISOString().slice(0, 10);
  if (dueOn <= horizonIso) return 'approaching';
  return 'upcoming';
}

const DetectionQuery = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  approachingDays: z.coerce.number().int().min(1).max(90).default(7),
  state: z.enum(['overdue', 'due', 'approaching', 'upcoming']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export interface FollowUpDetectionEntry {
  id: string;
  patientId: string;
  patientName: string;
  mrn: string;
  originEncounterId: string | null;
  dueOn: string;
  reason: string | null;
  dueState: FollowUpDueState;
  /** Signed days from the reference date to the due date (negative = overdue). */
  daysUntilDue: number;
}

interface DetectionRow {
  id: string;
  patient_id: string;
  full_name: string;
  mrn: string;
  origin_encounter_id: string | null;
  due_on: string | Date;
  reason: string | null;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(
    Number(fromIso.slice(0, 4)),
    Number(fromIso.slice(5, 7)) - 1,
    Number(fromIso.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(toIso.slice(0, 4)),
    Number(toIso.slice(5, 7)) - 1,
    Number(toIso.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000);
}

/**
 * The follow-up detection worklist: scheduled follow-ups classified against a
 * reference date. A read — it publishes nothing and changes nothing. Gated on
 * `followup:read`, which reception, nurse and doctor hold.
 */
export async function getFollowUpDetection(
  principal: Principal,
  rawQuery: unknown,
): Promise<{ asOf: string; approachingDays: number; entries: FollowUpDetectionEntry[] }> {
  requirePermission(principal, Permission.FOLLOWUP_READ);

  const parsed = DetectionQuery.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());
  const asOf = parsed.data.asOf ?? todayIso();
  const { approachingDays, state, limit } = parsed.data;

  const { rows } = await getPool().query<DetectionRow>(
    `SELECT f.id, f.patient_id, p.full_name, p.mrn, f.origin_encounter_id, f.due_on, f.reason
       FROM follow_up f
       JOIN patient p ON p.id = f.patient_id AND p.clinic_id = f.clinic_id
      WHERE f.clinic_id = $1 AND f.status = 'scheduled'
      ORDER BY f.due_on ASC, f.created_at ASC
      LIMIT $2`,
    [principal.clinicId, limit],
  );

  const entries = rows
    .map((r): FollowUpDetectionEntry => {
      const dueOn = toIsoDate(r.due_on)!;
      return {
        id: r.id,
        patientId: r.patient_id,
        patientName: r.full_name,
        mrn: r.mrn,
        originEncounterId: r.origin_encounter_id,
        dueOn,
        reason: r.reason,
        dueState: classifyDueState(dueOn, asOf, approachingDays),
        daysUntilDue: daysBetween(asOf, dueOn),
      };
    })
    .filter((e) => (state ? e.dueState === state : true));

  return { asOf, approachingDays, entries };
}

export interface DetectionSweepResult {
  asOf: string;
  scanned: number;
  dueEmitted: number;
  overdueEmitted: number;
}

/**
 * The idempotent detection sweep. Publishes FOLLOW_UP_DUE the first time a
 * follow-up is due on the reference date, and FOLLOW_UP_OVERDUE the first time
 * it is past due — each at most once, guarded by the marker columns
 * (migration 0110). Re-running is a no-op. This is what a scheduler (Agent 3 or
 * the platform) invokes; Clinical Core does not schedule it.
 *
 * The sweep uses the server's current date, never a caller-supplied one, so it
 * cannot be driven to emit overdue events prematurely.
 */
export async function runFollowUpDetection(
  principal: Principal,
  rawQuery: unknown,
): Promise<DetectionSweepResult> {
  requirePermission(principal, Permission.FOLLOWUP_DETECT);

  const parsed = z
    .object({ approachingDays: z.coerce.number().int().min(1).max(90).default(7) })
    .safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());

  const asOf = todayIso();

  return withTransaction(async (client) => {
    // Lock the pending rows; SKIP LOCKED lets two concurrent sweeps divide the
    // work without emitting duplicates or blocking each other.
    const { rows } = await client.query<{
      id: string;
      patient_id: string;
      due_on: string | Date;
      due_event_at: string | null;
      overdue_event_at: string | null;
    }>(
      `SELECT id, patient_id, due_on, due_event_at, overdue_event_at
         FROM follow_up
        WHERE clinic_id = $1 AND status = 'scheduled'
          AND due_on <= $2::date
          AND (due_event_at IS NULL OR overdue_event_at IS NULL)
        ORDER BY due_on ASC
        FOR UPDATE SKIP LOCKED`,
      [principal.clinicId, asOf],
    );

    let dueEmitted = 0;
    let overdueEmitted = 0;

    for (const row of rows) {
      const dueOn = toIsoDate(row.due_on)!;
      const isOverdue = dueOn < asOf;

      if (isOverdue && row.overdue_event_at === null) {
        await emitEvent(client, {
          clinicId: principal.clinicId,
          type: EventType.FOLLOW_UP_OVERDUE,
          subjectType: 'follow_up',
          subjectId: row.id,
          actorId: principal.userId,
          // Identifiers and the due date only — the clinical reason stays out.
          payload: { patientId: row.patient_id, dueOn },
        });
        // Stamp both markers: an overdue follow-up should not also fire DUE.
        await client.query(
          `UPDATE follow_up
              SET overdue_event_at = now(),
                  due_event_at = COALESCE(due_event_at, now())
            WHERE id = $1 AND clinic_id = $2`,
          [row.id, principal.clinicId],
        );
        overdueEmitted += 1;
      } else if (!isOverdue && row.due_event_at === null) {
        await emitEvent(client, {
          clinicId: principal.clinicId,
          type: EventType.FOLLOW_UP_DUE,
          subjectType: 'follow_up',
          subjectId: row.id,
          actorId: principal.userId,
          payload: { patientId: row.patient_id, dueOn },
        });
        await client.query(
          `UPDATE follow_up SET due_event_at = now() WHERE id = $1 AND clinic_id = $2`,
          [row.id, principal.clinicId],
        );
        dueEmitted += 1;
      }
    }

    if (dueEmitted > 0 || overdueEmitted > 0) {
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'followup.detect',
        outcome: 'success',
        targetType: 'clinic',
        targetId: principal.clinicId,
        metadata: { asOf, scanned: rows.length, dueEmitted, overdueEmitted },
      });
    }

    return { asOf, scanned: rows.length, dueEmitted, overdueEmitted };
  });
}
