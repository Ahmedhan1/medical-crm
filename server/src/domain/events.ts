import type { PoolClient } from '../db/pool.js';

/**
 * Canonical event catalog (blueprint §2). Everything important becomes a
 * structured event; automation and analytics subscribe to these rather than
 * polling tables. Keeping the set as a const object gives us a typed union and
 * avoids magic strings scattered through the codebase.
 */
export const EventType = {
  PATIENT_REGISTERED: 'PATIENT_REGISTERED',
  PATIENT_CHECKED_IN: 'PATIENT_CHECKED_IN',
  ENCOUNTER_STATUS_CHANGED: 'ENCOUNTER_STATUS_CHANGED',
  QR_ISSUED: 'QR_ISSUED',
  QR_RESOLVED: 'QR_RESOLVED',
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export interface EmitEventInput {
  clinicId: string;
  type: EventType;
  subjectType: 'patient' | 'encounter' | 'qr_token';
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
