import { z } from 'zod';
import { getPool, withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { JurisdictionSchema } from './provenance.js';
import { territoryScopeFor } from './visibility.js';

/**
 * Pharma marketing foundations: HCP segmentation, campaigns and campaign
 * targeting. Content distribution and engagement live in `content.service.ts`.
 *
 * Segments are **declarative**: the criteria are stored as data (`definition`)
 * and resolved against the HCP master, so membership can be re-derived and
 * explained rather than being an opaque hand-made list. Only the criteria this
 * platform actually holds are supported — specialty, territory, tier and
 * professional interest. There is no clinical criterion, and there cannot be
 * one: patient data never reaches this layer (§45).
 */

const SegmentDefinitionSchema = z.object({
  specialtyIds: z.array(z.string().uuid()).max(50).optional(),
  territoryIds: z.array(z.string().uuid()).max(50).optional(),
  tiers: z.array(z.enum(['A', 'B', 'C', 'D'])).max(4).optional(),
  interests: z.array(z.string().trim().min(2).max(160)).max(20).optional(),
  verificationStatuses: z
    .array(z.enum(['unverified', 'pending_review', 'verified', 'disputed', 'retired']))
    .max(5)
    .optional(),
});

export type SegmentDefinition = z.infer<typeof SegmentDefinitionSchema>;

export const CreateSegmentSchema = z.object({
  key: z.string().trim().min(2).max(60),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(500).optional(),
  definition: SegmentDefinitionSchema.default({}),
});

export const CreateCampaignSchema = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(160),
  objective: z.string().trim().max(1000).optional(),
  campaignType: z
    .enum(['detailing', 'digital', 'event', 'education', 'launch'])
    .default('detailing'),
  medicationId: z.string().uuid().optional(),
  segmentId: z.string().uuid().optional(),
  jurisdiction: JurisdictionSchema,
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Invalid ${what}`, parsed.error.flatten());
  return parsed.data;
}

export async function createSegment(principal: Principal, raw: unknown) {
  requirePermission(principal, Permission.SEGMENT_MANAGE);
  const input = parse(CreateSegmentSchema, raw, 'segment');

  return withTransaction(async (client) => {
    try {
      const { rows } = await client.query<{ id: string; key: string; name: string }>(
        `INSERT INTO hcp_segment (clinic_id, key, name, description, definition, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, key, name`,
        [
          principal.clinicId,
          input.key,
          input.name,
          input.description ?? null,
          JSON.stringify(input.definition),
          principal.userId,
        ],
      );
      const segment = rows[0]!;
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.SEGMENT_CREATED,
        subjectType: 'hcp_segment',
        subjectId: segment.id,
        actorId: principal.userId,
        payload: { key: segment.key },
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'segment.create',
        targetType: 'hcp_segment',
        targetId: segment.id,
        metadata: { key: segment.key },
      });
      return { ...segment, definition: input.definition };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('A segment with this key already exists');
      }
      throw err;
    }
  });
}

/**
 * Resolve a segment's declarative criteria against the HCP master and store the
 * resulting membership. Re-running replaces nothing that is already correct —
 * membership rows are upserted, so the segment converges on its definition.
 */
export async function resolveSegment(principal: Principal, segmentId: string) {
  requirePermission(principal, Permission.SEGMENT_MANAGE);

  return withTransaction(async (client) => {
    const { rows: segmentRows } = await client.query<{
      id: string;
      key: string;
      definition: SegmentDefinition;
    }>(`SELECT id, key, definition FROM hcp_segment WHERE id = $1 AND clinic_id = $2`, [
      segmentId,
      principal.clinicId,
    ]);
    const segment = segmentRows[0];
    if (!segment) throw new NotFoundError('Segment');

    const parsed = SegmentDefinitionSchema.safeParse(segment.definition ?? {});
    if (!parsed.success) {
      throw new ValidationError('Stored segment definition is invalid', parsed.error.flatten());
    }
    const definition = parsed.data;

    const { rows: matches } = await client.query<{ id: string }>(
      `SELECT DISTINCT h.id
         FROM hcp h
         LEFT JOIN hcp_territory ht ON ht.hcp_id = h.id
        WHERE h.clinic_id = $1
          AND h.status = 'active'
          AND ($2::uuid[] IS NULL
               OR h.primary_specialty_id = ANY($2)
               OR EXISTS (SELECT 1 FROM hcp_specialty hs
                           WHERE hs.hcp_id = h.id AND hs.specialty_id = ANY($2)))
          AND ($3::uuid[] IS NULL OR ht.territory_id = ANY($3))
          AND ($4::text[] IS NULL OR ht.tier = ANY($4))
          AND ($5::text[] IS NULL OR h.verification_status = ANY($5))
          AND ($6::text[] IS NULL OR EXISTS (
                SELECT 1 FROM hcp_professional_interest i
                 WHERE i.hcp_id = h.id AND lower(i.interest) = ANY(
                   SELECT lower(x) FROM unnest($6::text[]) AS x)))`,
      [
        principal.clinicId,
        definition.specialtyIds ?? null,
        definition.territoryIds ?? null,
        definition.tiers ?? null,
        definition.verificationStatuses ?? null,
        definition.interests ?? null,
      ],
    );

    for (const match of matches) {
      await client.query(
        `INSERT INTO hcp_segment_member (clinic_id, segment_id, hcp_id, assignment_basis, assigned_by)
         VALUES ($1,$2,$3,'rule',$4)
         ON CONFLICT (clinic_id, segment_id, hcp_id) DO NOTHING`,
        [principal.clinicId, segmentId, match.id, principal.userId],
      );
    }

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.SEGMENT_MEMBER_ASSIGNED,
      subjectType: 'hcp_segment',
      subjectId: segmentId,
      actorId: principal.userId,
      payload: { matched: matches.length },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'segment.resolve',
      targetType: 'hcp_segment',
      targetId: segmentId,
      metadata: { matched: matches.length },
    });
    return { segmentId, matched: matches.length };
  });
}

export async function listSegments(principal: Principal) {
  requirePermission(principal, Permission.SEGMENT_READ);
  const { rows } = await getPool().query<{
    id: string;
    key: string;
    name: string;
    description: string | null;
    definition: SegmentDefinition;
    members: string;
  }>(
    `SELECT s.id, s.key, s.name, s.description, s.definition,
            count(m.id)::text AS members
       FROM hcp_segment s
       LEFT JOIN hcp_segment_member m ON m.segment_id = s.id
      WHERE s.clinic_id = $1 AND s.is_active
      GROUP BY s.id
      ORDER BY s.key`,
    [principal.clinicId],
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    definition: r.definition,
    members: Number(r.members),
  }));
}

export async function createCampaign(principal: Principal, raw: unknown) {
  requirePermission(principal, Permission.CAMPAIGN_MANAGE);
  const input = parse(CreateCampaignSchema, raw, 'campaign');
  if (input.endDate && input.startDate && input.endDate < input.startDate) {
    throw new ValidationError('endDate must not be before startDate');
  }

  return withTransaction(async (client) => {
    if (input.segmentId) {
      const { rows } = await client.query(
        `SELECT 1 FROM hcp_segment WHERE id = $1 AND clinic_id = $2`,
        [input.segmentId, principal.clinicId],
      );
      if (rows.length === 0) throw new NotFoundError('Segment');
    }
    if (input.medicationId) {
      const { rows } = await client.query(
        `SELECT 1 FROM medication WHERE id = $1 AND clinic_id = $2`,
        [input.medicationId, principal.clinicId],
      );
      if (rows.length === 0) throw new NotFoundError('Medication');
    }

    try {
      const { rows } = await client.query<{ id: string; code: string; name: string; status: string }>(
        `INSERT INTO campaign
           (clinic_id, code, name, objective, campaign_type, medication_id, segment_id,
            jurisdiction, start_date, end_date, owner_user_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         RETURNING id, code, name, status`,
        [
          principal.clinicId,
          input.code.toUpperCase(),
          input.name,
          input.objective ?? null,
          input.campaignType,
          input.medicationId ?? null,
          input.segmentId ?? null,
          input.jurisdiction,
          input.startDate ?? null,
          input.endDate ?? null,
          principal.userId,
        ],
      );
      const campaign = rows[0]!;
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.CAMPAIGN_CREATED,
        subjectType: 'campaign',
        subjectId: campaign.id,
        actorId: principal.userId,
        payload: { code: campaign.code, campaignType: input.campaignType },
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'campaign.create',
        targetType: 'campaign',
        targetId: campaign.id,
        metadata: { code: campaign.code },
      });
      return campaign;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('A campaign with this code already exists');
      }
      throw err;
    }
  });
}

/** Materialise a campaign's targets from its segment's resolved membership. */
export async function populateCampaignTargets(principal: Principal, campaignId: string) {
  requirePermission(principal, Permission.CAMPAIGN_MANAGE);

  return withTransaction(async (client) => {
    const { rows: campaignRows } = await client.query<{ id: string; segment_id: string | null }>(
      `SELECT id, segment_id FROM campaign WHERE id = $1 AND clinic_id = $2`,
      [campaignId, principal.clinicId],
    );
    const campaign = campaignRows[0];
    if (!campaign) throw new NotFoundError('Campaign');
    if (!campaign.segment_id) {
      throw new ValidationError('This campaign has no segment; targets cannot be derived');
    }

    const { rows } = await client.query<{ inserted: string }>(
      `WITH added AS (
         INSERT INTO campaign_target (clinic_id, campaign_id, hcp_id)
         SELECT $1, $2, m.hcp_id
           FROM hcp_segment_member m
          WHERE m.clinic_id = $1 AND m.segment_id = $3
         ON CONFLICT (clinic_id, campaign_id, hcp_id) DO NOTHING
         RETURNING 1
       )
       SELECT count(*)::text AS inserted FROM added`,
      [principal.clinicId, campaignId, campaign.segment_id],
    );
    const inserted = Number(rows[0]!.inserted);

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.CAMPAIGN_TARGET_ADDED,
      subjectType: 'campaign',
      subjectId: campaignId,
      actorId: principal.userId,
      payload: { added: inserted },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'campaign.targets.populate',
      targetType: 'campaign',
      targetId: campaignId,
      metadata: { added: inserted },
    });
    return { campaignId, targetsAdded: inserted };
  });
}

export async function listCampaigns(principal: Principal) {
  requirePermission(principal, Permission.CAMPAIGN_READ);
  // A representative only sees campaigns that reach an HCP in their territory.
  const scope = await territoryScopeFor(principal);
  const { rows } = await getPool().query<{
    id: string;
    code: string;
    name: string;
    campaign_type: string;
    status: string;
    jurisdiction: string;
    start_date: string | null;
    end_date: string | null;
    targets: string;
  }>(
    `SELECT c.id, c.code, c.name, c.campaign_type, c.status, c.jurisdiction,
            c.start_date, c.end_date, count(t.id)::text AS targets
       FROM campaign c
       LEFT JOIN campaign_target t ON t.campaign_id = c.id
      WHERE c.clinic_id = $1
        AND ($2::uuid[] IS NULL OR EXISTS (
              SELECT 1 FROM campaign_target ct
                JOIN hcp_territory ht ON ht.hcp_id = ct.hcp_id
               WHERE ct.campaign_id = c.id AND ht.territory_id = ANY($2)))
      GROUP BY c.id
      ORDER BY c.created_at DESC`,
    [principal.clinicId, scope],
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    campaignType: r.campaign_type,
    status: r.status,
    jurisdiction: r.jurisdiction,
    startDate: r.start_date,
    endDate: r.end_date,
    targets: Number(r.targets),
  }));
}
