import { z } from 'zod';
import { getPool, withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { audit, auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { today } from '../pharma/dates.js';
import { assertFreeTextClean } from '../pharma/guards.js';
import { ProvenanceSchema, VerificationStatus } from '../pharma/provenance.js';
import { territoryScopeFor } from '../pharma/visibility.js';
import * as repo from './hco.repo.js';
import type {
  Hco,
  HcoDepartment,
  HcoIdentifier,
  HcoLocation,
  HcoRevision,
} from './hco.types.js';
import {
  assertTransition,
  stateAfterMaterialChange,
  verificationExpiryFrom,
  VerificationState,
} from './verification.js';

/**
 * HCO master-data service (migrations 0300 / 0307 / 0308).
 *
 * The organisation side of the master obeys the same three rules as the HCP
 * side, and deliberately reuses the SAME lifecycle module rather than a parallel
 * copy, so the two masters cannot drift:
 *
 *  1. **Provenance is mandatory.** `source` + `jurisdiction` are required at the
 *     API boundary for the organisation, each of its sites and each department.
 *  2. **Nothing is born verified.** Records enter as `unverified`; reaching
 *     `verified` needs `hco:verify` and passes through `pending_review` first.
 *  3. **Every change is versioned.** `record_version` increments and an
 *     append-only `hco_revision` snapshot records what changed and by whom.
 *
 * GOVERNANCE BOUNDARY (§45): nothing in this module reads a clinical table. An
 * HCO 360 is the complete *commercial and professional* picture of an
 * organisation — affiliated professionals, sites, departments, this company's
 * own engagement — and never an aggregation of care delivered there.
 */

/**
 * Identifier systems this platform will store for an ORGANISATION: public
 * business and facility registrations. Identifiers belonging to a PERSON
 * (national id, passport, a director's tax number) are not on this list and are
 * refused, exactly as `PROFESSIONAL_IDENTIFIER_SYSTEMS` refuses civil identity
 * documents for an HCP.
 *
 * Extending this list is a governance decision, not a data-entry one.
 */
export const HCO_IDENTIFIER_SYSTEMS: Record<string, string> = {
  EG_MOH_FACILITY: 'Egyptian Ministry of Health facility licence number',
  EG_TAX_ID: 'Egyptian commercial tax registration number of the organisation',
  EG_COMMERCIAL_REGISTER: 'Egyptian commercial register number',
  GLN: 'GS1 Global Location Number',
  NPI_ORG: 'US National Provider Identifier, organisational subpart (public)',
  INTERNAL: 'Internal MEDCORE reference for this organisation',
};

const NAME = z.string().trim().min(2).max(200);
const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const HCO_TYPE = z.enum([
  'hospital',
  'clinic',
  'pharmacy',
  'university',
  'laboratory',
  'group_practice',
  'ministry',
  'other',
]);

const OWNERSHIP_TYPE = z.enum([
  'public',
  'private',
  'ngo',
  'university',
  'military',
  'religious',
  'mixed',
  'unknown',
]);

const OPERATING_STATUS = z.enum(['active', 'suspended', 'closed', 'merged']);

export const CreateHcoSchema = z.object({
  name: NAME,
  hcoType: HCO_TYPE.default('other'),
  parentHcoId: z.string().uuid().optional(),
  /**
   * Defaults to `unknown` rather than `private`: an organisation whose ownership
   * was never asked about must say so, not be assigned the commonest value.
   */
  ownershipType: OWNERSHIP_TYPE.default('unknown'),
  country: z.string().trim().length(2),
  region: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  addressLine: z.string().trim().max(300).optional(),
  postalCode: z.string().trim().max(20).optional(),
  effectiveFrom: DATE_ONLY.optional(),
  effectiveTo: DATE_ONLY.optional(),
  provenance: ProvenanceSchema,
});

/**
 * `operating_status` is NOT patchable here: moving to `merged` needs a survivor,
 * which is what the merge endpoint exists for. The other three states are
 * ordinary facts about the world and are patchable.
 */
export const UpdateHcoSchema = z
  .object({
    name: NAME.optional(),
    hcoType: HCO_TYPE.optional(),
    parentHcoId: z.string().uuid().nullable().optional(),
    ownershipType: OWNERSHIP_TYPE.optional(),
    operatingStatus: z.enum(['active', 'suspended', 'closed']).optional(),
    country: z.string().trim().length(2).optional(),
    region: z.string().trim().max(120).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    addressLine: z.string().trim().max(300).nullable().optional(),
    postalCode: z.string().trim().max(20).nullable().optional(),
    effectiveFrom: DATE_ONLY.nullable().optional(),
    effectiveTo: DATE_ONLY.nullable().optional(),
    isActive: z.boolean().optional(),
    provenance: ProvenanceSchema,
  })
  .refine((v) => Object.keys(v).length > 1, {
    message: 'Provide at least one field to change alongside provenance',
  });

/**
 * Deliberately the SAME field names as `VerificationDecisionSchema` for HCPs.
 * One vocabulary for both masters means a reviewer does not have to remember
 * which entity calls the decision `status` and which calls it
 * `verificationStatus`.
 *
 * `expired` is absent from the accepted values on purpose: expiry is derived
 * from the clock and written by the sweep, never asserted by a caller.
 */
export const HcoVerificationSchema = z.object({
  verificationStatus: z.enum([
    'pending_review',
    'verified',
    'rejected',
    'suspended',
    'disputed',
    'retired',
  ]),
  /** What was checked — recorded in the revision trail, not free-form trust. */
  evidenceSource: z.string().trim().min(2).max(200),
  /** Required for `rejected` and `suspended`; an unexplained refusal is not reviewable. */
  note: z.string().trim().min(2).max(1000).optional(),
  /** Shelf life of this verification. Omit for the default of one year. */
  validForDays: z.number().int().min(1).max(3650).optional(),
});

export const MergeHcoSchema = z.object({
  survivorHcoId: z.string().uuid(),
  reason: z.string().trim().min(4).max(2000),
});

export const CreateHcoIdentifierSchema = z.object({
  identifierSystem: z.string().trim().min(2).max(60),
  identifierValue: z.string().trim().min(1).max(120),
  issuingJurisdiction: z.string().trim().min(2).max(10),
  validFrom: DATE_ONLY.optional(),
  validTo: DATE_ONLY.optional(),
  source: z.string().trim().min(2).max(120),
  sourceVersion: z.string().trim().max(120).optional(),
  sourceDate: DATE_ONLY.optional(),
});

export const CreateHcoLocationSchema = z.object({
  label: z.string().trim().min(2).max(160),
  addressLine: z.string().trim().max(300).optional(),
  city: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  country: z.string().trim().length(2),
  postalCode: z.string().trim().max(20).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  territoryId: z.string().uuid().optional(),
  isPrimary: z.boolean().default(false),
  provenance: ProvenanceSchema,
});

export const CreateHcoDepartmentSchema = z.object({
  name: z.string().trim().min(2).max(160),
  hcoLocationId: z.string().uuid().optional(),
  specialtyId: z.string().uuid().optional(),
  provenance: ProvenanceSchema,
});

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Invalid ${what}`, parsed.error.flatten());
  return parsed.data;
}

/**
 * Attributes of an ORGANISATION whose change invalidates a completed
 * verification — what a reviewer actually attested to: who the organisation is,
 * what kind it is, who owns it, where it is, and whether it is operating.
 *
 * Deliberately excluded: `isActive` (a record flag, not a claim about the world)
 * and the provenance fields themselves, mirroring `MATERIAL_ATTRIBUTES` for HCPs.
 */
export const HCO_MATERIAL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'name',
  'hcoType',
  'ownershipType',
  'operatingStatus',
  'parentHcoId',
  'country',
  'region',
  'city',
  'addressLine',
  'postalCode',
  'effectiveFrom',
  'effectiveTo',
]);

export function isMaterialHcoChange(changed: readonly string[]): boolean {
  return changed.some((attribute) => HCO_MATERIAL_ATTRIBUTES.has(attribute));
}

// --- organisation -----------------------------------------------------------

export async function createHco(principal: Principal, raw: unknown): Promise<Hco> {
  requirePermission(principal, Permission.HCO_WRITE);
  const input = parse(CreateHcoSchema, raw, 'HCO');
  // An organisation name is free text that reaches reports and exports; it must
  // not be used to smuggle a patient identifier into the pharma side (§45).
  assertFreeTextClean({ name: input.name, addressLine: input.addressLine });

  return withTransaction(async (client) => {
    if (input.parentHcoId) {
      const parent = await repo.getHcoById(principal.clinicId, input.parentHcoId, client);
      if (!parent) throw new NotFoundError('Parent HCO');
    }

    const hco = await repo.insertHco(client, {
      clinicId: principal.clinicId,
      name: input.name,
      hcoType: input.hcoType,
      parentHcoId: input.parentHcoId ?? null,
      ownershipType: input.ownershipType,
      country: input.country.toUpperCase(),
      region: input.region ?? null,
      city: input.city ?? null,
      addressLine: input.addressLine ?? null,
      postalCode: input.postalCode ?? null,
      source: input.provenance.source,
      sourceVersion: input.provenance.sourceVersion ?? null,
      sourceRef: input.provenance.sourceRef ?? null,
      sourceDate: input.provenance.sourceDate ?? null,
      jurisdiction: input.provenance.jurisdiction,
      confidence: input.provenance.confidence ?? null,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      createdBy: principal.userId,
    });

    await repo.insertHcoRevision(client, {
      clinicId: principal.clinicId,
      hcoId: hco.id,
      recordVersion: hco.recordVersion,
      changeType: 'create',
      changedFields: [],
      snapshot: hco,
      source: hco.provenance.source,
      changedBy: principal.userId,
    });

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.HCO_CREATED,
      subjectType: 'hco',
      subjectId: hco.id,
      actorId: principal.userId,
      payload: { hcoType: hco.hcoType, jurisdiction: hco.provenance.jurisdiction },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'hco.create',
      targetType: 'hco',
      targetId: hco.id,
      metadata: { source: hco.provenance.source },
    });
    return hco;
  });
}

export const ListHcoQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  hcoType: HCO_TYPE.optional(),
  ownershipType: OWNERSHIP_TYPE.optional(),
  operatingStatus: OPERATING_STATUS.optional(),
  verificationStatus: z
    .enum([
      'unverified',
      'pending_review',
      'verified',
      'rejected',
      'suspended',
      'expired',
      'disputed',
      'retired',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function listHcos(principal: Principal, rawQuery: unknown): Promise<Hco[]> {
  requirePermission(principal, Permission.HCO_READ);
  const query = parse(ListHcoQuerySchema, rawQuery ?? {}, 'HCO query');
  return repo.listHcos(principal.clinicId, {
    q: query.q ?? null,
    hcoType: query.hcoType ?? null,
    ownershipType: query.ownershipType ?? null,
    operatingStatus: query.operatingStatus ?? null,
    verificationStatus: query.verificationStatus ?? null,
    limit: query.limit,
  });
}

export async function getHco(principal: Principal, id: string): Promise<Hco> {
  requirePermission(principal, Permission.HCO_READ);
  const hco = await repo.getHcoById(principal.clinicId, id);
  if (!hco) throw new NotFoundError('HCO');
  return hco;
}

const COLUMN_OF: Record<string, repo.HcoUpdatableColumn> = {
  name: 'name',
  hcoType: 'hco_type',
  parentHcoId: 'parent_hco_id',
  ownershipType: 'ownership_type',
  operatingStatus: 'operating_status',
  country: 'country',
  region: 'region',
  city: 'city',
  addressLine: 'address_line',
  postalCode: 'postal_code',
  effectiveFrom: 'effective_from',
  effectiveTo: 'effective_to',
  isActive: 'is_active',
};

export async function updateHco(
  principal: Principal,
  id: string,
  raw: unknown,
): Promise<Hco> {
  requirePermission(principal, Permission.HCO_WRITE);
  const input = parse(UpdateHcoSchema, raw, 'HCO update');
  assertFreeTextClean({ name: input.name, addressLine: input.addressLine });

  return withTransaction(async (client) => {
    const current = await repo.getHcoForUpdate(client, principal.clinicId, id);
    if (!current) throw new NotFoundError('HCO');

    const patch: Partial<Record<repo.HcoUpdatableColumn, unknown>> = {};
    const changedFields: string[] = [];
    for (const [field, column] of Object.entries(COLUMN_OF)) {
      if (!(field in input)) continue;
      const next = (input as Record<string, unknown>)[field];
      if (next === (current as unknown as Record<string, unknown>)[field]) continue;
      patch[column] = next;
      changedFields.push(field);
    }

    if (input.parentHcoId) {
      if (input.parentHcoId === id) {
        throw new ValidationError('An organisation cannot be its own parent', {
          field: 'parentHcoId',
        });
      }
      const parent = await repo.getHcoById(principal.clinicId, input.parentHcoId, client);
      if (!parent) throw new NotFoundError('Parent HCO');
    }

    // Provenance always moves with the edit: a changed fact that still cites the
    // old source is a fact whose origin we can no longer answer for.
    patch.source = input.provenance.source;
    patch.source_version = input.provenance.sourceVersion ?? null;
    patch.source_ref = input.provenance.sourceRef ?? null;
    patch.source_date = input.provenance.sourceDate ?? null;
    patch.jurisdiction = input.provenance.jurisdiction;
    patch.confidence = input.provenance.confidence ?? null;
    if (current.provenance.jurisdiction !== input.provenance.jurisdiction) {
      changedFields.push('jurisdiction');
    }

    if (changedFields.length === 0) {
      throw new ConflictError('No field would change');
    }

    let revisionType: HcoRevision['changeType'] = 'update';
    // Verification never survives a material change: an unreviewed value must
    // not inherit a reviewed record's authority.
    if (isMaterialHcoChange(changedFields)) {
      const demoted = stateAfterMaterialChange(
        current.provenance.verificationStatus as VerificationState,
      );
      if (demoted) {
        await repo.applyHcoVerification(client, principal.clinicId, id, {
          status: demoted,
          note: null,
          verifiedBy: null,
          lastVerifiedAt: null,
          expiresAt: null,
          recordVersion: current.recordVersion,
        });
        revisionType = 'status_change';
      }
    }

    const updated = await repo.updateHcoColumns(
      client,
      principal.clinicId,
      id,
      patch,
      current.recordVersion + 1,
    );

    await repo.insertHcoRevision(client, {
      clinicId: principal.clinicId,
      hcoId: id,
      recordVersion: updated.recordVersion,
      changeType: revisionType,
      changedFields,
      snapshot: updated,
      source: updated.provenance.source,
      changedBy: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.HCO_UPDATED,
      subjectType: 'hco',
      subjectId: id,
      actorId: principal.userId,
      payload: { changedFields, verificationStatus: updated.provenance.verificationStatus },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'hco.update',
      targetType: 'hco',
      targetId: id,
      metadata: { changedFields },
    });
    return updated;
  });
}

// --- verification -----------------------------------------------------------

export async function decideHcoVerification(
  principal: Principal,
  id: string,
  raw: unknown,
): Promise<Hco> {
  requirePermission(principal, Permission.HCO_VERIFY);
  const input = parse(HcoVerificationSchema, raw, 'HCO verification decision');

  return withTransaction(async (client) => {
    const current = await repo.getHcoForUpdate(client, principal.clinicId, id);
    if (!current) throw new NotFoundError('HCO');

    const from = current.provenance.verificationStatus as VerificationState;
    const to = input.verificationStatus as VerificationState;
    // Throws ConflictError for an illegal edge, ValidationError for a legal edge
    // missing its reason. Same rule set as the HCP master, by construction.
    assertTransition(from, to, input.note ?? null);

    const verifying = to === VerificationState.VERIFIED;
    const updated = await repo.applyHcoVerification(client, principal.clinicId, id, {
      status: to,
      note: input.note ?? null,
      verifiedBy: verifying ? principal.userId : null,
      lastVerifiedAt: verifying ? new Date().toISOString() : null,
      expiresAt: verifying ? verificationExpiryFrom(input.validForDays) : null,
      recordVersion: current.recordVersion + 1,
    });

    await repo.insertHcoRevision(client, {
      clinicId: principal.clinicId,
      hcoId: id,
      recordVersion: updated.recordVersion,
      changeType: verifying ? 'verify' : 'status_change',
      changedFields: ['verificationStatus'],
      snapshot: updated,
      source: input.evidenceSource,
      changedBy: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.HCO_VERIFICATION_CHANGED,
      subjectType: 'hco',
      subjectId: id,
      actorId: principal.userId,
      payload: { from, to, evidenceSource: input.evidenceSource, expiresAt: updated.verificationExpiresAt },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'hco.verification',
      targetType: 'hco',
      targetId: id,
      metadata: { from, to },
    });
    return updated;
  });
}

/**
 * Move lapsed organisation verifications to `expired` and record the lapse in
 * history. Reads already DERIVE expiry, so this sweep only makes the stored
 * value agree with what callers are already shown — it is a bookkeeping job, and
 * nothing depends on it having run.
 */
export async function sweepHcoVerifications(
  principal: Principal,
  limit = 500,
): Promise<{ expired: number }> {
  requirePermission(principal, Permission.HCO_VERIFY);
  const bounded = Math.min(Math.max(limit, 1), 1000);

  const expired = await withTransaction(async (client) => {
    const due = await repo.expiredHcoVerifications(client, principal.clinicId, bounded);
    for (const row of due) {
      const updated = await repo.applyHcoVerification(client, principal.clinicId, row.id, {
        status: VerificationState.EXPIRED,
        note: null,
        verifiedBy: null,
        lastVerifiedAt: null,
        expiresAt: null,
        recordVersion: row.recordVersion + 1,
      });
      await repo.insertHcoRevision(client, {
        clinicId: principal.clinicId,
        hcoId: row.id,
        recordVersion: updated.recordVersion,
        changeType: 'verification_expired',
        changedFields: ['verificationStatus'],
        snapshot: updated,
        source: updated.provenance.source,
        // No actor: this is the system observing a lapse, not a human decision.
        changedBy: null,
      });
    }
    return due.length;
  });

  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'hco.verification.sweep',
    targetType: 'hco',
    targetId: null,
    metadata: { expired },
  });
  return { expired };
}

// --- merge ------------------------------------------------------------------

export async function mergeHco(principal: Principal, id: string, raw: unknown): Promise<Hco> {
  requirePermission(principal, Permission.HCO_MERGE);
  const input = parse(MergeHcoSchema, raw, 'HCO merge');
  if (input.survivorHcoId === id) {
    throw new ValidationError('An organisation cannot be merged into itself', {
      field: 'survivorHcoId',
    });
  }

  return withTransaction(async (client) => {
    const losing = await repo.getHcoForUpdate(client, principal.clinicId, id);
    if (!losing) throw new NotFoundError('HCO');
    const survivor = await repo.getHcoById(principal.clinicId, input.survivorHcoId, client);
    if (!survivor) throw new NotFoundError('Survivor HCO');
    if (losing.operatingStatus === 'merged') {
      throw new ConflictError('This organisation has already been merged', {
        mergedIntoHcoId: losing.mergedIntoHcoId,
      });
    }
    // A merge chain would make identity resolution ambiguous: resolving A→B→C
    // depends on traversal order, so the survivor must itself be a survivor.
    if (survivor.operatingStatus === 'merged') {
      throw new ConflictError('The survivor has itself been merged; merge into its survivor', {
        survivorMergedInto: survivor.mergedIntoHcoId,
      });
    }

    const updated = await repo.markHcoMerged(
      client,
      principal.clinicId,
      id,
      input.survivorHcoId,
      losing.recordVersion + 1,
    );

    await repo.insertHcoRevision(client, {
      clinicId: principal.clinicId,
      hcoId: id,
      recordVersion: updated.recordVersion,
      changeType: 'merge',
      changedFields: ['operatingStatus', 'mergedIntoHcoId'],
      snapshot: updated,
      source: updated.provenance.source,
      changedBy: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.HCO_MERGED,
      subjectType: 'hco',
      subjectId: id,
      actorId: principal.userId,
      payload: { survivorHcoId: input.survivorHcoId },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'hco.merge',
      targetType: 'hco',
      targetId: id,
      metadata: { survivorHcoId: input.survivorHcoId, reason: input.reason },
    });
    return updated;
  });
}

// --- identifiers ------------------------------------------------------------

export async function addHcoIdentifier(
  principal: Principal,
  hcoId: string,
  raw: unknown,
): Promise<HcoIdentifier> {
  requirePermission(principal, Permission.HCO_WRITE);
  const input = parse(CreateHcoIdentifierSchema, raw, 'HCO identifier');

  const system = input.identifierSystem.toUpperCase();
  if (!(system in HCO_IDENTIFIER_SYSTEMS)) {
    throw new ValidationError(
      `"${system}" is not a permitted organisation identifier system. An HCO record carries public business identifiers, never a person's identity document.`,
      { field: 'identifierSystem', allowed: Object.keys(HCO_IDENTIFIER_SYSTEMS) },
    );
  }

  return withTransaction(async (client) => {
    const hco = await repo.getHcoById(principal.clinicId, hcoId, client);
    if (!hco) throw new NotFoundError('HCO');
    try {
      const identifier = await repo.insertHcoIdentifier(client, {
        clinicId: principal.clinicId,
        hcoId,
        identifierSystem: system,
        identifierValue: input.identifierValue,
        issuingJurisdiction: input.issuingJurisdiction.toUpperCase(),
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        source: input.source,
        sourceVersion: input.sourceVersion ?? null,
        sourceDate: input.sourceDate ?? null,
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'hco.identifier.add',
        targetType: 'hco',
        targetId: hcoId,
        // The VALUE is not audited: an audit log is read far more widely than
        // the record, and a licence number is the record's business, not the log's.
        metadata: { identifierSystem: system },
      });
      return identifier;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictError(
          'That identifier already belongs to another organisation in this clinic',
          { identifierSystem: system },
        );
      }
      throw error;
    }
  });
}

export async function listHcoIdentifiers(
  principal: Principal,
  hcoId: string,
): Promise<HcoIdentifier[]> {
  requirePermission(principal, Permission.HCO_READ);
  const hco = await repo.getHcoById(principal.clinicId, hcoId);
  if (!hco) throw new NotFoundError('HCO');
  return repo.listHcoIdentifiers(principal.clinicId, hcoId);
}

// --- locations & departments ------------------------------------------------

export async function addHcoLocation(
  principal: Principal,
  hcoId: string,
  raw: unknown,
): Promise<HcoLocation> {
  requirePermission(principal, Permission.HCO_WRITE);
  const input = parse(CreateHcoLocationSchema, raw, 'HCO location');
  assertFreeTextClean({ label: input.label, addressLine: input.addressLine });

  return withTransaction(async (client) => {
    const hco = await repo.getHcoById(principal.clinicId, hcoId, client);
    if (!hco) throw new NotFoundError('HCO');

    if (input.territoryId) {
      const { rows } = await client.query(
        `SELECT 1 FROM territory WHERE id = $1 AND clinic_id = $2`,
        [input.territoryId, principal.clinicId],
      );
      if (rows.length === 0) throw new NotFoundError('Territory');
    }
    // Only one primary site per organisation (uq_hco_location_primary); demote
    // the incumbent rather than failing the caller with a constraint violation.
    if (input.isPrimary) {
      await repo.clearPrimaryLocation(client, principal.clinicId, hcoId);
    }

    try {
      const location = await repo.insertHcoLocation(client, {
        clinicId: principal.clinicId,
        hcoId,
        label: input.label,
        addressLine: input.addressLine ?? null,
        city: input.city ?? null,
        region: input.region ?? null,
        country: input.country.toUpperCase(),
        postalCode: input.postalCode ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        territoryId: input.territoryId ?? null,
        isPrimary: input.isPrimary,
        source: input.provenance.source,
        sourceVersion: input.provenance.sourceVersion ?? null,
        sourceRef: input.provenance.sourceRef ?? null,
        sourceDate: input.provenance.sourceDate ?? null,
        jurisdiction: input.provenance.jurisdiction,
        confidence: input.provenance.confidence ?? null,
        createdBy: principal.userId,
      });
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.HCO_LOCATION_ADDED,
        subjectType: 'hco',
        subjectId: hcoId,
        actorId: principal.userId,
        payload: { locationId: location.id, territoryId: location.territoryId },
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'hco.location.add',
        targetType: 'hco',
        targetId: hcoId,
        metadata: { locationId: location.id },
      });
      return location;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictError('This organisation already has a site with that label', {
          label: input.label,
        });
      }
      throw error;
    }
  });
}

export async function listHcoLocations(
  principal: Principal,
  hcoId: string,
): Promise<HcoLocation[]> {
  requirePermission(principal, Permission.HCO_READ);
  const hco = await repo.getHcoById(principal.clinicId, hcoId);
  if (!hco) throw new NotFoundError('HCO');
  return repo.listHcoLocations(principal.clinicId, hcoId);
}

export async function addHcoDepartment(
  principal: Principal,
  hcoId: string,
  raw: unknown,
): Promise<HcoDepartment> {
  requirePermission(principal, Permission.HCO_WRITE);
  const input = parse(CreateHcoDepartmentSchema, raw, 'HCO department');
  assertFreeTextClean({ name: input.name });

  return withTransaction(async (client) => {
    const hco = await repo.getHcoById(principal.clinicId, hcoId, client);
    if (!hco) throw new NotFoundError('HCO');

    if (input.hcoLocationId) {
      const location = await repo.getHcoLocationById(
        principal.clinicId,
        input.hcoLocationId,
        client,
      );
      // Belt and braces: the composite FK already refuses a site belonging to a
      // different organisation, but a 404 is a better answer than a 500.
      if (!location || location.hcoId !== hcoId) {
        throw new NotFoundError('HCO location');
      }
    }
    if (input.specialtyId) {
      const { rows } = await client.query(
        `SELECT 1 FROM specialty WHERE id = $1 AND clinic_id = $2`,
        [input.specialtyId, principal.clinicId],
      );
      if (rows.length === 0) throw new NotFoundError('Specialty');
    }

    try {
      const department = await repo.insertHcoDepartment(client, {
        clinicId: principal.clinicId,
        hcoId,
        hcoLocationId: input.hcoLocationId ?? null,
        name: input.name,
        specialtyId: input.specialtyId ?? null,
        source: input.provenance.source,
        sourceVersion: input.provenance.sourceVersion ?? null,
        sourceRef: input.provenance.sourceRef ?? null,
        sourceDate: input.provenance.sourceDate ?? null,
        jurisdiction: input.provenance.jurisdiction,
        confidence: input.provenance.confidence ?? null,
        createdBy: principal.userId,
      });
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.HCO_DEPARTMENT_ADDED,
        subjectType: 'hco',
        subjectId: hcoId,
        actorId: principal.userId,
        payload: { departmentId: department.id, specialtyId: department.specialtyId },
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'hco.department.add',
        targetType: 'hco',
        targetId: hcoId,
        metadata: { departmentId: department.id },
      });
      return department;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictError('That department already exists at this site', {
          name: input.name,
        });
      }
      throw error;
    }
  });
}

export async function listHcoDepartments(
  principal: Principal,
  hcoId: string,
): Promise<HcoDepartment[]> {
  requirePermission(principal, Permission.HCO_READ);
  const hco = await repo.getHcoById(principal.clinicId, hcoId);
  if (!hco) throw new NotFoundError('HCO');
  return repo.listHcoDepartments(principal.clinicId, hcoId);
}

export async function listHcoHistory(
  principal: Principal,
  hcoId: string,
): Promise<HcoRevision[]> {
  requirePermission(principal, Permission.HCO_READ);
  const hco = await repo.getHcoById(principal.clinicId, hcoId);
  if (!hco) throw new NotFoundError('HCO');
  return repo.listHcoRevisions(principal.clinicId, hcoId);
}

// --- HCO 360 ----------------------------------------------------------------

/**
 * HCO 360 — the authorized single view of a healthcare organisation.
 *
 * WHAT IT CONTAINS: the master record and its provenance, business identifiers,
 * sites, departments, the professionals affiliated to it, the specialties they
 * cover, the territories its sites sit in, and the master-data history.
 *
 * WHAT IT DOES NOT CONTAIN, BY CONSTRUCTION: anything about a patient. There is
 * no query in this module — or anywhere reachable from it — against a clinical
 * table. "360" describes the completeness of the ORGANISATIONAL picture, not
 * the care delivered inside it (§45).
 *
 * TERRITORY SCOPE: the organisation record itself is clinic-scoped, because an
 * organisation is not targeted the way a professional is. The AFFILIATED-HCP
 * and SPECIALTY-COVERAGE sections are territory-scoped, so a representative
 * cannot use an organisation as a side door onto the HCPs their territory does
 * not cover. `scopedToTerritories` on the response says which happened, rather
 * than leaving the caller to guess whether a short list means a small hospital.
 */
export async function hco360(principal: Principal, hcoId: string) {
  requirePermission(principal, Permission.HCO_READ);

  const hco = await repo.getHcoById(principal.clinicId, hcoId);
  if (!hco) throw new NotFoundError('HCO');

  const scope = await territoryScopeFor(principal, getPool());

  const [identifiers, locations, departments, affiliatedHcps, coverage, territories, revisions] =
    await Promise.all([
      repo.listHcoIdentifiers(principal.clinicId, hcoId),
      repo.listHcoLocations(principal.clinicId, hcoId),
      repo.listHcoDepartments(principal.clinicId, hcoId),
      repo.listAffiliatedHcps(principal.clinicId, hcoId, scope),
      repo.specialtyCoverage(principal.clinicId, hcoId, scope),
      repo.territoriesForHco(principal.clinicId, hcoId),
      repo.listHcoRevisions(principal.clinicId, hcoId),
    ]);

  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'hco.360.read',
    targetType: 'hco',
    targetId: hcoId,
    metadata: { affiliatedHcps: affiliatedHcps.length, scoped: scope !== null },
  });

  return {
    hco,
    provenance: hco.provenance,
    identifiers,
    locations,
    departments,
    affiliatedHcps,
    specialtyCoverage: coverage,
    territories,
    masterDataHistory: revisions,
    scopedToTerritories: scope,
    asOf: today(),
    dataBoundary:
      'Organisation, site and professional-affiliation data only. No patient-level data participates in this view (§45).',
  };
}
