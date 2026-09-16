import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { audit, auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { toIsoDate } from '../clinical/dates.js';
import { getPatientById, mapPatient, type Patient, type PatientStatus } from './patients.repo.js';

/**
 * Patient lifecycle: demographics maintenance, status, external identifiers,
 * emergency contacts, and duplicate resolution (merge).
 *
 * Registration, search and read stay in `patients.service.ts`; this module owns
 * what happens to a patient record *after* it exists.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

/**
 * `null` clears a field, `undefined` (absent) leaves it untouched. The two are
 * deliberately different: a partial update must never blank a field the caller
 * simply did not mention.
 */
export const UpdatePatientSchema = z
  .object({
    fullName: z.string().trim().min(2).max(200).optional(),
    sex: z.enum(['male', 'female', 'other', 'unknown']).optional(),
    birthDate: isoDate.nullable().optional(),
    phone: z.string().trim().min(5).max(32).nullable().optional(),
    email: z.string().trim().email().max(320).nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
    // BCP-47-ish; mirrors the CHECK constraint in migration 0104.
    preferredLanguage: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'must be a language tag such as "ar-EG"')
      .max(35)
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const PatientStatusSchema = z
  .object({
    status: z.enum(['active', 'inactive', 'deceased']),
    deceasedDate: isoDate.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.status === 'deceased' || v.deceasedDate === undefined, {
    message: 'deceasedDate may only be supplied when the status is deceased',
    path: ['deceasedDate'],
  });

export const MergePatientsSchema = z.object({
  sourcePatientId: z.string().uuid(),
  reason: z.string().trim().min(4).max(500),
});

export const IdentifierSchema = z
  .object({
    system: z.string().trim().min(1).max(64),
    value: z.string().trim().min(1).max(128),
    issuedOn: isoDate.optional(),
    expiresOn: isoDate.optional(),
  })
  // Mirrors ck_patient_identifier_dates. The CHECK is the backstop; this is so
  // the caller gets a 400 that names the problem instead of a server error.
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn, {
    message: 'expiresOn cannot be before issuedOn',
    path: ['expiresOn'],
  });

export const ContactSchema = z
  .object({
    kind: z.enum(['emergency', 'next_of_kin', 'guardian']).default('emergency'),
    fullName: z.string().trim().min(2).max(200),
    relationship: z.string().trim().max(100).optional(),
    phone: z.string().trim().min(5).max(32).optional(),
    email: z.string().trim().email().max(320).optional(),
    isPrimary: z.boolean().optional().default(false),
  })
  .refine((v) => v.phone !== undefined || v.email !== undefined, {
    message: 'A contact needs a phone number or an email address',
    path: ['phone'],
  });

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

/**
 * Every patient id whose records belong to this person: the record itself plus
 * every record transitively merged into it.
 *
 * A merge links rather than rewrites (migration 0104), so a patient's history
 * can be spread across the surviving record and the duplicates folded into it.
 * Longitudinal reads resolve lineage so a merge never hides history.
 */
export async function resolvePatientLineage(
  clinicId: string,
  patientId: string,
  runner: Pick<PoolClient, 'query'> = getPool(),
): Promise<string[]> {
  const { rows } = await runner.query<{ id: string }>(
    `WITH RECURSIVE lineage AS (
       SELECT id FROM patient WHERE clinic_id = $1 AND id = $2
       UNION
       SELECT p.id FROM patient p
         JOIN lineage l ON p.merged_into_id = l.id
        WHERE p.clinic_id = $1
     )
     SELECT id FROM lineage`,
    [clinicId, patientId],
  );
  return rows.map((r) => r.id);
}

/** Follow `merged_into_id` forward to the record that is actually in use. */
export async function resolveSurvivor(
  clinicId: string,
  patientId: string,
  runner: Pick<PoolClient, 'query'> = getPool(),
): Promise<string> {
  const { rows } = await runner.query<{ id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id, merged_into_id FROM patient WHERE clinic_id = $1 AND id = $2
       UNION
       SELECT p.id, p.merged_into_id FROM patient p
         JOIN chain c ON p.id = c.merged_into_id
        WHERE p.clinic_id = $1
     )
     SELECT id FROM chain WHERE merged_into_id IS NULL`,
    [clinicId, patientId],
  );
  return rows[0]?.id ?? patientId;
}

const PATIENT_COLS = `id, clinic_id, mrn, full_name, sex, birth_date, phone, national_id,
  status, deceased_date, merged_into_id, preferred_language, email, address, created_at`;

/**
 * Load a patient for writing, refusing a record that has been merged away.
 * Writing to a merged duplicate would put data on a record clinicians no longer
 * look at, so the caller is redirected to the survivor instead.
 */
async function lockWritablePatient(
  client: PoolClient,
  clinicId: string,
  patientId: string,
): Promise<Patient> {
  const { rows } = await client.query(
    `SELECT ${PATIENT_COLS} FROM patient WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
    [patientId, clinicId],
  );
  if (!rows[0]) throw new NotFoundError('Patient');
  const patient = mapPatient(rows[0]);
  if (patient.status === 'merged') {
    throw new ConflictError(
      'This record was merged into another patient; use the surviving record',
      { mergedIntoId: patient.mergedIntoId },
    );
  }
  return patient;
}

// ---------------------------------------------------------------------------
// Demographics
// ---------------------------------------------------------------------------
export async function updatePatient(
  principal: Principal,
  patientId: string,
  raw: unknown,
): Promise<Patient> {
  requirePermission(principal, Permission.PATIENT_UPDATE);

  const parsed = UpdatePatientSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid patient update', parsed.error.flatten());
  }
  const patch = parsed.data;

  const columns: Record<string, string> = {
    fullName: 'full_name',
    sex: 'sex',
    birthDate: 'birth_date',
    phone: 'phone',
    email: 'email',
    address: 'address',
    preferredLanguage: 'preferred_language',
  };

  return withTransaction(async (client) => {
    const existing = await lockWritablePatient(client, principal.clinicId, patientId);

    const sets: string[] = [];
    const values: unknown[] = [patientId, principal.clinicId, principal.userId];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        values.push((patch as Record<string, unknown>)[key] ?? null);
        sets.push(`${column} = $${values.length}`);
      }
    }

    const { rows } = await client.query(
      `UPDATE patient
          SET ${[...sets, 'updated_by = $3', 'updated_at = now()'].join(', ')}
        WHERE id = $1 AND clinic_id = $2
        RETURNING ${PATIENT_COLS}`,
      values,
    );
    const updated = mapPatient(rows[0]);

    // Field NAMES only. The values are patient-identifying and stay in the record.
    const fields = Object.keys(patch);
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.PATIENT_UPDATED,
      subjectType: 'patient',
      subjectId: updated.id,
      actorId: principal.userId,
      payload: { fields },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'patient.update',
      outcome: 'success',
      targetType: 'patient',
      targetId: updated.id,
      metadata: { fields, mrn: existing.mrn },
    });

    return updated;
  });
}

export async function setPatientStatus(
  principal: Principal,
  patientId: string,
  raw: unknown,
): Promise<Patient> {
  requirePermission(principal, Permission.PATIENT_UPDATE);

  const parsed = PatientStatusSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid patient status', parsed.error.flatten());
  }
  const input = parsed.data;

  return withTransaction(async (client) => {
    const existing = await lockWritablePatient(client, principal.clinicId, patientId);
    if (existing.status === input.status) {
      throw new ConflictError(`Patient is already ${input.status}`);
    }
    // Reversing a death record is a data-integrity correction, not routine
    // workflow; it is refused here so it cannot happen by accident.
    if (existing.status === 'deceased') {
      throw new ConflictError('A deceased record cannot be reopened through this endpoint');
    }

    const { rows } = await client.query(
      `UPDATE patient
          SET status = $3, deceased_date = $4, updated_by = $5, updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING ${PATIENT_COLS}`,
      [
        patientId,
        principal.clinicId,
        input.status,
        input.status === 'deceased' ? input.deceasedDate ?? null : null,
        principal.userId,
      ],
    );
    const updated = mapPatient(rows[0]);

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.PATIENT_STATUS_CHANGED,
      subjectType: 'patient',
      subjectId: updated.id,
      actorId: principal.userId,
      // Status is a controlled vocabulary; the free-text reason is not, so it
      // stays out of the event and the audit trail.
      payload: { from: existing.status, to: updated.status },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'patient.status',
      outcome: 'success',
      targetType: 'patient',
      targetId: updated.id,
      metadata: { from: existing.status, to: updated.status },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Duplicate detection + merge
// ---------------------------------------------------------------------------
export interface DuplicateCandidate {
  patient: Patient;
  /** Which deterministic signals matched. Never a fuzzy score. */
  matchedOn: string[];
}

/**
 * Candidate duplicates of a patient, by deterministic signal only.
 *
 * No fuzzy scoring: a merge is irreversible in practice, so the system surfaces
 * exact, explainable matches and leaves the decision to a human. Every
 * candidate says WHY it matched.
 *
 * A shared external identifier is deliberately NOT a signal here: the unique
 * index on (clinic_id, system, value) means two live records in one clinic
 * cannot hold the same identifier, so that clash is caught at write time with a
 * 409 that says the records may be duplicates — earlier, and with the operator
 * already in front of the record.
 */
export async function findDuplicateCandidates(
  principal: Principal,
  patientId: string,
  limit = 20,
): Promise<DuplicateCandidate[]> {
  requirePermission(principal, Permission.PATIENT_SEARCH);

  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const { rows } = await getPool().query<
    Record<string, unknown> & {
      match_national_id: boolean;
      match_phone: boolean;
      match_name_dob: boolean;
    }
  >(
    `SELECT ${PATIENT_COLS.split(', ').map((c) => `p.${c}`).join(', ')},
            (p.national_id IS NOT NULL AND p.national_id = $3) AS match_national_id,
            (p.phone IS NOT NULL AND p.phone = $4) AS match_phone,
            (lower(p.full_name) = lower($5)
              AND p.birth_date IS NOT NULL AND p.birth_date = $6::date) AS match_name_dob
       FROM patient p
      WHERE p.clinic_id = $1
        AND p.id <> $2
        AND p.status <> 'merged'
      ORDER BY p.created_at DESC
      LIMIT $7`,
    [
      principal.clinicId,
      patient.id,
      patient.nationalId,
      patient.phone,
      patient.fullName,
      patient.birthDate,
      // Over-fetch, then keep only rows with at least one signal.
      Math.min(Math.max(limit, 1), 50) * 10,
    ],
  );

  const candidates: DuplicateCandidate[] = [];
  for (const row of rows) {
    const matchedOn: string[] = [];
    if (row.match_national_id) matchedOn.push('nationalId');
    if (row.match_name_dob) matchedOn.push('nameAndBirthDate');
    if (row.match_phone) matchedOn.push('phone');
    if (matchedOn.length === 0) continue;
    candidates.push({ patient: mapPatient(row as never), matchedOn });
    if (candidates.length >= limit) break;
  }

  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'patient.duplicates.read',
    outcome: 'success',
    targetType: 'patient',
    targetId: patient.id,
    metadata: { candidates: candidates.length },
  });

  return candidates;
}

export interface MergeResult {
  survivor: Patient;
  merged: Patient;
}

/**
 * Resolve two records as one person.
 *
 * The loser is marked `merged` and points at the survivor; NO clinical row is
 * rewritten. That is not a shortcut — several clinical tables are append-only
 * at the database level, and a note written about one record must keep saying
 * so. Longitudinal reads resolve lineage instead, so the survivor's history
 * includes everything from both records without any history being edited.
 */
export async function mergePatients(
  principal: Principal,
  targetPatientId: string,
  raw: unknown,
): Promise<MergeResult> {
  requirePermission(principal, Permission.PATIENT_MERGE);

  const parsed = MergePatientsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid merge request', parsed.error.flatten());
  }
  const { sourcePatientId, reason } = parsed.data;

  if (sourcePatientId === targetPatientId) {
    throw new ValidationError('A patient cannot be merged into itself');
  }

  return withTransaction(async (client) => {
    // Lock in a deterministic order so two concurrent merges of the same pair
    // cannot deadlock against each other.
    const [firstId, secondId] = [sourcePatientId, targetPatientId].sort();
    await client.query(
      `SELECT id FROM patient WHERE clinic_id = $1 AND id IN ($2, $3) ORDER BY id FOR UPDATE`,
      [principal.clinicId, firstId, secondId],
    );

    const load = async (id: string): Promise<Patient> => {
      const { rows } = await client.query(
        `SELECT ${PATIENT_COLS} FROM patient WHERE id = $1 AND clinic_id = $2`,
        [id, principal.clinicId],
      );
      if (!rows[0]) throw new NotFoundError('Patient');
      return mapPatient(rows[0]);
    };

    const source = await load(sourcePatientId);
    const target = await load(targetPatientId);

    if (source.status === 'merged') {
      throw new ConflictError('The source record has already been merged', {
        mergedIntoId: source.mergedIntoId,
      });
    }
    if (target.status === 'merged') {
      throw new ConflictError('The target record has itself been merged; merge into the survivor', {
        mergedIntoId: target.mergedIntoId,
      });
    }

    // Merging a record that others already point at would orphan them, because
    // the survivor chain would have to fork. Refuse rather than guess.
    const { rows: dependents } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM patient
        WHERE clinic_id = $1 AND merged_into_id = $2`,
      [principal.clinicId, source.id],
    );
    if (Number(dependents[0]!.n) > 0) {
      throw new ConflictError(
        'Other records have already been merged into the source; merge those first',
      );
    }

    const { rows: updated } = await client.query(
      `UPDATE patient
          SET status = 'merged', merged_into_id = $3, updated_by = $4, updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING ${PATIENT_COLS}`,
      [source.id, principal.clinicId, target.id, principal.userId],
    );
    const merged = mapPatient(updated[0]);

    await client.query(
      `INSERT INTO patient_merge
         (clinic_id, source_patient_id, target_patient_id, reason, performed_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [principal.clinicId, source.id, target.id, reason, principal.userId],
    );

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.PATIENT_MERGED,
      subjectType: 'patient',
      subjectId: target.id,
      actorId: principal.userId,
      payload: { sourcePatientId: source.id, targetPatientId: target.id },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'patient.merge',
      outcome: 'success',
      targetType: 'patient',
      targetId: target.id,
      // Identifiers and MRNs only; the free-text reason lives in patient_merge.
      metadata: { sourcePatientId: source.id, sourceMrn: source.mrn, targetMrn: target.mrn },
    });

    return { survivor: await load(target.id), merged };
  });
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------
export interface PatientIdentifier {
  id: string;
  patientId: string;
  system: string;
  value: string;
  issuedOn: string | null;
  expiresOn: string | null;
  createdAt: string;
}

interface IdentifierRow {
  id: string;
  patient_id: string;
  system: string;
  value: string;
  issued_on: string | Date | null;
  expires_on: string | Date | null;
  created_at: string;
}

const mapIdentifier = (r: IdentifierRow): PatientIdentifier => ({
  id: r.id,
  patientId: r.patient_id,
  system: r.system,
  value: r.value,
  issuedOn: toIsoDate(r.issued_on),
  expiresOn: toIsoDate(r.expires_on),
  createdAt: r.created_at,
});

export async function addIdentifier(
  principal: Principal,
  patientId: string,
  raw: unknown,
): Promise<PatientIdentifier> {
  requirePermission(principal, Permission.PATIENT_IDENTIFIER_WRITE);

  const parsed = IdentifierSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid identifier', parsed.error.flatten());
  }
  const input = parsed.data;

  return withTransaction(async (client) => {
    const patient = await lockWritablePatient(client, principal.clinicId, patientId);
    try {
      const { rows } = await client.query<IdentifierRow>(
        `INSERT INTO patient_identifier
           (clinic_id, patient_id, system, value, issued_on, expires_on, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, patient_id, system, value, issued_on, expires_on, created_at`,
        [
          principal.clinicId,
          patient.id,
          input.system,
          input.value,
          input.issuedOn ?? null,
          input.expiresOn ?? null,
          principal.userId,
        ],
      );

      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'patient.identifier.add',
        outcome: 'success',
        targetType: 'patient',
        targetId: patient.id,
        // The identifier VALUE is patient-identifying; only the scheme is recorded.
        metadata: { system: input.system },
      });

      return mapIdentifier(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err, 'uq_patient_identifier_value')) {
        throw new ConflictError(
          'Another patient in this clinic already holds that identifier — they may be duplicates',
        );
      }
      throw err;
    }
  });
}

export async function listIdentifiers(
  principal: Principal,
  patientId: string,
): Promise<PatientIdentifier[]> {
  requirePermission(principal, Permission.PATIENT_IDENTIFIER_READ);
  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const { rows } = await getPool().query<IdentifierRow>(
    `SELECT id, patient_id, system, value, issued_on, expires_on, created_at
       FROM patient_identifier
      WHERE clinic_id = $1 AND patient_id = $2
      ORDER BY system, created_at`,
    [principal.clinicId, patient.id],
  );
  return rows.map(mapIdentifier);
}

export async function removeIdentifier(
  principal: Principal,
  patientId: string,
  identifierId: string,
): Promise<void> {
  requirePermission(principal, Permission.PATIENT_IDENTIFIER_WRITE);

  await withTransaction(async (client) => {
    const patient = await lockWritablePatient(client, principal.clinicId, patientId);
    const { rows } = await client.query<{ system: string }>(
      `DELETE FROM patient_identifier
        WHERE id = $1 AND patient_id = $2 AND clinic_id = $3
        RETURNING system`,
      [identifierId, patient.id, principal.clinicId],
    );
    if (!rows[0]) throw new NotFoundError('Identifier');

    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'patient.identifier.remove',
      outcome: 'success',
      targetType: 'patient',
      targetId: patient.id,
      metadata: { system: rows[0].system },
    });
  });
}

// ---------------------------------------------------------------------------
// Emergency contacts
// ---------------------------------------------------------------------------
export interface PatientContact {
  id: string;
  patientId: string;
  kind: 'emergency' | 'next_of_kin' | 'guardian';
  fullName: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
  createdAt: string;
}

interface ContactRow {
  id: string;
  patient_id: string;
  kind: PatientContact['kind'];
  full_name: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  is_primary: boolean;
  created_at: string;
}

const mapContact = (r: ContactRow): PatientContact => ({
  id: r.id,
  patientId: r.patient_id,
  kind: r.kind,
  fullName: r.full_name,
  relationship: r.relationship,
  phone: r.phone,
  email: r.email,
  isPrimary: r.is_primary,
  createdAt: r.created_at,
});

export async function addContact(
  principal: Principal,
  patientId: string,
  raw: unknown,
): Promise<PatientContact> {
  requirePermission(principal, Permission.PATIENT_CONTACT_WRITE);

  const parsed = ContactSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid contact', parsed.error.flatten());
  const input = parsed.data;

  return withTransaction(async (client) => {
    const patient = await lockWritablePatient(client, principal.clinicId, patientId);

    // Promoting a new primary demotes the old one, so the partial unique index
    // is satisfied by construction rather than by the caller remembering.
    if (input.isPrimary) {
      await client.query(
        `UPDATE patient_contact SET is_primary = false, updated_at = now()
          WHERE clinic_id = $1 AND patient_id = $2 AND kind = $3 AND is_primary`,
        [principal.clinicId, patient.id, input.kind],
      );
    }

    const { rows } = await client.query<ContactRow>(
      `INSERT INTO patient_contact
         (clinic_id, patient_id, kind, full_name, relationship, phone, email, is_primary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, patient_id, kind, full_name, relationship, phone, email, is_primary, created_at`,
      [
        principal.clinicId,
        patient.id,
        input.kind,
        input.fullName,
        input.relationship ?? null,
        input.phone ?? null,
        input.email ?? null,
        input.isPrimary,
        principal.userId,
      ],
    );

    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'patient.contact.add',
      outcome: 'success',
      targetType: 'patient',
      targetId: patient.id,
      // A contact's name and number identify a real person; kind only.
      metadata: { kind: input.kind, isPrimary: input.isPrimary },
    });

    return mapContact(rows[0]!);
  });
}

export async function listContacts(
  principal: Principal,
  patientId: string,
): Promise<PatientContact[]> {
  requirePermission(principal, Permission.PATIENT_CONTACT_READ);
  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const { rows } = await getPool().query<ContactRow>(
    `SELECT id, patient_id, kind, full_name, relationship, phone, email, is_primary, created_at
       FROM patient_contact
      WHERE clinic_id = $1 AND patient_id = $2
      ORDER BY is_primary DESC, kind, created_at`,
    [principal.clinicId, patient.id],
  );
  return rows.map(mapContact);
}

export async function removeContact(
  principal: Principal,
  patientId: string,
  contactId: string,
): Promise<void> {
  requirePermission(principal, Permission.PATIENT_CONTACT_WRITE);

  await withTransaction(async (client) => {
    const patient = await lockWritablePatient(client, principal.clinicId, patientId);
    const { rows } = await client.query<{ kind: string }>(
      `DELETE FROM patient_contact
        WHERE id = $1 AND patient_id = $2 AND clinic_id = $3
        RETURNING kind`,
      [contactId, patient.id, principal.clinicId],
    );
    if (!rows[0]) throw new NotFoundError('Contact');

    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'patient.contact.remove',
      outcome: 'success',
      targetType: 'patient',
      targetId: patient.id,
      metadata: { kind: rows[0].kind },
    });
  });
}

/** Statuses that accept new clinical activity. */
export const CLINICALLY_ACTIVE_STATUSES: readonly PatientStatus[] = ['active', 'inactive'];

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505' &&
    (err as { constraint?: string }).constraint === constraint
  );
}
