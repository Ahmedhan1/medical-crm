import { getPool } from '../../db/pool.js';
import type { Channel } from './messaging.types.js';

/**
 * Resolve a patient's messaging destination and the pipeline-provided template
 * variables, live from stable records (`patient`, `clinic`).
 *
 * These values are read on every send/retry and passed in-memory to the
 * provider; they are NEVER written to `message_log`. Retryable messages are
 * therefore fully re-renderable from `patient_id + template_key + locale`
 * without persisting any PHI.
 *
 * The `patient` table is part of the shared foundation schema (migration
 * 0001_core); this module reads only the minimal, clinic-scoped fields it needs
 * to address a message.
 */
export interface ResolvedRecipient {
  /** Destination address for the channel (phone for whatsapp/sms). */
  to: string;
  /** Pipeline variables available to every template. All re-derivable. */
  variables: Record<string, string>;
}

export async function resolvePatientRecipient(
  clinicId: string,
  patientId: string,
  channel: Channel,
): Promise<ResolvedRecipient | null> {
  const { rows } = await getPool().query<{
    full_name: string;
    mrn: string;
    phone: string | null;
    clinic_name: string;
  }>(
    `SELECT p.full_name, p.mrn, p.phone, c.name AS clinic_name
       FROM patient p
       JOIN clinic c ON c.id = p.clinic_id
      WHERE p.id = $1 AND p.clinic_id = $2`,
    [patientId, clinicId],
  );
  const row = rows[0];
  if (!row) return null;

  // Email is not yet a patient attribute in the core schema; only phone-based
  // channels can be auto-addressed from a patient record today.
  const to = channel === 'email' ? null : row.phone;
  if (!to) return null;

  return {
    to,
    variables: {
      patientName: row.full_name,
      firstName: row.full_name.split(/\s+/)[0] ?? row.full_name,
      mrn: row.mrn,
      clinicName: row.clinic_name,
    },
  };
}
