import type { PoolClient } from '../db/pool.js';
import { ClinicalEventType } from './events.clinical.js';
import { AutomationEventType } from './events.automation.js';
import { PharmaEventType } from './events.pharma.js';

/**
 * Event catalog BARREL — owned by Agent 1 (Foundation).
 *
 * Merges the per-workstream event catalogs into the typed `EventType` union and
 * provides the transactional emitter. Workstreams add event types in their own
 * `events.<workstream>.ts` file, never here — so parallel agents never edit the
 * same file. Everything important becomes a structured event (blueprint §2);
 * automation and analytics subscribe to these.
 */
export const EventType = {
  ...ClinicalEventType,
  ...AutomationEventType,
  ...PharmaEventType,
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export interface EmitEventInput {
  clinicId: string;
  type: EventType;
  /** Domain entity the event is about, e.g. 'patient', 'encounter', 'hcp'. */
  subjectType: string;
  subjectId: string;
  actorId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Append an event to the store. MUST be called with a transaction client so the
 * event is committed atomically with the state change that produced it — a
 * check-in and its PATIENT_CHECKED_IN event either both persist or neither do.
 */
export async function emitEvent(client: PoolClient, input: EmitEventInput): Promise<void> {
  await client.query(
    `INSERT INTO event (clinic_id, type, subject_type, subject_id, actor_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.clinicId,
      input.type,
      input.subjectType,
      input.subjectId,
      input.actorId ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}
