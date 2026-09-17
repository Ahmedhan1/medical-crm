import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { audit, auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { assertFreeTextClean } from '../pharma/guards.js';
import {
  JurisdictionSchema,
  ProvenanceSchema,
  VerificationStatus,
} from '../pharma/provenance.js';
import { assertHcpInScope, territoryScopeFor } from '../pharma/visibility.js';
import {
  assertTransition,
  isMaterialChange,
  stateAfterMaterialChange,
  verificationExpiryFrom,
  VerificationState,
} from './verification.js';
import { assertHcoOpen, getHcoById } from './hco.repo.js';
import { assertHcpOpen } from './hcp.repo.js';
import * as repo from './hcp.repo.js';
import type { Hcp, Specialty } from './hcp.types.js';

/**
 * HCP / HCO master-data service.
 *
 * Three rules hold for every write here:
 *  1. **Provenance is mandatory.** `source` + `jurisdiction` are required by the
 *     schema at the API boundary, not defaulted silently.
 *  2. **Nothing is born verified.** Records enter as `unverified`; promoting one
 *     to `verified` needs `hcp:verify` (stewardship), which a field rep lacks.
 *  3. **Every change is versioned.** `record_version` increments and an
 *     append-only `hcp_revision` snapshot records what changed, from which
 *     source, by whom.
 */

/**
 * Identifier systems this platform will store: professional licensure and
 * public researcher/provider registries. Personal government identifiers
 * (national id, passport, tax id) are NOT on this list and are rejected —
 * an HCP record is a professional identity, not a civil one.
 *
 * Extending this list is a governance decision, not a code convenience.
 */
export const PROFESSIONAL_IDENTIFIER_SYSTEMS: Record<string, string> = {
  EG_MOH_LICENSE: 'Egyptian Ministry of Health practice licence number',
  EG_SYNDICATE: 'Egyptian Medical Syndicate membership number',
  NPI: 'US National Provider Identifier (public directory)',
  GMC: 'UK General Medical Council registration number (public register)',
  ORCID: 'ORCID researcher identifier (public)',
  INTERNAL: 'Internal MEDCORE reference for this HCP',
};

const NAME = z.string().trim().min(2).max(200);

export const ProfessionalCategorySchema = z.enum([
  'physician',
  'pharmacist',
  'dentist',
  'nurse',
  'veterinarian',
  'researcher',
  'allied_health',
  'other',
]);

const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const CreateHcpSchema = z.object({
  fullName: NAME,
  /** Required: the master must know what kind of professional this is. */
  professionalCategory: ProfessionalCategorySchema,
  effectiveFrom: DATE_ONLY.optional(),
  effectiveTo: DATE_ONLY.optional(),
  givenName: z.string().trim().max(100).optional(),
  familyName: z.string().trim().max(100).optional(),
  title: z.string().trim().max(40).optional(),
  primarySpecialtyId: z.string().uuid().optional(),
  professionalEmail: z.string().trim().email().max(200).optional(),
  professionalPhone: z.string().trim().min(5).max(32).optional(),
  preferredLanguage: z.string().trim().max(20).optional(),
  notes: z.string().trim().max(2000).optional(),
  provenance: ProvenanceSchema,
});

export const UpdateHcpSchema = CreateHcpSchema.partial().extend({
  status: z.enum(['active', 'inactive', 'retired']).optional(),
});

export const CreateSpecialtySchema = z.object({
  taxonomy: z.string().trim().min(2).max(40).default('MEDCORE'),
  code: z.string().trim().min(1).max(40),
  displayName: z.string().trim().min(2).max(160),
  parentId: z.string().uuid().optional(),
  source: z.string().trim().min(2).max(120),
  sourceVersion: z.string().trim().max(120).optional(),
  jurisdiction: JurisdictionSchema.optional(),
});

export const AddIdentifierSchema = z.object({
  identifierSystem: z.string().trim().min(2).max(60),
  identifierValue: z.string().trim().min(1).max(80),
  issuingJurisdiction: JurisdictionSchema,
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: z.string().trim().min(2).max(120),
  sourceVersion: z.string().trim().max(120).optional(),
});

export const AddAffiliationSchema = z.object({
  hcoId: z.string().uuid(),
  /**
   * The governed department (0308). Preferred over `department`, which is the
   * pre-0308 free-text value and is kept only so existing records stay readable.
   */
  hcoDepartmentId: z.string().uuid().optional(),
  department: z.string().trim().max(120).optional(),
  roleTitle: z.string().trim().max(120).optional(),
  affiliationType: z
    .enum(['primary', 'secondary', 'academic', 'consulting', 'honorary'])
    .default('primary'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: z.string().trim().min(2).max(120),
  sourceVersion: z.string().trim().max(120).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const AddPracticeLocationSchema = z.object({
  hcoId: z.string().uuid().optional(),
  label: z.string().trim().max(120).optional(),
  addressLine: z.string().trim().max(300).optional(),
  city: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  country: z.string().trim().length(2),
  postalCode: z.string().trim().max(20).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  visitingHours: z.record(z.unknown()).optional(),
  isPrimary: z.boolean().default(false),
  source: z.string().trim().min(2).max(120),
  sourceVersion: z.string().trim().max(120).optional(),
});

export const AddInterestSchema = z.object({
  interest: z.string().trim().min(2).max(160),
  interestType: z
    .enum(['therapeutic_area', 'research', 'education', 'digital', 'other'])
    .default('therapeutic_area'),
  strength: z.enum(['low', 'medium', 'high']).default('medium'),
  source: z.string().trim().min(2).max(120),
  confidence: z.number().min(0).max(1).optional(),
});

export const AddSpecialtyLinkSchema = z.object({
  specialtyId: z.string().uuid(),
  isPrimary: z.boolean().default(false),
  source: z.string().trim().min(2).max(120),
  confidence: z.number().min(0).max(1).optional(),
});

export const VerifyHcpSchema = z.object({
  verificationStatus: z.enum([
    'pending_review',
    'verified',
    'rejected',
    'suspended',
    'expired',
    'disputed',
    'retired',
  ]),
  /** What was checked — recorded in the revision trail, not free-form trust. */
  evidenceSource: z.string().trim().min(2).max(200),
  /** Required for `rejected` and `suspended`; an unexplained refusal is not reviewable. */
  note: z.string().trim().min(2).max(1000).optional(),
  /** Shelf life of this verification. Omit for the default of one year. */
  validForDays: z.number().int().min(1).max(3650).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const AddCredentialSchema = z.object({
  credentialType: z
    .enum(['degree', 'board_certification', 'fellowship', 'licence', 'training', 'other'])
    .default('degree'),
  credentialCode: z.string().trim().max(20).optional(),
  credentialName: z.string().trim().min(2).max(200),
  issuingBody: z.string().trim().max(200).optional(),
  issuingJurisdiction: JurisdictionSchema.optional(),
  awardedOn: DATE_ONLY.optional(),
  validFrom: DATE_ONLY.optional(),
  validTo: DATE_ONLY.optional(),
  source: z.string().trim().min(2).max(120),
  sourceVersion: z.string().trim().max(120).optional(),
  sourceDate: DATE_ONLY.optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Invalid ${what}`, parsed.error.flatten());
  return parsed.data;
}

// --- Specialty taxonomy -----------------------------------------------------

export async function createSpecialty(principal: Principal, raw: unknown): Promise<Specialty> {
  requirePermission(principal, Permission.HCP_WRITE);
  const input = parse(CreateSpecialtySchema, raw, 'specialty');
  return withTransaction(async (client) => {
    // `specialty.parent_id` references `specialty(id)` with no clinic in the
    // constraint, so the database would happily accept a parent from ANOTHER
    // tenant. Every other parent link in this workstream (HCO, territory)
    // checks the tenant in the service; this one did not.
    if (input.parentId) {
      const { rows } = await client.query(
        `SELECT 1 FROM specialty WHERE id = $1 AND clinic_id = $2`,
        [input.parentId, principal.clinicId],
      );
      if (rows.length === 0) throw new NotFoundError('Parent specialty');
    }
    return repo.insertSpecialty(client, {
      clinicId: principal.clinicId,
      taxonomy: input.taxonomy,
      code: input.code,
      displayName: input.displayName,
      parentId: input.parentId ?? null,
      source: input.source,
      sourceVersion: input.sourceVersion ?? null,
      jurisdiction: input.jurisdiction ?? null,
    });
  });
}

export async function listSpecialties(principal: Principal): Promise<Specialty[]> {
  requirePermission(principal, Permission.HCP_READ);
  return repo.listSpecialties(principal.clinicId);
}

// --- HCP core ---------------------------------------------------------------

export async function createHcp(principal: Principal, raw: unknown): Promise<Hcp> {
  requirePermission(principal, Permission.HCP_WRITE);
  const input = parse(CreateHcpSchema, raw, 'HCP');
  assertFreeTextClean({ notes: input.notes ?? null });

  return withTransaction(async (client) => {
    if (input.primarySpecialtyId) {
      const specialty = await repo.getSpecialtyById(principal.clinicId, input.primarySpecialtyId, client);
      if (!specialty) throw new NotFoundError('Specialty');
    }

    const hcp = await repo.insertHcp(client, {
      clinicId: principal.clinicId,
      fullName: input.fullName,
      givenName: input.givenName ?? null,
      familyName: input.familyName ?? null,
      title: input.title ?? null,
      primarySpecialtyId: input.primarySpecialtyId ?? null,
      professionalEmail: input.professionalEmail ?? null,
      professionalPhone: input.professionalPhone ?? null,
      preferredLanguage: input.preferredLanguage ?? null,
      notes: input.notes ?? null,
      source: input.provenance.source,
      sourceVersion: input.provenance.sourceVersion ?? null,
      sourceRef: input.provenance.sourceRef ?? null,
      jurisdiction: input.provenance.jurisdiction,
      confidence: input.provenance.confidence ?? null,
      createdBy: principal.userId,
      professionalCategory: input.professionalCategory,
      sourceDate: input.provenance.sourceDate ?? null,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
    });

    if (input.primarySpecialtyId) {
      await repo.linkHcpSpecialty(client, {
        clinicId: principal.clinicId,
        hcpId: hcp.id,
        specialtyId: input.primarySpecialtyId,
        isPrimary: true,
        source: input.provenance.source,
        confidence: input.provenance.confidence ?? null,
      });
    }

    await repo.insertHcpRevision(client, {
      clinicId: principal.clinicId,
      hcpId: hcp.id,
      recordVersion: hcp.recordVersion,
      changeType: 'create',
      changedFields: [],
      snapshot: hcp,
      source: hcp.provenance.source,
      changedBy: principal.userId,
    });

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.HCP_CREATED,
      subjectType: 'hcp',
      subjectId: hcp.id,
      actorId: principal.userId,
      payload: {
        source: hcp.provenance.source,
        jurisdiction: hcp.provenance.jurisdiction,
        verificationStatus: hcp.provenance.verificationStatus,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'hcp.create',
      targetType: 'hcp',
      targetId: hcp.id,
      metadata: { source: hcp.provenance.source, recordVersion: hcp.recordVersion },
    });
    return hcp;
  });
}

export async function getHcp(principal: Principal, id: string): Promise<Hcp> {
  requirePermission(principal, Permission.HCP_READ);
  const hcp = await repo.getHcpById(principal.clinicId, id);
  // Cross-clinic ids are filtered by clinic_id and are indistinguishable from
  // a genuinely unknown id; territory scope is a separate, explicit denial.
  if (!hcp) throw new NotFoundError('HCP');
  await assertHcpInScope(principal, id);
  return hcp;
}

export async function updateHcp(principal: Principal, id: string, raw: unknown): Promise<Hcp> {
  requirePermission(principal, Permission.HCP_WRITE);
  const input = parse(UpdateHcpSchema, raw, 'HCP update');
  assertFreeTextClean({ notes: input.notes ?? null });
  await assertHcpInScope(principal, id);

  return withTransaction(async (client) => {
    const before = await repo.getHcpForUpdate(client, principal.clinicId, id);
    if (!before) throw new NotFoundError('HCP');
    if (before.status === 'merged') {
      throw new ConflictError('This HCP record was merged and is read-only', {
        mergedIntoHcpId: before.mergedIntoHcpId,
      });
    }

    const fields: repo.HcpUpdateFields = {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.givenName !== undefined ? { givenName: input.givenName } : {}),
      ...(input.familyName !== undefined ? { familyName: input.familyName } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.primarySpecialtyId !== undefined
        ? { primarySpecialtyId: input.primarySpecialtyId }
        : {}),
      ...(input.professionalEmail !== undefined
        ? { professionalEmail: input.professionalEmail }
        : {}),
      ...(input.professionalPhone !== undefined
        ? { professionalPhone: input.professionalPhone }
        : {}),
      ...(input.preferredLanguage !== undefined
        ? { preferredLanguage: input.preferredLanguage }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    };

    // A change to the facts is a change to their provenance: the new values
    // came from somewhere, and that somewhere is recorded with them. An edit
    // also invalidates any prior verification.
    if (input.professionalCategory !== undefined) {
      fields.professionalCategory = input.professionalCategory;
    }
    if (input.effectiveFrom !== undefined) fields.effectiveFrom = input.effectiveFrom;
    if (input.effectiveTo !== undefined) fields.effectiveTo = input.effectiveTo;

    if (input.provenance) {
      fields.source = input.provenance.source;
      fields.sourceVersion = input.provenance.sourceVersion ?? null;
      fields.sourceRef = input.provenance.sourceRef ?? null;
      fields.sourceDate = input.provenance.sourceDate ?? null;
      fields.jurisdiction = input.provenance.jurisdiction;
      fields.confidence = input.provenance.confidence ?? null;
    }
    if (Object.keys(fields).length === 0) return before;

    const changed = repo.changedFieldNames(before, fields);

    // Phase 6: verification never survives a MATERIAL change. Re-citing a source
    // for unchanged facts is not material, so improving provenance no longer
    // costs a record its review — an earlier, blunter rule did exactly that.
    if (isMaterialChange(changed)) {
      const downgraded = stateAfterMaterialChange(
        before.provenance.verificationStatus as VerificationState,
      );
      if (downgraded) {
        fields.verificationStatus = downgraded;
        // The lapse clock belongs to the verification that is being invalidated.
        fields.verificationExpiresAt = null;
      }
    }
    const after = await repo.updateHcp(client, principal.clinicId, id, fields);

    await repo.insertHcpRevision(client, {
      clinicId: principal.clinicId,
      hcpId: after.id,
      recordVersion: after.recordVersion,
      changeType: 'update',
      changedFields: changed,
      snapshot: after,
      source: after.provenance.source,
      changedBy: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.HCP_UPDATED,
      subjectType: 'hcp',
      subjectId: after.id,
      actorId: principal.userId,
      payload: { changedFields: changed, recordVersion: after.recordVersion },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'hcp.update',
      targetType: 'hcp',
      targetId: after.id,
      metadata: { changedFields: changed, recordVersion: after.recordVersion },
    });
    return after;
  });
}

/** Stewardship: change an HCP's verification state. Requires `hcp:verify`. */
export async function setHcpVerification(
  principal: Principal,
  id: string,
  raw: unknown,
): Promise<Hcp> {
  requirePermission(principal, Permission.HCP_VERIFY);
  const input = parse(VerifyHcpSchema, raw, 'verification');
  // Operator free text reaches the revision trail and the audit log. It is
  // screened for the same reason a call report is: a human typing into a box is
  // the one place a patient identifier can cross into the commercial side by
  // hand — and these stores are append-only, so it cannot be edited out after.
  assertFreeTextClean({ evidenceSource: input.evidenceSource, note: input.note ?? null });

  return withTransaction(async (client) => {
    const before = await repo.getHcpForUpdate(client, principal.clinicId, id);
    if (!before) throw new NotFoundError('HCP');
    // A resolved-away identity cannot be re-attested: the claim would be about
    // a record nobody is supposed to use again.
    assertHcpOpen(before);

    // Phase 6: the transition must be legal from where the record actually is,
    // and adequately evidenced. `before.provenance.verificationStatus` is the
    // EFFECTIVE state, so a lapsed record is treated as `expired` here even if
    // the stored column still reads `verified` and no sweep has run.
    const from = before.provenance.verificationStatus as VerificationState;
    const to = input.verificationStatus as VerificationState;
    assertTransition(from, to, input.note ?? null);

    const verifying = to === VerificationState.VERIFIED;
    const after = await repo.updateHcp(client, principal.clinicId, id, {
      verificationStatus: input.verificationStatus,
      verifiedBy: verifying ? principal.userId : null,
      // The schema requires evidence of *when* for a verified record.
      lastVerifiedAt: verifying ? new Date().toISOString() : before.provenance.lastVerifiedAt,
      // A verification is granted for a bounded period; anything else is a
      // permanent claim dressed up as a check.
      verificationExpiresAt: verifying ? verificationExpiryFrom(input.validForDays) : null,
      verificationNote: input.note ?? null,
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    });

    await repo.insertHcpRevision(client, {
      clinicId: principal.clinicId,
      hcpId: after.id,
      recordVersion: after.recordVersion,
      changeType: 'verify',
      changedFields: ['verificationStatus'],
      snapshot: after,
      source: input.evidenceSource,
      changedBy: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.HCP_VERIFIED,
      subjectType: 'hcp',
      subjectId: after.id,
      actorId: principal.userId,
      payload: {
        from,
        to: after.provenance.verificationStatus,
        evidenceSource: input.evidenceSource,
        expiresAt: after.verificationExpiresAt,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'hcp.verify',
      targetType: 'hcp',
      targetId: after.id,
      metadata: {
        verificationStatus: after.provenance.verificationStatus,
        evidenceSource: input.evidenceSource,
      },
    });
    return after;
  });
}

/**
 * Identity resolution: fold a duplicate into a surviving master record. The
 * duplicate is kept (never deleted) and marked `merged` with a pointer, so
 * references to the old id remain resolvable and the decision stays auditable.
 */
export async function mergeHcp(
  principal: Principal,
  sourceHcpId: string,
  targetHcpId: string,
  reason: string,
): Promise<Hcp> {
  requirePermission(principal, Permission.HCP_MERGE);
  assertFreeTextClean({ reason });
  if (sourceHcpId === targetHcpId) {
    throw new ValidationError('An HCP cannot be merged into itself');
  }

  return withTransaction(async (client) => {
    const source = await repo.getHcpForUpdate(client, principal.clinicId, sourceHcpId);
    const target = await repo.getHcpById(principal.clinicId, targetHcpId, client);
    if (!source) throw new NotFoundError('Source HCP');
    if (!target) throw new NotFoundError('Target HCP');
    if (source.status === 'merged') throw new ConflictError('Source HCP is already merged');
    if (target.status === 'merged') {
      throw new ConflictError('Cannot merge into a record that is itself merged');
    }

    const after = await repo.updateHcp(client, principal.clinicId, sourceHcpId, {
      status: 'merged',
      mergedIntoHcpId: targetHcpId,
    });

    await repo.insertHcpRevision(client, {
      clinicId: principal.clinicId,
      hcpId: after.id,
      recordVersion: after.recordVersion,
      changeType: 'merge',
      changedFields: ['status', 'mergedIntoHcpId'],
      snapshot: after,
      source: after.provenance.source,
      changedBy: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.HCP_MERGED,
      subjectType: 'hcp',
      subjectId: after.id,
      actorId: principal.userId,
      payload: { mergedIntoHcpId: targetHcpId },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'hcp.merge',
      targetType: 'hcp',
      targetId: after.id,
      metadata: { mergedIntoHcpId: targetHcpId, reason },
    });
    return after;
  });
}

export interface SearchHcpParams {
  q?: string;
  specialtyId?: string;
  verificationStatus?: string;
  professionalCategory?: string;
  limit?: number;
  offset?: number;
}

export async function searchHcps(principal: Principal, params: SearchHcpParams): Promise<Hcp[]> {
  requirePermission(principal, Permission.HCP_SEARCH);
  const scope = await territoryScopeFor(principal);
  // A representative with no territory sees nothing — not the whole master.
  if (scope !== null && scope.length === 0) return [];
  return repo.searchHcps(principal.clinicId, {
    q: params.q?.trim() || null,
    specialtyId: params.specialtyId ?? null,
    verificationStatus: (params.verificationStatus as never) ?? null,
    professionalCategory: params.professionalCategory ?? null,
    territoryIds: scope,
    limit: Math.min(Math.max(params.limit ?? 25, 1), 100),
    offset: Math.max(params.offset ?? 0, 0),
  });
}

// --- Attached master-data records -------------------------------------------

export async function addIdentifier(principal: Principal, hcpId: string, raw: unknown) {
  requirePermission(principal, Permission.HCP_WRITE);
  const input = parse(AddIdentifierSchema, raw, 'identifier');
  const system = input.identifierSystem.toUpperCase();
  if (!(system in PROFESSIONAL_IDENTIFIER_SYSTEMS)) {
    throw new ValidationError(
      `Unsupported identifier system "${system}". Only legally available professional ` +
        'identifiers may be stored; personal government identifiers are not permitted.',
      { allowed: Object.keys(PROFESSIONAL_IDENTIFIER_SYSTEMS) },
    );
  }
  await assertHcpInScope(principal, hcpId);

  return withTransaction(async (client) => {
    const hcp = await repo.getHcpById(principal.clinicId, hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');
    assertHcpOpen(hcp);
    try {
      const identifier = await repo.insertHcpIdentifier(client, {
        clinicId: principal.clinicId,
        hcpId,
        identifierSystem: system,
        identifierValue: input.identifierValue,
        issuingJurisdiction: input.issuingJurisdiction,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        source: input.source,
        sourceVersion: input.sourceVersion ?? null,
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'hcp.identifier.add',
        targetType: 'hcp',
        targetId: hcpId,
        metadata: { identifierSystem: system, source: input.source },
      });
      return identifier;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('This identifier is already registered to an HCP');
      }
      throw err;
    }
  });
}

export async function addAffiliation(principal: Principal, hcpId: string, raw: unknown) {
  requirePermission(principal, Permission.HCP_WRITE);
  const input = parse(AddAffiliationSchema, raw, 'affiliation');
  await assertHcpInScope(principal, hcpId);

  return withTransaction(async (client) => {
    const hcp = await repo.getHcpById(principal.clinicId, hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');
    assertHcpOpen(hcp);
    // The OTHER side of the relationship is checked too: affiliating someone to
    // an organisation that has been resolved away would put the relationship on
    // a record nobody is supposed to use again.
    const hco = await getHcoById(principal.clinicId, input.hcoId, client);
    if (!hco) throw new NotFoundError('HCO');
    assertHcoOpen(hco);

    if (input.hcoDepartmentId) {
      // The composite FK already refuses a department belonging to a different
      // organisation; checking here turns a 500 into an honest 404.
      const { rows: dept } = await client.query(
        `SELECT 1 FROM hco_department WHERE id = $1 AND hco_id = $2 AND clinic_id = $3`,
        [input.hcoDepartmentId, input.hcoId, principal.clinicId],
      );
      if (dept.length === 0) throw new NotFoundError('HCO department');
    }

    try {
      const affiliation = await repo.insertAffiliation(client, {
        clinicId: principal.clinicId,
        hcpId,
        hcoId: input.hcoId,
        hcoDepartmentId: input.hcoDepartmentId ?? null,
        department: input.department ?? null,
        roleTitle: input.roleTitle ?? null,
        affiliationType: input.affiliationType,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        source: input.source,
        sourceVersion: input.sourceVersion ?? null,
        confidence: input.confidence ?? null,
      });
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.HCP_AFFILIATION_CHANGED,
        subjectType: 'hcp',
        subjectId: hcpId,
        actorId: principal.userId,
        payload: { hcoId: input.hcoId, affiliationType: input.affiliationType },
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'hcp.affiliation.add',
        targetType: 'hcp',
        targetId: hcpId,
        metadata: { hcoId: input.hcoId, source: input.source },
      });
      return affiliation;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('An open affiliation with this HCO and department already exists');
      }
      throw err;
    }
  });
}

export async function addPracticeLocation(principal: Principal, hcpId: string, raw: unknown) {
  requirePermission(principal, Permission.HCP_WRITE);
  const input = parse(AddPracticeLocationSchema, raw, 'practice location');
  await assertHcpInScope(principal, hcpId);

  return withTransaction(async (client) => {
    const hcp = await repo.getHcpById(principal.clinicId, hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');
    assertHcpOpen(hcp);
    try {
      const location = await repo.insertPracticeLocation(client, {
        clinicId: principal.clinicId,
        hcpId,
        hcoId: input.hcoId ?? null,
        label: input.label ?? null,
        addressLine: input.addressLine ?? null,
        city: input.city ?? null,
        region: input.region ?? null,
        country: input.country.toUpperCase(),
        postalCode: input.postalCode ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        visitingHours: input.visitingHours ?? {},
        isPrimary: input.isPrimary,
        source: input.source,
        sourceVersion: input.sourceVersion ?? null,
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'hcp.location.add',
        targetType: 'hcp',
        targetId: hcpId,
        metadata: { source: input.source },
      });
      return location;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('This HCP already has a primary practice location');
      }
      throw err;
    }
  });
}

export async function addInterest(principal: Principal, hcpId: string, raw: unknown) {
  requirePermission(principal, Permission.HCP_WRITE);
  const input = parse(AddInterestSchema, raw, 'professional interest');
  assertFreeTextClean({ interest: input.interest });
  await assertHcpInScope(principal, hcpId);

  return withTransaction(async (client) => {
    const hcp = await repo.getHcpById(principal.clinicId, hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');
    assertHcpOpen(hcp);
    await repo.insertInterest(client, {
      clinicId: principal.clinicId,
      hcpId,
      interest: input.interest,
      interestType: input.interestType,
      strength: input.strength,
      source: input.source,
      confidence: input.confidence ?? null,
    });
    return repo.listInterests(principal.clinicId, hcpId);
  });
}

export async function addSpecialtyLink(principal: Principal, hcpId: string, raw: unknown) {
  requirePermission(principal, Permission.HCP_WRITE);
  const input = parse(AddSpecialtyLinkSchema, raw, 'specialty link');
  await assertHcpInScope(principal, hcpId);

  return withTransaction(async (client) => {
    const hcp = await repo.getHcpById(principal.clinicId, hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');
    assertHcpOpen(hcp);
    const specialty = await repo.getSpecialtyById(principal.clinicId, input.specialtyId, client);
    if (!specialty) throw new NotFoundError('Specialty');
    await repo.linkHcpSpecialty(client, {
      clinicId: principal.clinicId,
      hcpId,
      specialtyId: input.specialtyId,
      isPrimary: input.isPrimary,
      source: input.source,
      confidence: input.confidence ?? null,
    });
    return repo.listHcpSpecialties(principal.clinicId, hcpId);
  });
}

export async function getHcpRevisions(principal: Principal, hcpId: string) {
  requirePermission(principal, Permission.HCP_READ);
  await assertHcpInScope(principal, hcpId);
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'hcp.history.read',
    targetType: 'hcp',
    targetId: hcpId,
  });
  return repo.listHcpRevisions(principal.clinicId, hcpId);
}


// --- Credentials, attribute provenance, verification expiry (Phase 5-7) ------

export async function addCredential(principal: Principal, hcpId: string, raw: unknown) {
  requirePermission(principal, Permission.HCP_WRITE);
  const input = parse(AddCredentialSchema, raw, 'credential');
  assertFreeTextClean({
    credentialName: input.credentialName,
    issuingBody: input.issuingBody ?? null,
  });
  await assertHcpInScope(principal, hcpId);

  return withTransaction(async (client) => {
    const hcp = await repo.getHcpById(principal.clinicId, hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');
    assertHcpOpen(hcp);
    try {
      const credential = await repo.insertCredential(client, {
        clinicId: principal.clinicId,
        hcpId,
        credentialType: input.credentialType,
        credentialCode: input.credentialCode ?? null,
        credentialName: input.credentialName,
        issuingBody: input.issuingBody ?? null,
        issuingJurisdiction: input.issuingJurisdiction ?? null,
        awardedOn: input.awardedOn ?? null,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        source: input.source,
        sourceVersion: input.sourceVersion ?? null,
        sourceDate: input.sourceDate ?? null,
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'hcp.credential.add',
        targetType: 'hcp',
        targetId: hcpId,
        metadata: { credentialType: input.credentialType, source: input.source },
      });
      return credential;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('This credential is already recorded for this HCP');
      }
      throw err;
    }
  });
}

export async function listCredentials(principal: Principal, hcpId: string) {
  requirePermission(principal, Permission.HCP_READ);
  await assertHcpInScope(principal, hcpId);
  return repo.listCredentials(principal.clinicId, hcpId);
}

/**
 * Where each attribute of this record came from.
 *
 * Derived from the append-only revision history rather than a parallel
 * per-attribute table, so there is exactly one account of what changed, from
 * which source, by whom — and it cannot drift from the history itself.
 */
export async function getAttributeProvenance(principal: Principal, hcpId: string) {
  requirePermission(principal, Permission.HCP_READ);
  await assertHcpInScope(principal, hcpId);
  const hcp = await repo.getHcpById(principal.clinicId, hcpId);
  if (!hcp) throw new NotFoundError('HCP');
  const attributes = await repo.attributeProvenance(principal.clinicId, hcpId);
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'hcp.provenance.read',
    targetType: 'hcp',
    targetId: hcpId,
  });
  return {
    hcpId,
    recordProvenance: hcp.provenance,
    effectiveFrom: hcp.effectiveFrom,
    effectiveTo: hcp.effectiveTo,
    attributes,
  };
}

/**
 * Persist lapsed verifications.
 *
 * Expiry is already DERIVED on every read, so this sweep changes no answer — it
 * makes the stored state agree with the derived one and emits the events that
 * downstream workflows need. That ordering is deliberate: correctness must not
 * depend on the sweep having run.
 */
export async function sweepExpiredVerifications(principal: Principal, limit = 200) {
  requirePermission(principal, Permission.HCP_VERIFY);
  const capped = Math.min(Math.max(limit, 1), 1000);

  return withTransaction(async (client) => {
    const lapsed = await repo.lapsedVerifications(client, principal.clinicId, capped);
    const expired: string[] = [];

    for (const hcp of lapsed) {
      const after = await repo.updateHcp(client, principal.clinicId, hcp.id, {
        verificationStatus: VerificationState.EXPIRED,
        verifiedBy: null,
      });
      await repo.insertHcpRevision(client, {
        clinicId: principal.clinicId,
        hcpId: hcp.id,
        recordVersion: after.recordVersion,
        changeType: 'verification_expired',
        changedFields: ['verificationStatus'],
        snapshot: after,
        source: 'verification_expiry_sweep',
        changedBy: principal.userId,
      });
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.HCP_VERIFICATION_EXPIRED,
        subjectType: 'hcp',
        subjectId: hcp.id,
        actorId: principal.userId,
        payload: { expiredAt: hcp.verificationExpiresAt },
      });
      expired.push(hcp.id);
    }

    if (expired.length > 0) {
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'hcp.verification.sweep',
        targetType: 'hcp',
        metadata: { expired: expired.length },
      });
    }
    return { expired: expired.length, hcpIds: expired };
  });
}

/**
 * Amend or CLOSE an affiliation.
 *
 * The missing half of `addAffiliation`. An affiliation could be created and
 * never ended, so a physician who left a hospital stayed on its 360 and in its
 * specialty coverage indefinitely — and because `uq_affiliation_open` keys on
 * `end_date IS NULL`, the same affiliation could never be recorded a second
 * time, so someone who returned after a gap was unrepresentable.
 *
 * Scoped like every other HCP write: `hcp:write`, the caller's territory, and a
 * merged record is closed to it.
 */
export const UpdateAffiliationSchema = z
  .object({
    endDate: DATE_ONLY.optional(),
    roleTitle: z.string().trim().max(120).optional(),
    affiliationType: z
      .enum(['primary', 'secondary', 'academic', 'consulting', 'honorary'])
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to change',
  });

export async function updateAffiliation(
  principal: Principal,
  hcpId: string,
  affiliationId: string,
  raw: unknown,
) {
  requirePermission(principal, Permission.HCP_WRITE);
  const input = parse(UpdateAffiliationSchema, raw, 'affiliation update');
  if (input.roleTitle) assertFreeTextClean({ roleTitle: input.roleTitle });
  await assertHcpInScope(principal, hcpId);

  return withTransaction(async (client) => {
    const hcp = await repo.getHcpById(principal.clinicId, hcpId, client);
    if (!hcp) throw new NotFoundError('HCP');
    assertHcpOpen(hcp);

    const existing = await repo.getAffiliationById(principal.clinicId, affiliationId, client);
    // Tenancy and ownership before shape: an affiliation belonging to another
    // HCP is never confirmed to exist.
    if (!existing || existing.hcpId !== hcpId) throw new NotFoundError('Affiliation');
    if (input.endDate !== undefined && existing.endDate !== null) {
      throw new ConflictError('This affiliation has already been ended', {
        endDate: existing.endDate,
      });
    }

    const updated = await repo.updateAffiliation(client, principal.clinicId, affiliationId, hcpId, {
      endDate: input.endDate ?? null,
      roleTitle: input.roleTitle ?? null,
      affiliationType: input.affiliationType,
    });
    if (!updated) throw new NotFoundError('Affiliation');

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.HCP_AFFILIATION_CHANGED,
      subjectType: 'hcp',
      subjectId: hcpId,
      actorId: principal.userId,
      payload: {
        affiliationId,
        hcoId: updated.hcoId,
        endDate: updated.endDate,
        affiliationType: updated.affiliationType,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'hcp.affiliation.update',
      targetType: 'hcp',
      targetId: hcpId,
      metadata: { affiliationId, endDate: updated.endDate },
    });
    return updated;
  });
}
