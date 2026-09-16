import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx, audit } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import {
  findDuplicate,
  getPatientById,
  insertPatient,
  nextMrn,
  searchPatients,
  type Patient,
} from './patients.repo.js';

export const RegisterPatientSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  sex: z.enum(['male', 'female', 'other', 'unknown']),
  birthDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'birthDate must be YYYY-MM-DD')
    .optional(),
  phone: z.string().trim().min(5).max(32).optional(),
  nationalId: z.string().trim().min(4).max(40).optional(),
  // When true, register even if a soft duplicate (name+phone) is detected.
  overrideDuplicate: z.boolean().optional().default(false),
});

export type RegisterPatientInput = z.infer<typeof RegisterPatientSchema>;

/**
 * Register a patient. Enforces permission, tenant scope, and a duplicate guard,
 * then persists the patient, emits PATIENT_REGISTERED, and writes an audit row —
 * all in one transaction so the three succeed or fail together.
 */
export async function registerPatient(
  principal: Principal,
  raw: unknown,
): Promise<Patient> {
  requirePermission(principal, Permission.PATIENT_REGISTER);

  const parsed = RegisterPatientSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid patient data', parsed.error.flatten());
  }
  const input = parsed.data;

  return withTransaction(async (client) => {
    const dup = await findDuplicate(
      client,
      principal.clinicId,
      input.fullName,
      input.phone ?? null,
      input.nationalId ?? null,
    );
    if (dup) {
      // A national-id match is always a hard block; a name+phone match can be
      // overridden by staff who confirm it is a genuinely different person.
      const isNationalIdMatch =
        !!input.nationalId && dup.nationalId === input.nationalId;
      if (isNationalIdMatch || !input.overrideDuplicate) {
        await auditTx(client, {
          clinicId: principal.clinicId,
          actorId: principal.userId,
          action: 'patient.register',
          outcome: 'denied',
          targetType: 'patient',
          targetId: dup.id,
          metadata: { reason: 'duplicate', hard: isNationalIdMatch },
        });
        throw new ConflictError(
          isNationalIdMatch
            ? 'A patient with this national ID already exists'
            : 'A patient with the same name and phone already exists. Set overrideDuplicate to proceed.',
          { existingPatientId: dup.id, mrn: dup.mrn },
        );
      }
    }

    const mrn = await nextMrn(client);
    const patient = await insertPatient(client, {
      clinicId: principal.clinicId,
      mrn,
      fullName: input.fullName,
      sex: input.sex,
      birthDate: input.birthDate ?? null,
      phone: input.phone ?? null,
      nationalId: input.nationalId ?? null,
      createdBy: principal.userId,
    });

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.PATIENT_REGISTERED,
      subjectType: 'patient',
      subjectId: patient.id,
      actorId: principal.userId,
      payload: { mrn: patient.mrn },
    });

    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'patient.register',
      outcome: 'success',
      targetType: 'patient',
      targetId: patient.id,
      metadata: { mrn: patient.mrn },
    });

    return patient;
  });
}

export async function getPatient(principal: Principal, patientId: string): Promise<Patient> {
  requirePermission(principal, Permission.PATIENT_READ);
  const patient = await getPatientById(principal.clinicId, patientId);
  // Not found and cross-clinic are indistinguishable to the caller (no leak).
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'patient.read',
    outcome: patient ? 'success' : 'error',
    targetType: 'patient',
    targetId: patientId,
  });
  if (!patient) throw new NotFoundError('Patient');
  return patient;
}

export async function findPatients(
  principal: Principal,
  query: string,
  limit = 20,
): Promise<Patient[]> {
  requirePermission(principal, Permission.PATIENT_SEARCH);
  const q = (query ?? '').trim();
  if (q.length < 2) {
    throw new ValidationError('Search query must be at least 2 characters');
  }
  const capped = Math.min(Math.max(limit, 1), 50);
  const results = await searchPatients(principal.clinicId, q, capped);

  // Searching the patient index is a governance-relevant access: record who
  // searched and how much came back. The search TERM is itself patient-
  // identifying, so it is never stored — only its length, which is enough to
  // distinguish a targeted lookup from a broad trawl.
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'patient.search',
    outcome: 'success',
    targetType: 'patient',
    metadata: { queryLength: q.length, results: results.length },
  });

  return results;
}
