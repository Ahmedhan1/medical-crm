import QRCode from 'qrcode';
import { getPool, withTransaction } from '../../db/pool.js';
import { config } from '../../config/env.js';
import { NotFoundError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { audit, auditTx } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import { getPatientById, type Patient } from '../identity/patients.repo.js';

// Opaque, versioned payload prefix. Scanners send the whole string back; the
// server resolves it. The payload deliberately contains NO patient data (§43).
const QR_PREFIX = 'MEDCORE1:';

export interface IssuedQr {
  token: string;
  payload: string;
  qrPngDataUrl: string;
  expiresAt: Date;
}

/** Issue a patient-identity QR token and render a scannable PNG (data URL). */
export async function issuePatientQr(
  principal: Principal,
  patientId: string,
): Promise<IssuedQr> {
  requirePermission(principal, Permission.QR_ISSUE);

  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const token = generateToken();
  const payload = QR_PREFIX + token;
  const expiresAt = new Date(Date.now() + config().qrTtlSeconds * 1000);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO qr_token (clinic_id, patient_id, token_hash, kind, created_by, expires_at)
       VALUES ($1,$2,$3,'patient',$4,$5)`,
      [principal.clinicId, patient.id, hashToken(token), principal.userId, expiresAt],
    );
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.QR_ISSUED,
      subjectType: 'patient',
      subjectId: patient.id,
      actorId: principal.userId,
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'qr.issue',
      outcome: 'success',
      targetType: 'patient',
      targetId: patient.id,
    });
  });

  const qrPngDataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
  });

  return { token, payload, qrPngDataUrl, expiresAt };
}

/** Resolve a scanned QR payload/token to the referenced patient. */
export async function resolveQr(principal: Principal, scanned: string): Promise<Patient> {
  requirePermission(principal, Permission.QR_RESOLVE);

  const token = scanned.startsWith(QR_PREFIX) ? scanned.slice(QR_PREFIX.length) : scanned;
  const { rows } = await getPool().query<{ patient_id: string; clinic_id: string }>(
    `SELECT patient_id, clinic_id FROM qr_token
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()`,
    [hashToken(token)],
  );
  const row = rows[0];

  // Cross-clinic tokens must never resolve, even if the hash matches.
  if (!row || row.clinic_id !== principal.clinicId) {
    await audit({
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'qr.resolve',
      outcome: 'error',
      targetType: 'qr_token',
    });
    throw new NotFoundError('QR token');
  }

  const patient = await getPatientById(principal.clinicId, row.patient_id);
  if (!patient) throw new NotFoundError('Patient');

  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'qr.resolve',
    outcome: 'success',
    targetType: 'patient',
    targetId: patient.id,
  });
  return patient;
}
