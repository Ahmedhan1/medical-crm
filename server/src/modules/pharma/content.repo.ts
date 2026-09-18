import { getPool, type PoolClient } from '../../db/pool.js';
import { toDateString } from './dates.js';

type Runner = Pick<PoolClient, 'query'>;

export interface ApprovedContent {
  id: string;
  clinicId: string;
  title: string;
  summary: string | null;
  contentType: string;
  therapeuticArea: string | null;
  medicationId: string | null;
  ownerUserId: string;
  version: string;
  jurisdiction: string;
  language: string | null;
  approvalStatus: 'draft' | 'in_review' | 'approved' | 'rejected' | 'withdrawn';
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  effectiveDate: string | null;
  expiryDate: string | null;
  reviewDueDate: string | null;
  externalRef: string | null;
  storageUri: string | null;
  recordVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface ContentRow {
  id: string;
  clinic_id: string;
  title: string;
  summary: string | null;
  content_type: string;
  therapeutic_area: string | null;
  medication_id: string | null;
  owner_user_id: string;
  version: string;
  jurisdiction: string;
  language: string | null;
  approval_status: ApprovedContent['approvalStatus'];
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  effective_date: Date | string | null;
  expiry_date: Date | string | null;
  review_due_date: Date | string | null;
  external_ref: string | null;
  storage_uri: string | null;
  record_version: number;
  created_at: string;
  updated_at: string;
}

function mapContent(row: ContentRow): ApprovedContent {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    title: row.title,
    summary: row.summary,
    contentType: row.content_type,
    therapeuticArea: row.therapeutic_area,
    medicationId: row.medication_id,
    ownerUserId: row.owner_user_id,
    version: row.version,
    jurisdiction: row.jurisdiction,
    language: row.language,
    approvalStatus: row.approval_status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectionReason: row.rejection_reason,
    effectiveDate: toDateString(row.effective_date),
    expiryDate: toDateString(row.expiry_date),
    reviewDueDate: toDateString(row.review_due_date),
    externalRef: row.external_ref,
    storageUri: row.storage_uri,
    recordVersion: row.record_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertContent(
  client: PoolClient,
  input: {
    clinicId: string;
    title: string;
    summary: string | null;
    contentType: string;
    therapeuticArea: string | null;
    medicationId: string | null;
    ownerUserId: string;
    version: string;
    jurisdiction: string;
    language: string | null;
    effectiveDate: string | null;
    expiryDate: string | null;
    reviewDueDate: string | null;
    externalRef: string | null;
    storageUri: string | null;
    createdBy: string;
  },
): Promise<ApprovedContent> {
  const { rows } = await client.query<ContentRow>(
    `INSERT INTO approved_content
       (clinic_id, title, summary, content_type, therapeutic_area, medication_id, owner_user_id,
        version, jurisdiction, language, effective_date, expiry_date, review_due_date,
        external_ref, storage_uri, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      input.clinicId,
      input.title,
      input.summary,
      input.contentType,
      input.therapeuticArea,
      input.medicationId,
      input.ownerUserId,
      input.version,
      input.jurisdiction,
      input.language,
      input.effectiveDate,
      input.expiryDate,
      input.reviewDueDate,
      input.externalRef,
      input.storageUri,
      input.createdBy,
    ],
  );
  return mapContent(rows[0]!);
}

export async function getContentById(
  clinicId: string,
  id: string,
  runner: Runner = getPool(),
): Promise<ApprovedContent | null> {
  const { rows } = await runner.query<ContentRow>(
    `SELECT * FROM approved_content WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapContent(rows[0]) : null;
}

export async function getContentForUpdate(
  client: PoolClient,
  clinicId: string,
  id: string,
): Promise<ApprovedContent | null> {
  const { rows } = await client.query<ContentRow>(
    `SELECT * FROM approved_content WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
    [id, clinicId],
  );
  return rows[0] ? mapContent(rows[0]) : null;
}

export async function setContentApproval(
  client: PoolClient,
  clinicId: string,
  id: string,
  input: {
    approvalStatus: ApprovedContent['approvalStatus'];
    approvedBy: string | null;
    approvedAt: string | null;
    rejectionReason: string | null;
    effectiveDate: string | null;
    expiryDate: string | null;
    reviewDueDate: string | null;
  },
): Promise<ApprovedContent> {
  const { rows } = await client.query<ContentRow>(
    `UPDATE approved_content
        SET approval_status = $3,
            approved_by = $4,
            approved_at = $5,
            rejection_reason = $6,
            effective_date = coalesce($7, effective_date),
            expiry_date = coalesce($8, expiry_date),
            review_due_date = coalesce($9, review_due_date),
            record_version = record_version + 1,
            updated_at = now()
      WHERE id = $1 AND clinic_id = $2
      RETURNING *`,
    [
      id,
      clinicId,
      input.approvalStatus,
      input.approvedBy,
      input.approvedAt,
      input.rejectionReason,
      input.effectiveDate,
      input.expiryDate,
      input.reviewDueDate,
    ],
  );
  return mapContent(rows[0]!);
}

export async function insertContentRevision(
  client: PoolClient,
  input: {
    clinicId: string;
    contentId: string;
    recordVersion: number;
    changeType: string;
    changedFields: string[];
    snapshot: ApprovedContent;
    note: string | null;
    changedBy: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO approved_content_revision
       (clinic_id, content_id, record_version, change_type, changed_fields, snapshot, note, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.clinicId,
      input.contentId,
      input.recordVersion,
      input.changeType,
      input.changedFields,
      JSON.stringify(input.snapshot),
      input.note,
      input.changedBy,
    ],
  );
}

export async function listContentRevisions(clinicId: string, contentId: string) {
  const { rows } = await getPool().query<{
    record_version: number;
    change_type: string;
    changed_fields: string[];
    note: string | null;
    changed_by: string | null;
    changed_at: string;
  }>(
    `SELECT record_version, change_type, changed_fields, note, changed_by, changed_at
       FROM approved_content_revision
      WHERE clinic_id = $1 AND content_id = $2
      ORDER BY record_version`,
    [clinicId, contentId],
  );
  return rows.map((r) => ({
    recordVersion: r.record_version,
    changeType: r.change_type,
    changedFields: r.changed_fields,
    note: r.note,
    changedBy: r.changed_by,
    changedAt: r.changed_at,
  }));
}

export interface ContentFilter {
  jurisdiction: string | null;
  medicationId: string | null;
  contentType: string | null;
  /**
   * When true (the default for anyone without `content:write`), only content
   * that is approved AND inside its effective→expiry window on `onDate` is
   * returned. Expiry gating is enforced in SQL so no caller can forget it.
   */
  usableOnly: boolean;
  onDate: string;
  limit: number;
}

export async function listContent(
  clinicId: string,
  filter: ContentFilter,
): Promise<ApprovedContent[]> {
  const { rows } = await getPool().query<ContentRow>(
    `SELECT * FROM approved_content
      WHERE clinic_id = $1
        AND ($2::text IS NULL OR jurisdiction = $2)
        AND ($3::uuid IS NULL OR medication_id = $3)
        AND ($4::text IS NULL OR content_type = $4)
        AND (
          NOT $5::boolean
          OR (approval_status = 'approved'
              AND effective_date IS NOT NULL
              AND effective_date <= $6::date
              AND (expiry_date IS NULL OR expiry_date >= $6::date))
        )
      ORDER BY title, version
      LIMIT $7`,
    [
      clinicId,
      filter.jurisdiction,
      filter.medicationId,
      filter.contentType,
      filter.usableOnly,
      filter.onDate,
      filter.limit,
    ],
  );
  return rows.map(mapContent);
}

export async function insertEngagement(
  client: PoolClient,
  input: {
    clinicId: string;
    contentId: string;
    hcpId: string;
    visitId: string | null;
    campaignId: string | null;
    channel: string;
    engagementType: string;
    durationSeconds: number | null;
    recordedBy: string;
  },
): Promise<{ id: string; occurredAt: string }> {
  const { rows } = await client.query<{ id: string; occurred_at: string }>(
    `INSERT INTO content_engagement
       (clinic_id, content_id, hcp_id, visit_id, campaign_id, channel, engagement_type,
        duration_seconds, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, occurred_at`,
    [
      input.clinicId,
      input.contentId,
      input.hcpId,
      input.visitId,
      input.campaignId,
      input.channel,
      input.engagementType,
      input.durationSeconds,
      input.recordedBy,
    ],
  );
  return { id: rows[0]!.id, occurredAt: rows[0]!.occurred_at };
}

export async function listEngagementForHcp(clinicId: string, hcpId: string, limit: number) {
  const { rows } = await getPool().query<{
    id: string;
    content_id: string;
    title: string;
    version: string;
    channel: string;
    engagement_type: string;
    occurred_at: string;
  }>(
    `SELECT e.id, e.content_id, c.title, c.version, e.channel, e.engagement_type, e.occurred_at
       FROM content_engagement e
       JOIN approved_content c ON c.id = e.content_id
      WHERE e.clinic_id = $1 AND e.hcp_id = $2
      ORDER BY e.occurred_at DESC
      LIMIT $3`,
    [clinicId, hcpId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    contentId: r.content_id,
    title: r.title,
    version: r.version,
    channel: r.channel,
    engagementType: r.engagement_type,
    occurredAt: r.occurred_at,
  }));
}
