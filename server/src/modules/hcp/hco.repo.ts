import { getPool, type PoolClient } from '../../db/pool.js';
import { ConflictError } from '../../domain/errors.js';
import { toDateString } from '../pharma/dates.js';
import {
  mapProvenance,
  numericToNumber,
  type ProvenanceRow,
  type VerificationStatus,
} from '../pharma/provenance.js';
import type {
  AffiliatedHcp,
  Hco,
  HcoComponentRevision,
  HcoDepartment,
  HcoIdentifier,
  HcoLocation,
  HcoRevision,
  OperatingStatus,
  SpecialtyCoverage,
} from './hco.types.js';

type Runner = Pick<PoolClient, 'query'>;

/**
 * HCO master-data repository (migrations 0300 / 0307 / 0308).
 *
 * GOVERNANCE: every statement here touches only organisation master tables and
 * the pharma engagement tables. No query may reference `patient`, `encounter`
 * or any clinical table — an organisation is a commercial counterparty, never a
 * join point into care records (§45). `test/integration/pharma-firewall.test.ts`
 * asserts that statically over every file reachable from the pharma feature.
 */

/**
 * Every HCO read goes through this list rather than `SELECT *`, so the derived
 * verification status is computed consistently and cannot be forgotten by a new
 * query. `o` is the required alias for the `hco` table.
 *
 * The function is the SAME `pharma_effective_verification` the HCP master uses
 * (0306), so the two masters can never disagree about what "expired" means.
 */
const SELECT_HCO_COLUMNS = `o.*,
         pharma_effective_verification(o.verification_status, o.verification_expires_at)
           AS effective_verification_status`;

/** The same expression for a WHERE clause, so filters agree with reads. */
export const EFFECTIVE_HCO_VERIFICATION =
  'pharma_effective_verification(o.verification_status, o.verification_expires_at)';

// --- row shapes -------------------------------------------------------------

interface HcoRow extends ProvenanceRow {
  id: string;
  clinic_id: string;
  name: string;
  hco_type: Hco['hcoType'];
  parent_hco_id: string | null;
  ownership_type: Hco['ownershipType'];
  operating_status: OperatingStatus;
  merged_into_hco_id: string | null;
  country: string;
  region: string | null;
  city: string | null;
  address_line: string | null;
  postal_code: string | null;
  source_date: Date | string | null;
  effective_from: Date | string | null;
  effective_to: Date | string | null;
  verification_expires_at: string | null;
  verification_note: string | null;
  /** Computed by `pharma_effective_verification` — see SELECT_HCO_COLUMNS. */
  effective_verification_status: VerificationStatus;
  record_version: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * A merged organisation is CLOSED to new state.
 *
 * The HCP side had this rule on exactly one path (`updateHcp`) and the HCO side
 * had it on none: a resolved-away organisation could still be renamed,
 * re-verified, and given new sites, departments and identifiers — none of which
 * the survivor would ever show. Merging only means something if the losing
 * record stops being used.
 */
export function assertHcoOpen(hco: Hco): void {
  if (hco.operatingStatus === 'merged') {
    throw new ConflictError(
      'This organisation was merged; act on the surviving record instead',
      { mergedIntoHcoId: hco.mergedIntoHcoId },
    );
  }
}

export function mapHco(row: HcoRow): Hco {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    name: row.name,
    hcoType: row.hco_type,
    parentHcoId: row.parent_hco_id,
    ownershipType: row.ownership_type,
    operatingStatus: row.operating_status,
    mergedIntoHcoId: row.merged_into_hco_id,
    country: row.country,
    region: row.region,
    city: row.city,
    addressLine: row.address_line,
    postalCode: row.postal_code,
    provenance: {
      ...mapProvenance(row),
      sourceDate: toDateString(row.source_date),
      // Expiry is DERIVED: a lapsed verification reads as `expired` even if no
      // sweep has run, so a missed background job can never leave a stale
      // "verified" on screen.
      verificationStatus: row.effective_verification_status ?? row.verification_status,
    },
    effectiveFrom: toDateString(row.effective_from),
    effectiveTo: toDateString(row.effective_to),
    verificationExpiresAt: row.verification_expires_at,
    verificationNote: row.verification_note,
    recordVersion: row.record_version,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- organisation -----------------------------------------------------------

export interface InsertHcoInput {
  clinicId: string;
  name: string;
  hcoType: Hco['hcoType'];
  parentHcoId: string | null;
  ownershipType: Hco['ownershipType'];
  country: string;
  region: string | null;
  city: string | null;
  addressLine: string | null;
  postalCode: string | null;
  source: string;
  sourceVersion: string | null;
  sourceRef: string | null;
  sourceDate: string | null;
  jurisdiction: string;
  confidence: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdBy: string;
}

export async function insertHco(runner: Runner, input: InsertHcoInput): Promise<Hco> {
  const { rows } = await runner.query<HcoRow>(
    `WITH inserted AS (
       INSERT INTO hco
         (clinic_id, name, hco_type, parent_hco_id, ownership_type, country, region, city,
          address_line, postal_code, source, source_version, source_ref, source_date,
          jurisdiction, confidence, effective_from, effective_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *
     )
     SELECT ${SELECT_HCO_COLUMNS} FROM inserted o`,
    [
      input.clinicId,
      input.name,
      input.hcoType,
      input.parentHcoId,
      input.ownershipType,
      input.country,
      input.region,
      input.city,
      input.addressLine,
      input.postalCode,
      input.source,
      input.sourceVersion,
      input.sourceRef,
      input.sourceDate,
      input.jurisdiction,
      input.confidence,
      input.effectiveFrom,
      input.effectiveTo,
      input.createdBy,
    ],
  );
  return mapHco(rows[0]!);
}

export async function getHcoById(
  clinicId: string,
  id: string,
  runner: Runner = getPool(),
): Promise<Hco | null> {
  const { rows } = await runner.query<HcoRow>(
    `SELECT ${SELECT_HCO_COLUMNS} FROM hco o WHERE o.id = $1 AND o.clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapHco(rows[0]) : null;
}

/** Row-locking read used by every write path, so concurrent edits serialise. */
export async function getHcoForUpdate(
  runner: Runner,
  clinicId: string,
  id: string,
): Promise<Hco | null> {
  const { rows } = await runner.query<HcoRow>(
    `SELECT ${SELECT_HCO_COLUMNS} FROM hco o
      WHERE o.id = $1 AND o.clinic_id = $2
      FOR UPDATE`,
    [id, clinicId],
  );
  return rows[0] ? mapHco(rows[0]) : null;
}

export interface ListHcoFilter {
  q: string | null;
  hcoType: Hco['hcoType'] | null;
  ownershipType: Hco['ownershipType'] | null;
  operatingStatus: OperatingStatus | null;
  /** Filters on the DERIVED status, so it agrees with what a read returns. */
  verificationStatus: VerificationStatus | null;
  limit: number;
}

export async function listHcos(
  clinicId: string,
  filter: ListHcoFilter,
  runner: Runner = getPool(),
): Promise<Hco[]> {
  const { rows } = await runner.query<HcoRow>(
    `SELECT ${SELECT_HCO_COLUMNS}
       FROM hco o
      WHERE o.clinic_id = $1
        AND ($2::text IS NULL OR lower(o.name) LIKE '%' || lower($2) || '%')
        AND ($3::text IS NULL OR o.hco_type = $3)
        AND ($4::text IS NULL OR o.ownership_type = $4)
        AND ($5::text IS NULL OR o.operating_status = $5)
        AND ($6::text IS NULL OR ${EFFECTIVE_HCO_VERIFICATION} = $6)
      ORDER BY o.name
      LIMIT $7`,
    [
      clinicId,
      filter.q,
      filter.hcoType,
      filter.ownershipType,
      filter.operatingStatus,
      filter.verificationStatus,
      filter.limit,
    ],
  );
  return rows.map(mapHco);
}

/** Columns a caller may set through the update path. */
export type HcoUpdatableColumn =
  | 'name'
  | 'hco_type'
  | 'parent_hco_id'
  | 'ownership_type'
  | 'operating_status'
  | 'country'
  | 'region'
  | 'city'
  | 'address_line'
  | 'postal_code'
  | 'source'
  | 'source_version'
  | 'source_ref'
  | 'source_date'
  | 'jurisdiction'
  | 'confidence'
  | 'effective_from'
  | 'effective_to'
  | 'is_active';

export async function updateHcoColumns(
  runner: Runner,
  clinicId: string,
  id: string,
  patch: Partial<Record<HcoUpdatableColumn, unknown>>,
  nextVersion: number,
): Promise<Hco> {
  const columns = Object.keys(patch) as HcoUpdatableColumn[];
  const assignments = columns.map((column, i) => `${column} = $${i + 4}`);
  const { rows } = await runner.query<HcoRow>(
    `WITH updated AS (
       UPDATE hco
          SET ${[...assignments, 'record_version = $3', 'updated_at = now()'].join(', ')}
        WHERE id = $1 AND clinic_id = $2
        RETURNING *
     )
     SELECT ${SELECT_HCO_COLUMNS} FROM updated o`,
    [id, clinicId, nextVersion, ...columns.map((c) => patch[c])],
  );
  return mapHco(rows[0]!);
}

/** Apply a verification decision. Kept separate so it cannot be reached by a bulk patch. */
export async function applyHcoVerification(
  runner: Runner,
  clinicId: string,
  id: string,
  next: {
    status: VerificationStatus;
    note: string | null;
    verifiedBy: string | null;
    lastVerifiedAt: string | null;
    expiresAt: string | null;
    recordVersion: number;
  },
): Promise<Hco> {
  const { rows } = await runner.query<HcoRow>(
    `WITH updated AS (
       UPDATE hco
          SET verification_status = $3,
              verification_note = $4,
              verified_by = $5,
              last_verified_at = $6,
              verification_expires_at = $7,
              record_version = $8,
              updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING *
     )
     SELECT ${SELECT_HCO_COLUMNS} FROM updated o`,
    [
      id,
      clinicId,
      next.status,
      next.note,
      next.verifiedBy,
      next.lastVerifiedAt,
      next.expiresAt,
      next.recordVersion,
    ],
  );
  return mapHco(rows[0]!);
}

export async function markHcoMerged(
  runner: Runner,
  clinicId: string,
  id: string,
  survivorId: string,
  nextVersion: number,
): Promise<Hco> {
  const { rows } = await runner.query<HcoRow>(
    `WITH updated AS (
       UPDATE hco
          SET operating_status = 'merged',
              merged_into_hco_id = $3,
              is_active = false,
              record_version = $4,
              updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING *
     )
     SELECT ${SELECT_HCO_COLUMNS} FROM updated o`,
    [id, clinicId, survivorId, nextVersion],
  );
  return mapHco(rows[0]!);
}

/**
 * Organisations whose verification has lapsed but is still recorded as
 * `verified`. Reads the stored columns (not the STABLE function) so the partial
 * index from 0307 is usable.
 */
export async function expiredHcoVerifications(
  runner: Runner,
  clinicId: string,
  limit: number,
): Promise<Array<{ id: string; recordVersion: number }>> {
  const { rows } = await runner.query<{ id: string; record_version: number }>(
    `SELECT id, record_version
       FROM hco
      WHERE clinic_id = $1
        AND verification_status = 'verified'
        AND verification_expires_at IS NOT NULL
        AND verification_expires_at < now()
      ORDER BY verification_expires_at
      LIMIT $2
      FOR UPDATE`,
    [clinicId, limit],
  );
  return rows.map((r) => ({ id: r.id, recordVersion: r.record_version }));
}

// --- revision history -------------------------------------------------------

export interface InsertHcoRevisionInput {
  clinicId: string;
  hcoId: string;
  recordVersion: number;
  changeType: HcoRevision['changeType'];
  changedFields: string[];
  snapshot: unknown;
  source: string;
  changedBy: string | null;
}

export async function insertHcoRevision(
  runner: Runner,
  input: InsertHcoRevisionInput,
): Promise<void> {
  await runner.query(
    `INSERT INTO hco_revision
       (clinic_id, hco_id, record_version, change_type, changed_fields, snapshot, source, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.clinicId,
      input.hcoId,
      input.recordVersion,
      input.changeType,
      input.changedFields,
      JSON.stringify(input.snapshot),
      input.source,
      input.changedBy,
    ],
  );
}

export async function listHcoRevisions(
  clinicId: string,
  hcoId: string,
  runner: Runner = getPool(),
): Promise<HcoRevision[]> {
  const { rows } = await runner.query<{
    record_version: number;
    change_type: HcoRevision['changeType'];
    changed_fields: string[];
    source: string;
    changed_by: string | null;
    changed_at: string;
  }>(
    `SELECT record_version, change_type, changed_fields, source, changed_by, changed_at
       FROM hco_revision
      WHERE clinic_id = $1 AND hco_id = $2
      ORDER BY record_version DESC`,
    [clinicId, hcoId],
  );
  return rows.map((row) => ({
    recordVersion: row.record_version,
    changeType: row.change_type,
    changedFields: row.changed_fields,
    source: row.source,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  }));
}

// --- identifiers ------------------------------------------------------------

interface HcoIdentifierRow {
  id: string;
  hco_id: string;
  identifier_system: string;
  identifier_value: string;
  issuing_jurisdiction: string;
  valid_from: Date | string | null;
  valid_to: Date | string | null;
  source: string;
  source_version: string | null;
  source_date: Date | string | null;
  verification_status: VerificationStatus;
  last_verified_at: string | null;
}

function mapHcoIdentifier(row: HcoIdentifierRow): HcoIdentifier {
  return {
    id: row.id,
    hcoId: row.hco_id,
    identifierSystem: row.identifier_system,
    identifierValue: row.identifier_value,
    issuingJurisdiction: row.issuing_jurisdiction,
    validFrom: toDateString(row.valid_from),
    validTo: toDateString(row.valid_to),
    source: row.source,
    sourceVersion: row.source_version,
    sourceDate: toDateString(row.source_date),
    verificationStatus: row.verification_status,
    lastVerifiedAt: row.last_verified_at,
  };
}

export interface InsertHcoIdentifierInput {
  clinicId: string;
  hcoId: string;
  identifierSystem: string;
  identifierValue: string;
  issuingJurisdiction: string;
  validFrom: string | null;
  validTo: string | null;
  source: string;
  sourceVersion: string | null;
  sourceDate: string | null;
}

export async function insertHcoIdentifier(
  runner: Runner,
  input: InsertHcoIdentifierInput,
): Promise<HcoIdentifier> {
  const { rows } = await runner.query<HcoIdentifierRow>(
    `INSERT INTO hco_identifier
       (clinic_id, hco_id, identifier_system, identifier_value, issuing_jurisdiction,
        valid_from, valid_to, source, source_version, source_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      input.clinicId,
      input.hcoId,
      input.identifierSystem,
      input.identifierValue,
      input.issuingJurisdiction,
      input.validFrom,
      input.validTo,
      input.source,
      input.sourceVersion,
      input.sourceDate,
    ],
  );
  return mapHcoIdentifier(rows[0]!);
}

export async function listHcoIdentifiers(
  clinicId: string,
  hcoId: string,
  runner: Runner = getPool(),
): Promise<HcoIdentifier[]> {
  const { rows } = await runner.query<HcoIdentifierRow>(
    `SELECT * FROM hco_identifier
      WHERE clinic_id = $1 AND hco_id = $2
      ORDER BY identifier_system, identifier_value`,
    [clinicId, hcoId],
  );
  return rows.map(mapHcoIdentifier);
}

// --- locations --------------------------------------------------------------

interface HcoLocationRow extends ProvenanceRow {
  id: string;
  clinic_id: string;
  hco_id: string;
  label: string;
  address_line: string | null;
  city: string | null;
  region: string | null;
  country: string;
  postal_code: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  territory_id: string | null;
  is_primary: boolean;
  operating_status: OperatingStatus;
  source_date: Date | string | null;
  effective_from: Date | string | null;
  effective_to: Date | string | null;
  verification_expires_at: string | null;
  verification_note: string | null;
  effective_verification_status: VerificationStatus;
  record_version: number;
  created_at: string;
  updated_at: string;
}

const SELECT_LOCATION_COLUMNS = `l.*,
         pharma_effective_verification(l.verification_status, l.verification_expires_at)
           AS effective_verification_status`;

function mapHcoLocation(row: HcoLocationRow): HcoLocation {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    hcoId: row.hco_id,
    label: row.label,
    addressLine: row.address_line,
    city: row.city,
    region: row.region,
    country: row.country,
    postalCode: row.postal_code,
    latitude: numericToNumber(row.latitude),
    longitude: numericToNumber(row.longitude),
    territoryId: row.territory_id,
    isPrimary: row.is_primary,
    operatingStatus: row.operating_status,
    provenance: {
      ...mapProvenance(row),
      sourceDate: toDateString(row.source_date),
      verificationStatus: row.effective_verification_status ?? row.verification_status,
    },
    effectiveFrom: toDateString(row.effective_from),
    effectiveTo: toDateString(row.effective_to),
    verificationExpiresAt: row.verification_expires_at,
    verificationNote: row.verification_note,
    recordVersion: row.record_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertHcoLocationInput {
  clinicId: string;
  hcoId: string;
  label: string;
  addressLine: string | null;
  city: string | null;
  region: string | null;
  country: string;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  territoryId: string | null;
  isPrimary: boolean;
  source: string;
  sourceVersion: string | null;
  sourceRef: string | null;
  sourceDate: string | null;
  jurisdiction: string;
  confidence: number | null;
  createdBy: string;
}

export async function insertHcoLocation(
  runner: Runner,
  input: InsertHcoLocationInput,
): Promise<HcoLocation> {
  const { rows } = await runner.query<HcoLocationRow>(
    `WITH inserted AS (
       INSERT INTO hco_location
         (clinic_id, hco_id, label, address_line, city, region, country, postal_code,
          latitude, longitude, territory_id, is_primary, source, source_version, source_ref,
          source_date, jurisdiction, confidence, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *
     )
     SELECT ${SELECT_LOCATION_COLUMNS} FROM inserted l`,
    [
      input.clinicId,
      input.hcoId,
      input.label,
      input.addressLine,
      input.city,
      input.region,
      input.country,
      input.postalCode,
      input.latitude,
      input.longitude,
      input.territoryId,
      input.isPrimary,
      input.source,
      input.sourceVersion,
      input.sourceRef,
      input.sourceDate,
      input.jurisdiction,
      input.confidence,
      input.createdBy,
    ],
  );
  return mapHcoLocation(rows[0]!);
}

/** Demote the current primary site so the `uq_hco_location_primary` index holds. */
export async function clearPrimaryLocation(
  runner: Runner,
  clinicId: string,
  hcoId: string,
): Promise<void> {
  await runner.query(
    `UPDATE hco_location SET is_primary = false, updated_at = now()
      WHERE clinic_id = $1 AND hco_id = $2 AND is_primary`,
    [clinicId, hcoId],
  );
}

export async function listHcoLocations(
  clinicId: string,
  hcoId: string,
  runner: Runner = getPool(),
): Promise<HcoLocation[]> {
  const { rows } = await runner.query<HcoLocationRow>(
    `SELECT ${SELECT_LOCATION_COLUMNS}
       FROM hco_location l
      WHERE l.clinic_id = $1 AND l.hco_id = $2
      ORDER BY l.is_primary DESC, l.label`,
    [clinicId, hcoId],
  );
  return rows.map(mapHcoLocation);
}

export async function getHcoLocationById(
  clinicId: string,
  id: string,
  runner: Runner = getPool(),
): Promise<HcoLocation | null> {
  const { rows } = await runner.query<HcoLocationRow>(
    `SELECT ${SELECT_LOCATION_COLUMNS} FROM hco_location l
      WHERE l.id = $1 AND l.clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapHcoLocation(rows[0]) : null;
}

// --- departments ------------------------------------------------------------

interface HcoDepartmentRow extends ProvenanceRow {
  id: string;
  clinic_id: string;
  hco_id: string;
  hco_location_id: string | null;
  name: string;
  specialty_id: string | null;
  specialty_display_name: string | null;
  operating_status: OperatingStatus;
  source_date: Date | string | null;
  verification_expires_at: string | null;
  verification_note: string | null;
  effective_verification_status: VerificationStatus;
  record_version: number;
  created_at: string;
  updated_at: string;
}

const SELECT_DEPARTMENT_COLUMNS = `d.*,
         s.display_name AS specialty_display_name,
         pharma_effective_verification(d.verification_status, d.verification_expires_at)
           AS effective_verification_status`;

function mapHcoDepartment(row: HcoDepartmentRow): HcoDepartment {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    hcoId: row.hco_id,
    hcoLocationId: row.hco_location_id,
    name: row.name,
    specialtyId: row.specialty_id,
    specialtyDisplayName: row.specialty_display_name,
    operatingStatus: row.operating_status,
    provenance: {
      ...mapProvenance(row),
      sourceDate: toDateString(row.source_date),
      verificationStatus: row.effective_verification_status ?? row.verification_status,
    },
    verificationExpiresAt: row.verification_expires_at,
    verificationNote: row.verification_note,
    recordVersion: row.record_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertHcoDepartmentInput {
  clinicId: string;
  hcoId: string;
  hcoLocationId: string | null;
  name: string;
  specialtyId: string | null;
  source: string;
  sourceVersion: string | null;
  sourceRef: string | null;
  sourceDate: string | null;
  jurisdiction: string;
  confidence: number | null;
  createdBy: string;
}

export async function insertHcoDepartment(
  runner: Runner,
  input: InsertHcoDepartmentInput,
): Promise<HcoDepartment> {
  const { rows } = await runner.query<HcoDepartmentRow>(
    `WITH inserted AS (
       INSERT INTO hco_department
         (clinic_id, hco_id, hco_location_id, name, specialty_id, source, source_version,
          source_ref, source_date, jurisdiction, confidence, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *
     )
     SELECT ${SELECT_DEPARTMENT_COLUMNS}
       FROM inserted d
       LEFT JOIN specialty s ON s.id = d.specialty_id`,
    [
      input.clinicId,
      input.hcoId,
      input.hcoLocationId,
      input.name,
      input.specialtyId,
      input.source,
      input.sourceVersion,
      input.sourceRef,
      input.sourceDate,
      input.jurisdiction,
      input.confidence,
      input.createdBy,
    ],
  );
  return mapHcoDepartment(rows[0]!);
}

export async function listHcoDepartments(
  clinicId: string,
  hcoId: string,
  runner: Runner = getPool(),
): Promise<HcoDepartment[]> {
  const { rows } = await runner.query<HcoDepartmentRow>(
    `SELECT ${SELECT_DEPARTMENT_COLUMNS}
       FROM hco_department d
       LEFT JOIN specialty s ON s.id = d.specialty_id
      WHERE d.clinic_id = $1 AND d.hco_id = $2
      ORDER BY d.name`,
    [clinicId, hcoId],
  );
  return rows.map(mapHcoDepartment);
}

// --- HCO 360 read model -----------------------------------------------------

/**
 * HCPs affiliated to this organisation.
 *
 * `territoryIds` is the caller's territory scope: `null` means unrestricted,
 * and an array restricts the result to HCPs targeted in one of those
 * territories. An EMPTY array therefore yields nothing, which is the correct
 * answer for a representative with no live assignment — not "everything".
 */
export async function listAffiliatedHcps(
  clinicId: string,
  hcoId: string,
  territoryIds: string[] | null,
  runner: Runner = getPool(),
): Promise<AffiliatedHcp[]> {
  if (territoryIds !== null && territoryIds.length === 0) return [];
  const { rows } = await runner.query<{
    hcp_id: string;
    full_name: string;
    professional_category: string;
    specialty_id: string | null;
    specialty_display_name: string | null;
    affiliation_id: string;
    affiliation_type: string;
    role_title: string | null;
    department_id: string | null;
    department_name: string | null;
    legacy_department: string | null;
    start_date: Date | string | null;
    end_date: Date | string | null;
    verification_status: VerificationStatus;
  }>(
    `SELECT h.id AS hcp_id,
            h.full_name,
            h.professional_category,
            h.primary_specialty_id AS specialty_id,
            s.display_name AS specialty_display_name,
            a.id AS affiliation_id,
            a.affiliation_type,
            a.role_title,
            a.hco_department_id AS department_id,
            d.name AS department_name,
            a.department AS legacy_department,
            a.start_date,
            a.end_date,
            pharma_effective_verification(h.verification_status, h.verification_expires_at)
              AS verification_status
       FROM hcp_hco_affiliation a
       JOIN hcp h ON h.id = a.hcp_id AND h.clinic_id = a.clinic_id
       LEFT JOIN specialty s ON s.id = h.primary_specialty_id
       LEFT JOIN hco_department d ON d.id = a.hco_department_id
      WHERE a.clinic_id = $1
        AND a.hco_id = $2
        AND ($3::uuid[] IS NULL OR EXISTS (
              SELECT 1 FROM hcp_territory t
               WHERE t.clinic_id = a.clinic_id
                 AND t.hcp_id = h.id
                 AND t.territory_id = ANY($3)))
      ORDER BY h.full_name`,
    [clinicId, hcoId, territoryIds],
  );
  return rows.map((row) => ({
    hcpId: row.hcp_id,
    fullName: row.full_name,
    professionalCategory: row.professional_category,
    specialtyId: row.specialty_id,
    specialtyDisplayName: row.specialty_display_name,
    affiliationId: row.affiliation_id,
    affiliationType: row.affiliation_type,
    roleTitle: row.role_title,
    departmentId: row.department_id,
    departmentName: row.department_name,
    legacyDepartment: row.legacy_department,
    startDate: toDateString(row.start_date),
    endDate: toDateString(row.end_date),
    verificationStatus: row.verification_status,
  }));
}

/** Specialty coverage derived from CURRENTLY affiliated HCPs, under the same scope. */
export async function specialtyCoverage(
  clinicId: string,
  hcoId: string,
  territoryIds: string[] | null,
  runner: Runner = getPool(),
): Promise<SpecialtyCoverage[]> {
  if (territoryIds !== null && territoryIds.length === 0) return [];
  const { rows } = await runner.query<{
    specialty_id: string;
    code: string;
    display_name: string;
    hcp_count: string;
  }>(
    `SELECT s.id AS specialty_id, s.code, s.display_name, count(DISTINCT h.id)::text AS hcp_count
       FROM hcp_hco_affiliation a
       JOIN hcp h ON h.id = a.hcp_id AND h.clinic_id = a.clinic_id
       JOIN specialty s ON s.id = h.primary_specialty_id
      WHERE a.clinic_id = $1
        AND a.hco_id = $2
        AND (a.end_date IS NULL OR a.end_date >= current_date)
        AND ($3::uuid[] IS NULL OR EXISTS (
              SELECT 1 FROM hcp_territory t
               WHERE t.clinic_id = a.clinic_id
                 AND t.hcp_id = h.id
                 AND t.territory_id = ANY($3)))
      GROUP BY s.id, s.code, s.display_name
      ORDER BY count(DISTINCT h.id) DESC, s.display_name`,
    [clinicId, hcoId, territoryIds],
  );
  return rows.map((row) => ({
    specialtyId: row.specialty_id,
    code: row.code,
    displayName: row.display_name,
    hcpCount: Number(row.hcp_count),
  }));
}

/** Territories this organisation's sites sit in — the geography of the account. */
export async function territoriesForHco(
  clinicId: string,
  hcoId: string,
  runner: Runner = getPool(),
): Promise<Array<{ territoryId: string; name: string; locationCount: number }>> {
  const { rows } = await runner.query<{
    territory_id: string;
    name: string;
    location_count: string;
  }>(
    `SELECT t.id AS territory_id, t.name, count(l.id)::text AS location_count
       FROM hco_location l
       JOIN territory t ON t.id = l.territory_id AND t.clinic_id = l.clinic_id
      WHERE l.clinic_id = $1 AND l.hco_id = $2
      GROUP BY t.id, t.name
      ORDER BY t.name`,
    [clinicId, hcoId],
  );
  return rows.map((row) => ({
    territoryId: row.territory_id,
    name: row.name,
    locationCount: Number(row.location_count),
  }));
}

// --- site and department governance (migration 0313) -------------------------

/**
 * Locking reads for the two component entities.
 *
 * Both write paths (patch, verification decision) serialise on the row the way
 * the organisation's own do, so two stewards editing the same site cannot
 * interleave into a version number that skips.
 */
export async function getHcoLocationForUpdate(
  runner: Runner,
  clinicId: string,
  id: string,
): Promise<HcoLocation | null> {
  const { rows } = await runner.query<HcoLocationRow>(
    `SELECT ${SELECT_LOCATION_COLUMNS} FROM hco_location l
      WHERE l.id = $1 AND l.clinic_id = $2
      FOR UPDATE`,
    [id, clinicId],
  );
  return rows[0] ? mapHcoLocation(rows[0]) : null;
}

export async function getHcoDepartmentById(
  clinicId: string,
  id: string,
  runner: Runner = getPool(),
): Promise<HcoDepartment | null> {
  const { rows } = await runner.query<HcoDepartmentRow>(
    `SELECT ${SELECT_DEPARTMENT_COLUMNS}
       FROM hco_department d
       LEFT JOIN specialty s ON s.id = d.specialty_id
      WHERE d.id = $1 AND d.clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapHcoDepartment(rows[0]) : null;
}

export async function getHcoDepartmentForUpdate(
  runner: Runner,
  clinicId: string,
  id: string,
): Promise<HcoDepartment | null> {
  // The specialty join cannot carry FOR UPDATE, so the lock is taken on the
  // department alone and the display name resolved by a second read.
  const { rows } = await runner.query<{ id: string }>(
    `SELECT id FROM hco_department WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
    [id, clinicId],
  );
  if (!rows[0]) return null;
  return getHcoDepartmentById(clinicId, id, runner);
}

export type HcoLocationUpdatableColumn =
  | 'label'
  | 'address_line'
  | 'city'
  | 'region'
  | 'country'
  | 'postal_code'
  | 'latitude'
  | 'longitude'
  | 'territory_id'
  | 'operating_status'
  | 'source'
  | 'source_version'
  | 'source_ref'
  | 'source_date'
  | 'jurisdiction'
  | 'confidence';

export async function updateHcoLocationColumns(
  runner: Runner,
  clinicId: string,
  id: string,
  patch: Partial<Record<HcoLocationUpdatableColumn, unknown>>,
  nextVersion: number,
): Promise<HcoLocation> {
  const columns = Object.keys(patch) as HcoLocationUpdatableColumn[];
  const assignments = columns.map((column, i) => `${column} = $${i + 4}`);
  const { rows } = await runner.query<HcoLocationRow>(
    `WITH updated AS (
       UPDATE hco_location
          SET ${[...assignments, 'record_version = $3', 'updated_at = now()'].join(', ')}
        WHERE id = $1 AND clinic_id = $2
        RETURNING *
     )
     SELECT ${SELECT_LOCATION_COLUMNS} FROM updated l`,
    [id, clinicId, nextVersion, ...columns.map((c) => patch[c])],
  );
  return mapHcoLocation(rows[0]!);
}

export type HcoDepartmentUpdatableColumn =
  | 'name'
  | 'hco_location_id'
  | 'specialty_id'
  | 'operating_status'
  | 'source'
  | 'source_version'
  | 'source_ref'
  | 'source_date'
  | 'jurisdiction'
  | 'confidence';

export async function updateHcoDepartmentColumns(
  runner: Runner,
  clinicId: string,
  id: string,
  patch: Partial<Record<HcoDepartmentUpdatableColumn, unknown>>,
  nextVersion: number,
): Promise<HcoDepartment> {
  const columns = Object.keys(patch) as HcoDepartmentUpdatableColumn[];
  const assignments = columns.map((column, i) => `${column} = $${i + 4}`);
  await runner.query(
    `UPDATE hco_department
        SET ${[...assignments, 'record_version = $3', 'updated_at = now()'].join(', ')}
      WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId, nextVersion, ...columns.map((c) => patch[c])],
  );
  return (await getHcoDepartmentById(clinicId, id, runner))!;
}

/** A verification decision on a site. Separate from the patch path by design. */
export async function applyHcoLocationVerification(
  runner: Runner,
  clinicId: string,
  id: string,
  next: {
    status: VerificationStatus;
    note: string | null;
    verifiedBy: string | null;
    lastVerifiedAt: string | null;
    expiresAt: string | null;
    recordVersion: number;
  },
): Promise<HcoLocation> {
  const { rows } = await runner.query<HcoLocationRow>(
    `WITH updated AS (
       UPDATE hco_location
          SET verification_status = $3,
              verification_note = $4,
              verified_by = $5,
              last_verified_at = $6,
              verification_expires_at = $7,
              record_version = $8,
              updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING *
     )
     SELECT ${SELECT_LOCATION_COLUMNS} FROM updated l`,
    [
      id,
      clinicId,
      next.status,
      next.note,
      next.verifiedBy,
      next.lastVerifiedAt,
      next.expiresAt,
      next.recordVersion,
    ],
  );
  return mapHcoLocation(rows[0]!);
}

export async function applyHcoDepartmentVerification(
  runner: Runner,
  clinicId: string,
  id: string,
  next: {
    status: VerificationStatus;
    note: string | null;
    verifiedBy: string | null;
    lastVerifiedAt: string | null;
    expiresAt: string | null;
    recordVersion: number;
  },
): Promise<HcoDepartment> {
  await runner.query(
    `UPDATE hco_department
        SET verification_status = $3,
            verification_note = $4,
            verified_by = $5,
            last_verified_at = $6,
            verification_expires_at = $7,
            record_version = $8,
            updated_at = now()
      WHERE id = $1 AND clinic_id = $2`,
    [
      id,
      clinicId,
      next.status,
      next.note,
      next.verifiedBy,
      next.lastVerifiedAt,
      next.expiresAt,
      next.recordVersion,
    ],
  );
  return (await getHcoDepartmentById(clinicId, id, runner))!;
}

/** Which component table a revision belongs to. */
export type HcoComponent = 'location' | 'department';

const REVISION_TABLE: Record<HcoComponent, { table: string; column: string }> = {
  location: { table: 'hco_location_revision', column: 'hco_location_id' },
  department: { table: 'hco_department_revision', column: 'hco_department_id' },
};

export async function insertHcoComponentRevision(
  runner: Runner,
  component: HcoComponent,
  input: {
    clinicId: string;
    componentId: string;
    recordVersion: number;
    changeType: HcoComponentRevision['changeType'];
    changedFields: string[];
    snapshot: unknown;
    source: string;
    changedBy: string | null;
  },
): Promise<void> {
  // The table and column come from a closed map keyed by a union type, never
  // from caller input, so this interpolation cannot carry anything but one of
  // two literal names.
  const { table, column } = REVISION_TABLE[component];
  await runner.query(
    `INSERT INTO ${table}
       (clinic_id, ${column}, record_version, change_type, changed_fields, snapshot, source, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.clinicId,
      input.componentId,
      input.recordVersion,
      input.changeType,
      input.changedFields,
      JSON.stringify(input.snapshot),
      input.source,
      input.changedBy,
    ],
  );
}

export async function listHcoComponentRevisions(
  component: HcoComponent,
  clinicId: string,
  componentId: string,
  runner: Runner = getPool(),
): Promise<HcoComponentRevision[]> {
  const { table, column } = REVISION_TABLE[component];
  const { rows } = await runner.query<{
    record_version: number;
    change_type: HcoComponentRevision['changeType'];
    changed_fields: string[];
    source: string;
    changed_by: string | null;
    changed_at: string;
  }>(
    `SELECT record_version, change_type, changed_fields, source, changed_by, changed_at
       FROM ${table}
      WHERE clinic_id = $1 AND ${column} = $2
      ORDER BY record_version DESC`,
    [clinicId, componentId],
  );
  return rows.map((row) => ({
    recordVersion: row.record_version,
    changeType: row.change_type,
    changedFields: row.changed_fields,
    source: row.source,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  }));
}

/**
 * Sites or departments whose verification has lapsed but which still say
 * `verified`. Reads the stored columns so the 0313 partial indexes are usable.
 */
export async function expiredComponentVerifications(
  runner: Runner,
  component: HcoComponent,
  clinicId: string,
  limit: number,
): Promise<Array<{ id: string; recordVersion: number }>> {
  const table = component === 'location' ? 'hco_location' : 'hco_department';
  const { rows } = await runner.query<{ id: string; record_version: number }>(
    `SELECT id, record_version
       FROM ${table}
      WHERE clinic_id = $1
        AND verification_status = 'verified'
        AND verification_expires_at IS NOT NULL
        AND verification_expires_at < now()
      ORDER BY verification_expires_at
      LIMIT $2
      FOR UPDATE`,
    [clinicId, limit],
  );
  return rows.map((r) => ({ id: r.id, recordVersion: r.record_version }));
}
