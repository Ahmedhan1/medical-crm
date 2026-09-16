import { getPool, type PoolClient } from '../../db/pool.js';
import { toDateString } from '../pharma/dates.js';
import {
  mapProvenance,
  numericToNumber,
  type ProvenanceRow,
  type VerificationStatus,
} from '../pharma/provenance.js';
import type {
  AttributeProvenance,
  Hcp,
  HcpAffiliation,
  HcpCredential,
  HcpIdentifier,
  HcpSpecialtyLink,
  HcpRevision,
  PracticeLocation,
  ProfessionalInterest,
  Specialty,
} from './hcp.types.js';

type Runner = Pick<PoolClient, 'query'>;

/**
 * Every HCP read goes through this list rather than `SELECT *`, so the derived
 * verification status is computed consistently and cannot be forgotten by a new
 * query. `h` is the required alias for the `hcp` table.
 */
const SELECT_HCP_COLUMNS = `h.*,
         pharma_effective_verification(h.verification_status, h.verification_expires_at)
           AS effective_verification_status`;

/** The same expression for use in a WHERE clause (filters must agree with reads). */
const EFFECTIVE_VERIFICATION =
  'pharma_effective_verification(h.verification_status, h.verification_expires_at)';

/**
 * HCP master-data repository.
 *
 * GOVERNANCE: every statement in this file touches only HCP/HCO master tables.
 * No query here may reference `patient`, `encounter` or any clinical table —
 * the pharma side has no read path into clinical data (§45), and
 * `test/integration/pharma-firewall.test.ts` asserts that statically.
 */

// --- row shapes -------------------------------------------------------------

interface HcpRow extends ProvenanceRow {
  id: string;
  clinic_id: string;
  professional_category: Hcp['professionalCategory'];
  source_date: Date | string | null;
  effective_from: Date | string | null;
  effective_to: Date | string | null;
  verification_expires_at: string | null;
  verification_note: string | null;
  /** Computed by `pharma_effective_verification` — see SELECT_HCP_COLUMNS. */
  effective_verification_status: VerificationStatus;
  full_name: string;
  given_name: string | null;
  family_name: string | null;
  title: string | null;
  primary_specialty_id: string | null;
  professional_email: string | null;
  professional_phone: string | null;
  preferred_language: string | null;
  notes: string | null;
  record_version: number;
  status: Hcp['status'];
  merged_into_hcp_id: string | null;
  created_at: string;
  updated_at: string;
}

export function mapHcp(row: HcpRow): Hcp {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    professionalCategory: row.professional_category,
    effectiveFrom: toDateString(row.effective_from),
    effectiveTo: toDateString(row.effective_to),
    verificationExpiresAt: row.verification_expires_at,
    verificationNote: row.verification_note,
    fullName: row.full_name,
    givenName: row.given_name,
    familyName: row.family_name,
    title: row.title,
    primarySpecialtyId: row.primary_specialty_id,
    professionalEmail: row.professional_email,
    professionalPhone: row.professional_phone,
    preferredLanguage: row.preferred_language,
    notes: row.notes,
    provenance: {
      ...mapProvenance(row),
      sourceDate: toDateString(row.source_date),
      // Expiry is DERIVED, so a lapsed verification reads as `expired` even if
      // no sweep has run. A missed background job can never leave a stale
      // "verified" on display.
      verificationStatus: row.effective_verification_status,
    },
    recordVersion: row.record_version,
    status: row.status,
    mergedIntoHcpId: row.merged_into_hcp_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Specialty taxonomy -----------------------------------------------------

interface SpecialtyRow {
  id: string;
  clinic_id: string;
  taxonomy: string;
  code: string;
  display_name: string;
  parent_id: string | null;
  source: string;
  source_version: string | null;
  jurisdiction: string | null;
  last_verified_at: string | null;
}

function mapSpecialty(row: SpecialtyRow): Specialty {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    taxonomy: row.taxonomy,
    code: row.code,
    displayName: row.display_name,
    parentId: row.parent_id,
    source: row.source,
    sourceVersion: row.source_version,
    jurisdiction: row.jurisdiction,
    lastVerifiedAt: row.last_verified_at,
  };
}

export interface InsertSpecialtyInput {
  clinicId: string;
  taxonomy: string;
  code: string;
  displayName: string;
  parentId: string | null;
  source: string;
  sourceVersion: string | null;
  jurisdiction: string | null;
}

export async function insertSpecialty(
  runner: Runner,
  input: InsertSpecialtyInput,
): Promise<Specialty> {
  const { rows } = await runner.query<SpecialtyRow>(
    `INSERT INTO specialty
       (clinic_id, taxonomy, code, display_name, parent_id, source, source_version, jurisdiction)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      input.clinicId,
      input.taxonomy,
      input.code,
      input.displayName,
      input.parentId,
      input.source,
      input.sourceVersion,
      input.jurisdiction,
    ],
  );
  return mapSpecialty(rows[0]!);
}

export async function listSpecialties(clinicId: string): Promise<Specialty[]> {
  const { rows } = await getPool().query<SpecialtyRow>(
    `SELECT * FROM specialty WHERE clinic_id = $1 ORDER BY taxonomy, code`,
    [clinicId],
  );
  return rows.map(mapSpecialty);
}

export async function getSpecialtyById(
  clinicId: string,
  id: string,
  runner: Runner = getPool(),
): Promise<Specialty | null> {
  const { rows } = await runner.query<SpecialtyRow>(
    `SELECT * FROM specialty WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapSpecialty(rows[0]) : null;
}

// --- HCP --------------------------------------------------------------------

export interface InsertHcpInput {
  clinicId: string;
  fullName: string;
  givenName: string | null;
  familyName: string | null;
  title: string | null;
  primarySpecialtyId: string | null;
  professionalEmail: string | null;
  professionalPhone: string | null;
  preferredLanguage: string | null;
  notes: string | null;
  source: string;
  sourceVersion: string | null;
  sourceRef: string | null;
  jurisdiction: string;
  confidence: number | null;
  createdBy: string;
  professionalCategory: string;
  sourceDate: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export async function insertHcp(runner: Runner, input: InsertHcpInput): Promise<Hcp> {
  const { rows } = await runner.query<HcpRow>(
    `WITH inserted AS (
       INSERT INTO hcp
         (clinic_id, full_name, given_name, family_name, title, primary_specialty_id,
          professional_email, professional_phone, preferred_language, notes,
          source, source_version, source_ref, jurisdiction, confidence, created_by,
          professional_category, source_date, effective_from, effective_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *
     )
     SELECT ${SELECT_HCP_COLUMNS} FROM inserted h`,
    [
      input.clinicId,
      input.fullName,
      input.givenName,
      input.familyName,
      input.title,
      input.primarySpecialtyId,
      input.professionalEmail,
      input.professionalPhone,
      input.preferredLanguage,
      input.notes,
      input.source,
      input.sourceVersion,
      input.sourceRef,
      input.jurisdiction,
      input.confidence,
      input.createdBy,
      input.professionalCategory,
      input.sourceDate,
      input.effectiveFrom,
      input.effectiveTo,
    ],
  );
  return mapHcp(rows[0]!);
}

export async function getHcpById(
  clinicId: string,
  id: string,
  runner: Runner = getPool(),
): Promise<Hcp | null> {
  const { rows } = await runner.query<HcpRow>(
    `SELECT ${SELECT_HCP_COLUMNS} FROM hcp h WHERE h.id = $1 AND h.clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapHcp(rows[0]) : null;
}

/** Lock an HCP row for a read-modify-write cycle (record_version is monotonic). */
export async function getHcpForUpdate(
  client: PoolClient,
  clinicId: string,
  id: string,
): Promise<Hcp | null> {
  const { rows } = await client.query<HcpRow>(
    `SELECT ${SELECT_HCP_COLUMNS} FROM hcp h WHERE h.id = $1 AND h.clinic_id = $2 FOR UPDATE`,
    [id, clinicId],
  );
  return rows[0] ? mapHcp(rows[0]) : null;
}

export interface HcpSearchFilter {
  q: string | null;
  specialtyId: string | null;
  verificationStatus: VerificationStatus | null;
  /**
   * When set, only HCPs targeted in one of these territories are visible. This
   * is how a field representative is confined to their own territory.
   */
  territoryIds: string[] | null;
  professionalCategory: string | null;
  limit: number;
  offset: number;
}

export async function searchHcps(clinicId: string, filter: HcpSearchFilter): Promise<Hcp[]> {
  const { rows } = await getPool().query<HcpRow>(
    `SELECT ${SELECT_HCP_COLUMNS} FROM hcp h
      WHERE h.clinic_id = $1
        AND h.status <> 'merged'
        AND ($2::text IS NULL OR lower(h.full_name) LIKE '%' || lower($2) || '%')
        AND ($3::uuid IS NULL OR h.primary_specialty_id = $3
             OR EXISTS (SELECT 1 FROM hcp_specialty hs
                         WHERE hs.hcp_id = h.id AND hs.specialty_id = $3))
        AND ($4::text IS NULL OR ${EFFECTIVE_VERIFICATION} = $4)
        AND ($5::uuid[] IS NULL OR EXISTS (
              SELECT 1 FROM hcp_territory ht
               WHERE ht.hcp_id = h.id AND ht.territory_id = ANY($5)))
        AND ($8::text IS NULL OR h.professional_category = $8)
      ORDER BY h.full_name
      LIMIT $6 OFFSET $7`,
    [
      clinicId,
      filter.q,
      filter.specialtyId,
      filter.verificationStatus,
      filter.territoryIds,
      filter.limit,
      filter.offset,
      filter.professionalCategory,
    ],
  );
  return rows.map(mapHcp);
}

/** True when the HCP is targeted in at least one of the given territories. */
export async function isHcpInTerritories(
  runner: Runner,
  clinicId: string,
  hcpId: string,
  territoryIds: string[],
): Promise<boolean> {
  if (territoryIds.length === 0) return false;
  const { rows } = await runner.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM hcp_territory
        WHERE clinic_id = $1 AND hcp_id = $2 AND territory_id = ANY($3)
     ) AS ok`,
    [clinicId, hcpId, territoryIds],
  );
  return rows[0]!.ok;
}

export interface HcpUpdateFields {
  fullName?: string;
  givenName?: string | null;
  familyName?: string | null;
  title?: string | null;
  primarySpecialtyId?: string | null;
  professionalEmail?: string | null;
  professionalPhone?: string | null;
  preferredLanguage?: string | null;
  notes?: string | null;
  status?: Hcp['status'];
  source?: string;
  sourceVersion?: string | null;
  sourceRef?: string | null;
  jurisdiction?: string;
  confidence?: number | null;
  verificationStatus?: VerificationStatus;
  verifiedBy?: string | null;
  lastVerifiedAt?: string | null;
  mergedIntoHcpId?: string | null;
  professionalCategory?: string;
  sourceDate?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  verificationExpiresAt?: string | null;
  verificationNote?: string | null;
}

const HCP_COLUMN_BY_FIELD: Record<keyof HcpUpdateFields, string> = {
  fullName: 'full_name',
  givenName: 'given_name',
  familyName: 'family_name',
  title: 'title',
  primarySpecialtyId: 'primary_specialty_id',
  professionalEmail: 'professional_email',
  professionalPhone: 'professional_phone',
  preferredLanguage: 'preferred_language',
  notes: 'notes',
  status: 'status',
  source: 'source',
  sourceVersion: 'source_version',
  sourceRef: 'source_ref',
  jurisdiction: 'jurisdiction',
  confidence: 'confidence',
  verificationStatus: 'verification_status',
  verifiedBy: 'verified_by',
  lastVerifiedAt: 'last_verified_at',
  mergedIntoHcpId: 'merged_into_hcp_id',
  professionalCategory: 'professional_category',
  sourceDate: 'source_date',
  effectiveFrom: 'effective_from',
  effectiveTo: 'effective_to',
  verificationExpiresAt: 'verification_expires_at',
  verificationNote: 'verification_note',
};

/**
 * Apply a partial update and bump `record_version`. Column names come from a
 * fixed map, never from caller input, so this cannot be turned into injection.
 */
export async function updateHcp(
  client: PoolClient,
  clinicId: string,
  id: string,
  fields: HcpUpdateFields,
): Promise<Hcp> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const column = HCP_COLUMN_BY_FIELD[field as keyof HcpUpdateFields];
    if (!column || value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }
  assignments.push('record_version = record_version + 1', 'updated_at = now()');
  values.push(id, clinicId);
  const { rows } = await client.query<HcpRow>(
    `WITH updated AS (
       UPDATE hcp SET ${assignments.join(', ')}
        WHERE id = $${values.length - 1} AND clinic_id = $${values.length}
        RETURNING *
     )
     SELECT ${SELECT_HCP_COLUMNS} FROM updated h`,
    values,
  );
  return mapHcp(rows[0]!);
}

/** Field names that actually changed, for the revision log. */
export function changedFieldNames(before: Hcp, fields: HcpUpdateFields): string[] {
  const current: Record<string, unknown> = {
    fullName: before.fullName,
    givenName: before.givenName,
    familyName: before.familyName,
    title: before.title,
    primarySpecialtyId: before.primarySpecialtyId,
    professionalEmail: before.professionalEmail,
    professionalPhone: before.professionalPhone,
    preferredLanguage: before.preferredLanguage,
    notes: before.notes,
    status: before.status,
    source: before.provenance.source,
    sourceVersion: before.provenance.sourceVersion,
    sourceRef: before.provenance.sourceRef,
    jurisdiction: before.provenance.jurisdiction,
    confidence: before.provenance.confidence,
    verificationStatus: before.provenance.verificationStatus,
    lastVerifiedAt: before.provenance.lastVerifiedAt,
    mergedIntoHcpId: before.mergedIntoHcpId,
    professionalCategory: before.professionalCategory,
    sourceDate: before.provenance.sourceDate,
    effectiveFrom: before.effectiveFrom,
    effectiveTo: before.effectiveTo,
    verificationExpiresAt: before.verificationExpiresAt,
    verificationNote: before.verificationNote,
  };
  return Object.entries(fields)
    .filter(([field, value]) => value !== undefined && current[field] !== value)
    .map(([field]) => field);
}

// --- Revision history (append-only) ----------------------------------------

export interface InsertRevisionInput {
  clinicId: string;
  hcpId: string;
  recordVersion: number;
  changeType: HcpRevision['changeType'];
  changedFields: string[];
  snapshot: Hcp;
  source: string;
  changedBy: string;
}

export async function insertHcpRevision(
  client: PoolClient,
  input: InsertRevisionInput,
): Promise<void> {
  await client.query(
    `INSERT INTO hcp_revision
       (clinic_id, hcp_id, record_version, change_type, changed_fields, snapshot, source, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.clinicId,
      input.hcpId,
      input.recordVersion,
      input.changeType,
      input.changedFields,
      JSON.stringify(input.snapshot),
      input.source,
      input.changedBy,
    ],
  );
}

export async function listHcpRevisions(clinicId: string, hcpId: string): Promise<HcpRevision[]> {
  const { rows } = await getPool().query<{
    record_version: number;
    change_type: HcpRevision['changeType'];
    changed_fields: string[];
    source: string;
    changed_by: string | null;
    changed_at: string;
  }>(
    `SELECT record_version, change_type, changed_fields, source, changed_by, changed_at
       FROM hcp_revision
      WHERE clinic_id = $1 AND hcp_id = $2
      ORDER BY record_version`,
    [clinicId, hcpId],
  );
  return rows.map((r) => ({
    recordVersion: r.record_version,
    changeType: r.change_type,
    changedFields: r.changed_fields,
    source: r.source,
    changedBy: r.changed_by,
    changedAt: r.changed_at,
  }));
}

// --- Identifiers ------------------------------------------------------------

export interface InsertIdentifierInput {
  clinicId: string;
  hcpId: string;
  identifierSystem: string;
  identifierValue: string;
  issuingJurisdiction: string;
  validFrom: string | null;
  validTo: string | null;
  source: string;
  sourceVersion: string | null;
}

export async function insertHcpIdentifier(
  runner: Runner,
  input: InsertIdentifierInput,
): Promise<HcpIdentifier> {
  const { rows } = await runner.query<{
    id: string;
    hcp_id: string;
    identifier_system: string;
    identifier_value: string;
    issuing_jurisdiction: string;
    valid_from: string | null;
    valid_to: string | null;
    source: string;
    source_version: string | null;
    verification_status: VerificationStatus;
    last_verified_at: string | null;
  }>(
    `INSERT INTO hcp_identifier
       (clinic_id, hcp_id, identifier_system, identifier_value, issuing_jurisdiction,
        valid_from, valid_to, source, source_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      input.clinicId,
      input.hcpId,
      input.identifierSystem,
      input.identifierValue,
      input.issuingJurisdiction,
      input.validFrom,
      input.validTo,
      input.source,
      input.sourceVersion,
    ],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    hcpId: row.hcp_id,
    identifierSystem: row.identifier_system,
    identifierValue: row.identifier_value,
    issuingJurisdiction: row.issuing_jurisdiction,
    validFrom: toDateString(row.valid_from),
    validTo: toDateString(row.valid_to),
    source: row.source,
    sourceVersion: row.source_version,
    verificationStatus: row.verification_status,
    lastVerifiedAt: row.last_verified_at,
  };
}

export async function listHcpIdentifiers(
  clinicId: string,
  hcpId: string,
): Promise<HcpIdentifier[]> {
  const { rows } = await getPool().query<{
    id: string;
    hcp_id: string;
    identifier_system: string;
    identifier_value: string;
    issuing_jurisdiction: string;
    valid_from: string | null;
    valid_to: string | null;
    source: string;
    source_version: string | null;
    verification_status: VerificationStatus;
    last_verified_at: string | null;
  }>(
    `SELECT * FROM hcp_identifier WHERE clinic_id = $1 AND hcp_id = $2
      ORDER BY identifier_system`,
    [clinicId, hcpId],
  );
  return rows.map((row) => ({
    id: row.id,
    hcpId: row.hcp_id,
    identifierSystem: row.identifier_system,
    identifierValue: row.identifier_value,
    issuingJurisdiction: row.issuing_jurisdiction,
    validFrom: toDateString(row.valid_from),
    validTo: toDateString(row.valid_to),
    source: row.source,
    sourceVersion: row.source_version,
    verificationStatus: row.verification_status,
    lastVerifiedAt: row.last_verified_at,
  }));
}

// --- Specialties, locations, affiliations, interests ------------------------

export async function linkHcpSpecialty(
  runner: Runner,
  input: {
    clinicId: string;
    hcpId: string;
    specialtyId: string;
    isPrimary: boolean;
    source: string;
    confidence: number | null;
  },
): Promise<void> {
  await runner.query(
    `INSERT INTO hcp_specialty (clinic_id, hcp_id, specialty_id, is_primary, source, confidence)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (hcp_id, specialty_id)
       DO UPDATE SET is_primary = EXCLUDED.is_primary,
                     source = EXCLUDED.source,
                     confidence = EXCLUDED.confidence`,
    [input.clinicId, input.hcpId, input.specialtyId, input.isPrimary, input.source, input.confidence],
  );
}

export async function listHcpSpecialties(
  clinicId: string,
  hcpId: string,
): Promise<HcpSpecialtyLink[]> {
  const { rows } = await getPool().query<{
    specialty_id: string;
    code: string;
    display_name: string;
    taxonomy: string;
    is_primary: boolean;
    source: string;
    confidence: string | null;
    is_subspecialty: boolean;
  }>(
    `SELECT hs.specialty_id, s.code, s.display_name, s.taxonomy, hs.is_primary,
            hs.source, hs.confidence, (s.parent_id IS NOT NULL) AS is_subspecialty
       FROM hcp_specialty hs
       JOIN specialty s ON s.id = hs.specialty_id
      WHERE hs.clinic_id = $1 AND hs.hcp_id = $2
      ORDER BY hs.is_primary DESC, s.display_name`,
    [clinicId, hcpId],
  );
  return rows.map((r) => ({
    specialtyId: r.specialty_id,
    code: r.code,
    displayName: r.display_name,
    taxonomy: r.taxonomy,
    // A specialty with a parent in the taxonomy IS a subspecialty; there is no
    // separate flag to drift out of step with the hierarchy.
    isSubspecialty: r.is_subspecialty,
    isPrimary: r.is_primary,
    source: r.source,
    confidence: numericToNumber(r.confidence),
  }));
}

// --- Credentials (migration 0306) -------------------------------------------

interface CredentialRow {
  id: string;
  hcp_id: string;
  credential_type: HcpCredential['credentialType'];
  credential_code: string | null;
  credential_name: string;
  issuing_body: string | null;
  issuing_jurisdiction: string | null;
  awarded_on: Date | string | null;
  valid_from: Date | string | null;
  valid_to: Date | string | null;
  source: string;
  source_date: Date | string | null;
  verification_status: VerificationStatus;
  last_verified_at: string | null;
  confidence: string | null;
}

function mapCredential(row: CredentialRow): HcpCredential {
  return {
    id: row.id,
    hcpId: row.hcp_id,
    credentialType: row.credential_type,
    credentialCode: row.credential_code,
    credentialName: row.credential_name,
    issuingBody: row.issuing_body,
    issuingJurisdiction: row.issuing_jurisdiction,
    awardedOn: toDateString(row.awarded_on),
    validFrom: toDateString(row.valid_from),
    validTo: toDateString(row.valid_to),
    source: row.source,
    sourceDate: toDateString(row.source_date),
    verificationStatus: row.verification_status,
    lastVerifiedAt: row.last_verified_at,
    confidence: numericToNumber(row.confidence),
  };
}

export async function insertCredential(
  runner: Runner,
  input: {
    clinicId: string;
    hcpId: string;
    credentialType: HcpCredential['credentialType'];
    credentialCode: string | null;
    credentialName: string;
    issuingBody: string | null;
    issuingJurisdiction: string | null;
    awardedOn: string | null;
    validFrom: string | null;
    validTo: string | null;
    source: string;
    sourceVersion: string | null;
    sourceDate: string | null;
  },
): Promise<HcpCredential> {
  const { rows } = await runner.query<CredentialRow>(
    `INSERT INTO hcp_credential
       (clinic_id, hcp_id, credential_type, credential_code, credential_name, issuing_body,
        issuing_jurisdiction, awarded_on, valid_from, valid_to, source, source_version, source_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      input.clinicId,
      input.hcpId,
      input.credentialType,
      input.credentialCode,
      input.credentialName,
      input.issuingBody,
      input.issuingJurisdiction,
      input.awardedOn,
      input.validFrom,
      input.validTo,
      input.source,
      input.sourceVersion,
      input.sourceDate,
    ],
  );
  return mapCredential(rows[0]!);
}

export async function listCredentials(
  clinicId: string,
  hcpId: string,
): Promise<HcpCredential[]> {
  const { rows } = await getPool().query<CredentialRow>(
    `SELECT * FROM hcp_credential WHERE clinic_id = $1 AND hcp_id = $2
      ORDER BY credential_type, credential_name`,
    [clinicId, hcpId],
  );
  return rows.map(mapCredential);
}

// --- Attribute provenance + verification expiry sweep (migration 0306) ------

/**
 * Resolve, per attribute, the revision that last set it.
 *
 * This is derived from the append-only revision history rather than stored
 * alongside each column: history is already the source of truth for "what
 * changed, from which source, by whom", so a parallel per-attribute table would
 * be a second truth to keep in step.
 */
export async function attributeProvenance(
  clinicId: string,
  hcpId: string,
): Promise<AttributeProvenance[]> {
  const { rows } = await getPool().query<{
    attribute: string;
    source: string;
    record_version: number;
    changed_at: string;
    changed_by: string | null;
    change_type: string;
  }>(
    `SELECT DISTINCT ON (attribute)
            attribute, source, record_version, changed_at, changed_by, change_type
       FROM (
         SELECT unnest(
                  CASE WHEN r.change_type = 'create'
                       THEN ARRAY['(record created)']
                       ELSE r.changed_fields END
                ) AS attribute,
                r.source, r.record_version, r.changed_at, r.changed_by, r.change_type
           FROM hcp_revision r
          WHERE r.clinic_id = $1 AND r.hcp_id = $2
       ) AS flattened
      ORDER BY attribute, record_version DESC`,
    [clinicId, hcpId],
  );
  return rows.map((r) => ({
    attribute: r.attribute,
    source: r.source,
    recordVersion: r.record_version,
    changedAt: r.changed_at,
    changedBy: r.changed_by,
    changeType: r.change_type,
  }));
}

/** Verified records whose verification has lapsed, locked for the sweep. */
export async function lapsedVerifications(
  client: PoolClient,
  clinicId: string,
  limit: number,
): Promise<Hcp[]> {
  const { rows } = await client.query<HcpRow>(
    `SELECT ${SELECT_HCP_COLUMNS} FROM hcp h
      WHERE h.clinic_id = $1
        AND h.verification_status = 'verified'
        AND h.verification_expires_at IS NOT NULL
        AND h.verification_expires_at < now()
      ORDER BY h.verification_expires_at
      LIMIT $2
      FOR UPDATE`,
    [clinicId, limit],
  );
  return rows.map(mapHcp);
}

export interface InsertPracticeLocationInput {
  clinicId: string;
  hcpId: string;
  hcoId: string | null;
  label: string | null;
  addressLine: string | null;
  city: string | null;
  region: string | null;
  country: string;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  visitingHours: Record<string, unknown>;
  isPrimary: boolean;
  source: string;
  sourceVersion: string | null;
}

export async function insertPracticeLocation(
  runner: Runner,
  input: InsertPracticeLocationInput,
): Promise<PracticeLocation> {
  const { rows } = await runner.query<{
    id: string;
    hcp_id: string;
    hco_id: string | null;
    label: string | null;
    address_line: string | null;
    city: string | null;
    region: string | null;
    country: string;
    postal_code: string | null;
    latitude: string | null;
    longitude: string | null;
    visiting_hours: Record<string, unknown>;
    is_primary: boolean;
    territory_id: string | null;
    source: string;
    verification_status: VerificationStatus;
    last_verified_at: string | null;
  }>(
    `INSERT INTO hcp_practice_location
       (clinic_id, hcp_id, hco_id, label, address_line, city, region, country, postal_code,
        latitude, longitude, visiting_hours, is_primary, source, source_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      input.clinicId,
      input.hcpId,
      input.hcoId,
      input.label,
      input.addressLine,
      input.city,
      input.region,
      input.country,
      input.postalCode,
      input.latitude,
      input.longitude,
      JSON.stringify(input.visitingHours),
      input.isPrimary,
      input.source,
      input.sourceVersion,
    ],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    hcpId: row.hcp_id,
    hcoId: row.hco_id,
    label: row.label,
    addressLine: row.address_line,
    city: row.city,
    region: row.region,
    country: row.country,
    postalCode: row.postal_code,
    latitude: numericToNumber(row.latitude),
    longitude: numericToNumber(row.longitude),
    visitingHours: row.visiting_hours,
    isPrimary: row.is_primary,
    territoryId: row.territory_id,
    source: row.source,
    verificationStatus: row.verification_status,
    lastVerifiedAt: row.last_verified_at,
  };
}

export async function listPracticeLocations(
  clinicId: string,
  hcpId: string,
): Promise<PracticeLocation[]> {
  const { rows } = await getPool().query<{
    id: string;
    hcp_id: string;
    hco_id: string | null;
    label: string | null;
    address_line: string | null;
    city: string | null;
    region: string | null;
    country: string;
    postal_code: string | null;
    latitude: string | null;
    longitude: string | null;
    visiting_hours: Record<string, unknown>;
    is_primary: boolean;
    territory_id: string | null;
    source: string;
    verification_status: VerificationStatus;
    last_verified_at: string | null;
  }>(
    `SELECT * FROM hcp_practice_location WHERE clinic_id = $1 AND hcp_id = $2
      ORDER BY is_primary DESC, label NULLS LAST`,
    [clinicId, hcpId],
  );
  return rows.map((row) => ({
    id: row.id,
    hcpId: row.hcp_id,
    hcoId: row.hco_id,
    label: row.label,
    addressLine: row.address_line,
    city: row.city,
    region: row.region,
    country: row.country,
    postalCode: row.postal_code,
    latitude: numericToNumber(row.latitude),
    longitude: numericToNumber(row.longitude),
    visitingHours: row.visiting_hours,
    isPrimary: row.is_primary,
    territoryId: row.territory_id,
    source: row.source,
    verificationStatus: row.verification_status,
    lastVerifiedAt: row.last_verified_at,
  }));
}

export interface InsertAffiliationInput {
  clinicId: string;
  hcpId: string;
  hcoId: string;
  /** The governed department link from 0308; null when only legacy text is known. */
  hcoDepartmentId: string | null;
  department: string | null;
  roleTitle: string | null;
  affiliationType: HcpAffiliation['affiliationType'];
  startDate: string | null;
  endDate: string | null;
  source: string;
  sourceVersion: string | null;
  confidence: number | null;
}

export async function insertAffiliation(
  runner: Runner,
  input: InsertAffiliationInput,
): Promise<HcpAffiliation> {
  const { rows } = await runner.query<{
    id: string;
    hcp_id: string;
    hco_id: string;
    hco_department_id: string | null;
    department: string | null;
    role_title: string | null;
    affiliation_type: HcpAffiliation['affiliationType'];
    start_date: string | null;
    end_date: string | null;
    source: string;
    verification_status: VerificationStatus;
    last_verified_at: string | null;
    confidence: string | null;
  }>(
    `INSERT INTO hcp_hco_affiliation
       (clinic_id, hcp_id, hco_id, hco_department_id, department, role_title, affiliation_type,
        start_date, end_date, source, source_version, confidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      input.clinicId,
      input.hcpId,
      input.hcoId,
      input.hcoDepartmentId,
      input.department,
      input.roleTitle,
      input.affiliationType,
      input.startDate,
      input.endDate,
      input.source,
      input.sourceVersion,
      input.confidence,
    ],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    hcpId: row.hcp_id,
    hcoId: row.hco_id,
    hcoName: null,
    hcoDepartmentId: row.hco_department_id,
    department: row.department,
    roleTitle: row.role_title,
    affiliationType: row.affiliation_type,
    startDate: toDateString(row.start_date),
    endDate: toDateString(row.end_date),
    source: row.source,
    verificationStatus: row.verification_status,
    lastVerifiedAt: row.last_verified_at,
    confidence: numericToNumber(row.confidence),
  };
}

export async function listAffiliations(
  clinicId: string,
  hcpId: string,
): Promise<HcpAffiliation[]> {
  const { rows } = await getPool().query<{
    id: string;
    hcp_id: string;
    hco_id: string;
    hco_name: string;
    hco_department_id: string | null;
    department_name: string | null;
    department: string | null;
    role_title: string | null;
    affiliation_type: HcpAffiliation['affiliationType'];
    start_date: string | null;
    end_date: string | null;
    source: string;
    verification_status: VerificationStatus;
    last_verified_at: string | null;
    confidence: string | null;
  }>(
    `SELECT a.*, o.name AS hco_name, d.name AS department_name
       FROM hcp_hco_affiliation a
       JOIN hco o ON o.id = a.hco_id
       LEFT JOIN hco_department d ON d.id = a.hco_department_id
      WHERE a.clinic_id = $1 AND a.hcp_id = $2
      ORDER BY (a.end_date IS NULL) DESC, a.start_date DESC NULLS LAST`,
    [clinicId, hcpId],
  );
  return rows.map((row) => ({
    id: row.id,
    hcpId: row.hcp_id,
    hcoId: row.hco_id,
    hcoName: row.hco_name,
    hcoDepartmentId: row.hco_department_id,
    // The governed name when the affiliation is linked, the legacy text otherwise.
    department: row.department_name ?? row.department,
    roleTitle: row.role_title,
    affiliationType: row.affiliation_type,
    startDate: toDateString(row.start_date),
    endDate: toDateString(row.end_date),
    source: row.source,
    verificationStatus: row.verification_status,
    lastVerifiedAt: row.last_verified_at,
    confidence: numericToNumber(row.confidence),
  }));
}

export async function insertInterest(
  runner: Runner,
  input: {
    clinicId: string;
    hcpId: string;
    interest: string;
    interestType: ProfessionalInterest['interestType'];
    strength: ProfessionalInterest['strength'];
    source: string;
    confidence: number | null;
  },
): Promise<void> {
  await runner.query(
    `INSERT INTO hcp_professional_interest
       (clinic_id, hcp_id, interest, interest_type, strength, source, confidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (clinic_id, hcp_id, lower(interest))
       DO UPDATE SET interest_type = EXCLUDED.interest_type,
                     strength = EXCLUDED.strength,
                     source = EXCLUDED.source,
                     confidence = EXCLUDED.confidence`,
    [
      input.clinicId,
      input.hcpId,
      input.interest,
      input.interestType,
      input.strength,
      input.source,
      input.confidence,
    ],
  );
}

export async function listInterests(
  clinicId: string,
  hcpId: string,
): Promise<ProfessionalInterest[]> {
  const { rows } = await getPool().query<{
    id: string;
    hcp_id: string;
    interest: string;
    interest_type: ProfessionalInterest['interestType'];
    strength: ProfessionalInterest['strength'];
    source: string;
    confidence: string | null;
  }>(
    `SELECT * FROM hcp_professional_interest WHERE clinic_id = $1 AND hcp_id = $2
      ORDER BY strength DESC, interest`,
    [clinicId, hcpId],
  );
  return rows.map((r) => ({
    id: r.id,
    hcpId: r.hcp_id,
    interest: r.interest,
    interestType: r.interest_type,
    strength: r.strength,
    source: r.source,
    confidence: numericToNumber(r.confidence),
  }));
}
