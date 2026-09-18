import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { audit, auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { hasPermission, requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';
import { findEncounter } from './encounter.repo.js';
import { resolvePatientLineage } from '../identity/patients.lifecycle.service.js';

/**
 * Clinical document management (Phase 9), FHIR DocumentReference-shaped.
 *
 * This layer owns document METADATA, linkage, versioning and access policy —
 * never the bytes. `storageKey` is an opaque pointer the infrastructure
 * resolves to content; byte storage is a platform decision (CCR-008). Keeping
 * content out of the database keeps it out of logs, clinical-DB backups and
 * every query here.
 */

export const RegisterDocumentSchema = z.object({
  patientId: z.string().uuid(),
  encounterId: z.string().uuid().optional(),
  episodeId: z.string().uuid().optional(),
  docType: z.enum([
    'lab_report',
    'imaging_report',
    'referral',
    'consent',
    'prescription',
    'discharge_summary',
    'clinical_photo',
    'external_record',
    'invoice',
    'other',
  ]),
  title: z.string().trim().min(1).max(300),
  contentType: z
    .string()
    .trim()
    .regex(/^[-a-z]+\/[-.+a-z0-9]+$/i, 'must be a MIME type')
    .transform((v) => v.toLowerCase()),
  storageKey: z.string().trim().min(1).max(512),
  sizeBytes: z.number().int().min(0).optional(),
  checksumSha256: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, 'must be a hex SHA-256')
    .transform((v) => v.toLowerCase())
    .optional(),
  confidentiality: z.enum(['normal', 'restricted']).default('normal'),
  /** When set, this document is a new version superseding an existing one. */
  supersedesId: z.string().uuid().optional(),
});

export interface DocumentReference {
  id: string;
  patientId: string;
  encounterId: string | null;
  episodeId: string | null;
  docType: string;
  title: string;
  contentType: string;
  storageKey: string;
  sizeBytes: number | null;
  checksumSha256: string | null;
  confidentiality: 'normal' | 'restricted';
  status: 'current' | 'superseded' | 'entered_in_error';
  supersedesId: string | null;
  uploadedBy: string;
  createdAt: string;
}

interface DocumentRow {
  id: string;
  patient_id: string;
  encounter_id: string | null;
  episode_id: string | null;
  doc_type: string;
  title: string;
  content_type: string;
  storage_key: string;
  size_bytes: string | null;
  checksum_sha256: string | null;
  confidentiality: 'normal' | 'restricted';
  status: 'current' | 'superseded' | 'entered_in_error';
  supersedes_id: string | null;
  uploaded_by: string;
  created_at: string;
}

function mapDocument(r: DocumentRow): DocumentReference {
  return {
    id: r.id,
    patientId: r.patient_id,
    encounterId: r.encounter_id,
    episodeId: r.episode_id,
    docType: r.doc_type,
    title: r.title,
    contentType: r.content_type,
    storageKey: r.storage_key,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    checksumSha256: r.checksum_sha256,
    confidentiality: r.confidentiality,
    status: r.status,
    supersedesId: r.supersedes_id,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
  };
}

const DOC_COLS = `id, patient_id, encounter_id, episode_id, doc_type, title, content_type,
  storage_key, size_bytes, checksum_sha256, confidentiality, status, supersedes_id,
  uploaded_by, created_at`;

/** Restricted documents need the elevated read permission. */
function assertMayRead(principal: Principal, doc: Pick<DocumentReference, 'confidentiality'>): void {
  requirePermission(principal, Permission.DOCUMENT_READ);
  if (doc.confidentiality === 'restricted') {
    requirePermission(principal, Permission.DOCUMENT_READ_RESTRICTED);
  }
}

export async function registerDocument(
  principal: Principal,
  raw: unknown,
): Promise<DocumentReference> {
  requirePermission(principal, Permission.DOCUMENT_WRITE);

  const parsed = RegisterDocumentSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid document', parsed.error.flatten());
  const input = parsed.data;
  // Registering a restricted document requires the elevated grant too, so a
  // role that cannot read restricted content cannot mint it either.
  if (input.confidentiality === 'restricted') {
    requirePermission(principal, Permission.DOCUMENT_READ_RESTRICTED);
  }

  const patient = await getPatientById(principal.clinicId, input.patientId);
  if (!patient) throw new NotFoundError('Patient');
  if (patient.status === 'merged') {
    throw new ConflictError('This record was merged; attach the document to the surviving patient', {
      mergedIntoId: patient.mergedIntoId,
    });
  }

  return withTransaction(async (client) => {
    // Validate context links belong to this patient (episode via lineage, since
    // an episode may sit on a record merged into this one).
    if (input.encounterId) {
      const encounter = await findEncounter(principal.clinicId, input.encounterId);
      if (!encounter || encounter.patientId !== patient.id) {
        throw new ValidationError('encounterId does not belong to this patient');
      }
    }
    if (input.episodeId) {
      const lineage = await resolvePatientLineage(principal.clinicId, patient.id, client);
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM treatment_episode
          WHERE id = $1 AND clinic_id = $2 AND patient_id = ANY($3::uuid[])`,
        [input.episodeId, principal.clinicId, lineage],
      );
      if (!rows[0]) throw new ValidationError('episodeId does not belong to this patient');
    }

    let supersedes: DocumentReference | null = null;
    if (input.supersedesId) {
      const { rows } = await client.query<DocumentRow>(
        `SELECT ${DOC_COLS} FROM document_reference
          WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
        [input.supersedesId, principal.clinicId],
      );
      if (!rows[0]) throw new NotFoundError('Superseded document');
      supersedes = mapDocument(rows[0]);
      if (supersedes.patientId !== patient.id) {
        throw new ValidationError('A document can only supersede another for the same patient');
      }
      if (supersedes.status !== 'current') {
        throw new ConflictError(`The document being superseded is ${supersedes.status}`);
      }
    }

    let doc: DocumentReference;
    try {
      const { rows } = await client.query<DocumentRow>(
        `INSERT INTO document_reference
           (clinic_id, patient_id, encounter_id, episode_id, doc_type, title, content_type,
            storage_key, size_bytes, checksum_sha256, confidentiality, supersedes_id, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING ${DOC_COLS}`,
        [
          principal.clinicId,
          patient.id,
          input.encounterId ?? null,
          input.episodeId ?? null,
          input.docType,
          input.title,
          input.contentType,
          input.storageKey,
          input.sizeBytes ?? null,
          input.checksumSha256 ?? null,
          input.confidentiality,
          supersedes?.id ?? null,
          principal.userId,
        ],
      );
      doc = mapDocument(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('That storage object is already registered as a document');
      }
      throw err;
    }

    if (supersedes) {
      await client.query(
        `UPDATE document_reference SET status = 'superseded', updated_at = now()
          WHERE id = $1 AND clinic_id = $2`,
        [supersedes.id, principal.clinicId],
      );
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.DOCUMENT_SUPERSEDED,
        subjectType: 'document',
        subjectId: supersedes.id,
        actorId: principal.userId,
        payload: { patientId: patient.id, supersededBy: doc.id },
      });
    }

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.DOCUMENT_REGISTERED,
      subjectType: 'document',
      subjectId: doc.id,
      actorId: principal.userId,
      // Type and confidentiality are controlled vocabulary; the title can name a
      // condition ("HIV result"), so it stays out of the event and audit.
      payload: { patientId: patient.id, docType: doc.docType, confidentiality: doc.confidentiality },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'document.register',
      outcome: 'success',
      targetType: 'document',
      targetId: doc.id,
      metadata: { patientId: patient.id, docType: doc.docType, confidentiality: doc.confidentiality },
    });

    return doc;
  });
}

export async function voidDocument(
  principal: Principal,
  documentId: string,
  raw: unknown,
): Promise<DocumentReference> {
  requirePermission(principal, Permission.DOCUMENT_MANAGE);

  const parsed = z.object({ reason: z.string().trim().min(4).max(500) }).safeParse(raw);
  if (!parsed.success) throw new ValidationError('A reason is required', parsed.error.flatten());

  return withTransaction(async (client) => {
    const { rows } = await client.query<DocumentRow>(
      `SELECT ${DOC_COLS} FROM document_reference
        WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [documentId, principal.clinicId],
    );
    if (!rows[0]) throw new NotFoundError('Document');
    const doc = mapDocument(rows[0]);
    if (doc.status === 'entered_in_error') {
      throw new ConflictError('The document is already voided');
    }

    const { rows: updated } = await client.query<DocumentRow>(
      `UPDATE document_reference SET status = 'entered_in_error', updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING ${DOC_COLS}`,
      [documentId, principal.clinicId],
    );

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.DOCUMENT_VOIDED,
      subjectType: 'document',
      subjectId: doc.id,
      actorId: principal.userId,
      payload: { patientId: doc.patientId, docType: doc.docType },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'document.void',
      outcome: 'success',
      targetType: 'document',
      targetId: doc.id,
      // The free-text reason is not copied into audit metadata.
      metadata: { patientId: doc.patientId, docType: doc.docType },
    });

    return mapDocument(updated[0]!);
  });
}

export const ListDocumentsQuery = z.object({
  docType: z.string().trim().max(40).optional(),
  encounterId: z.string().uuid().optional(),
  episodeId: z.string().uuid().optional(),
  includeSuperseded: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function listPatientDocuments(
  principal: Principal,
  patientId: string,
  rawQuery: unknown,
): Promise<DocumentReference[]> {
  requirePermission(principal, Permission.DOCUMENT_READ);

  const parsed = ListDocumentsQuery.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());
  const q = parsed.data;

  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');
  const lineage = await resolvePatientLineage(principal.clinicId, patient.id);

  // A caller without the restricted grant simply does not see restricted
  // documents in the list — they are filtered out, not surfaced as forbidden.
  const canRestricted = hasPermission(principal, Permission.DOCUMENT_READ_RESTRICTED);

  const { rows } = await getPool().query<DocumentRow>(
    `SELECT ${DOC_COLS} FROM document_reference
      WHERE clinic_id = $1 AND patient_id = ANY($2::uuid[])
        AND ($3::boolean OR status <> 'superseded')
        AND status <> 'entered_in_error'
        AND ($4::text IS NULL OR doc_type = $4)
        AND ($5::uuid IS NULL OR encounter_id = $5)
        AND ($6::uuid IS NULL OR episode_id = $6)
        AND ($7::boolean OR confidentiality = 'normal')
      ORDER BY created_at DESC
      LIMIT $8`,
    [
      principal.clinicId,
      lineage,
      q.includeSuperseded,
      q.docType ?? null,
      q.encounterId ?? null,
      q.episodeId ?? null,
      canRestricted,
      q.limit,
    ],
  );

  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'document.list',
    outcome: 'success',
    targetType: 'patient',
    targetId: patient.id,
    metadata: { count: rows.length },
  });

  return rows.map(mapDocument);
}

export async function getDocument(
  principal: Principal,
  documentId: string,
): Promise<DocumentReference> {
  requirePermission(principal, Permission.DOCUMENT_READ);
  const { rows } = await getPool().query<DocumentRow>(
    `SELECT ${DOC_COLS} FROM document_reference WHERE id = $1 AND clinic_id = $2`,
    [documentId, principal.clinicId],
  );
  if (!rows[0]) throw new NotFoundError('Document');
  const doc = mapDocument(rows[0]);
  // A restricted document is not-found to a caller without the grant, so its
  // existence does not leak.
  if (doc.confidentiality === 'restricted' && !hasPermission(principal, Permission.DOCUMENT_READ_RESTRICTED)) {
    throw new NotFoundError('Document');
  }
  assertMayRead(principal, doc);

  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'document.read',
    outcome: 'success',
    targetType: 'document',
    targetId: doc.id,
    metadata: { docType: doc.docType, confidentiality: doc.confidentiality },
  });

  return doc;
}
