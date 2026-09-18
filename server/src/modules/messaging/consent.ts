import { getPool, withTransaction } from '../../db/pool.js';
import { NotFoundError } from '../../domain/errors.js';
import { auditTx } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import type { Channel } from './messaging.types.js';

/**
 * Communication consent / preferences.
 *
 * A message may only be sent on a channel the patient has explicitly opted into
 * (`opted_in`). `unknown` and `opted_out` both block a send — consent is
 * opt-in, never assumed. This is enforced centrally in the send pipeline so no
 * caller can bypass it.
 */
export type ConsentStatus = 'opted_in' | 'opted_out' | 'unknown';

export interface ConsentRecord {
  patientId: string;
  channel: Channel;
  status: ConsentStatus;
  updatedAt: string;
}

interface ConsentRow {
  patient_id: string;
  channel: Channel;
  status: ConsentStatus;
  updated_at: string;
}

/** Resolve a patient's consent for a channel (defaults to `unknown`). */
export async function getConsentStatus(
  clinicId: string,
  patientId: string,
  channel: Channel,
): Promise<ConsentStatus> {
  const { rows } = await getPool().query<{ status: ConsentStatus }>(
    `SELECT status FROM communication_consent
      WHERE clinic_id = $1 AND patient_id = $2 AND channel = $3`,
    [clinicId, patientId, channel],
  );
  return rows[0]?.status ?? 'unknown';
}

/** Only an explicit opt-in permits sending. */
export function isSendAllowed(status: ConsentStatus): boolean {
  return status === 'opted_in';
}

export async function listConsents(clinicId: string, patientId: string): Promise<ConsentRecord[]> {
  const { rows } = await getPool().query<ConsentRow>(
    `SELECT patient_id, channel, status, updated_at
       FROM communication_consent
      WHERE clinic_id = $1 AND patient_id = $2
      ORDER BY channel`,
    [clinicId, patientId],
  );
  return rows.map((r) => ({
    patientId: r.patient_id,
    channel: r.channel,
    status: r.status,
    updatedAt: r.updated_at,
  }));
}

/** Record a consent decision. Authorized + audited; scoped to the caller's clinic. */
export async function setConsent(
  principal: Principal,
  patientId: string,
  channel: Channel,
  status: ConsentStatus,
): Promise<ConsentRecord> {
  requirePermission(principal, Permission.CONSENT_MANAGE);

  return withTransaction(async (client) => {
    // Ensure the patient exists in this clinic (no cross-tenant writes).
    const patient = await client.query<{ id: string }>(
      `SELECT id FROM patient WHERE id = $1 AND clinic_id = $2`,
      [patientId, principal.clinicId],
    );
    if (patient.rows.length === 0) throw new NotFoundError('Patient');

    const { rows } = await client.query<ConsentRow>(
      `INSERT INTO communication_consent (clinic_id, patient_id, channel, status, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (clinic_id, patient_id, channel)
         DO UPDATE SET status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING patient_id, channel, status, updated_at`,
      [principal.clinicId, patientId, channel, status, principal.userId],
    );

    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'consent.set',
      outcome: 'success',
      targetType: 'patient',
      targetId: patientId,
      metadata: { channel, status },
    });

    const r = rows[0]!;
    return { patientId: r.patient_id, channel: r.channel, status: r.status, updatedAt: r.updated_at };
  });
}
