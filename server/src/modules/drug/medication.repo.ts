import { getPool, type PoolClient } from '../../db/pool.js';
import { toDateString } from '../pharma/dates.js';
import type { VerificationStatus } from '../pharma/provenance.js';

type Runner = Pick<PoolClient, 'query'>;

export interface Medication {
  id: string;
  clinicId: string;
  genericName: string;
  atcCode: string | null;
  conceptType: 'molecule' | 'combination';
  therapeuticArea: string | null;
  source: string;
  sourceVersion: string | null;
  sourceRef: string | null;
  licenseBasis: string;
  jurisdiction: string;
  /**
   * The EFFECTIVE status: a lapsed attestation reads as `expired` even if no
   * sweep has run, so a missed background job can never leave a stale
   * "verified" on a regulated product.
   */
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
  verifiedBy: string | null;
  verificationExpiresAt: string | null;
  verificationNote: string | null;
  confidence: number | null;
  recordVersion: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MedicationIngredient {
  id: string;
  medicationId: string;
  ingredientName: string;
  strengthValue: number | null;
  strengthUnit: string | null;
  isActiveIngredient: boolean;
  source: string;
}

export interface MedicationProduct {
  id: string;
  medicationId: string;
  brandName: string;
  manufacturerId: string | null;
  manufacturerName: string | null;
  dosageForm: string;
  route: string;
  strengthText: string | null;
  packageDescription: string | null;
  packageSize: number | null;
  packageUnit: string | null;
  jurisdiction: string;
  regulatoryAuthority: string | null;
  regulatoryIdentifier: string | null;
  regulatoryStatus: 'approved' | 'pending' | 'withdrawn' | 'suspended' | 'unknown';
  approvalDate: string | null;
  withdrawalDate: string | null;
  source: string;
  sourceVersion: string | null;
  sourceRef: string | null;
  licenseBasis: string;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
  verifiedBy: string | null;
  verificationExpiresAt: string | null;
  verificationNote: string | null;
  isActive: boolean;
  createdAt: string;
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Every medication read goes through this list rather than `SELECT *`, so the
 * derived verification status is computed consistently and cannot be forgotten
 * by a new query. `m` is the required alias for the `medication` table.
 *
 * The function is the SAME `pharma_effective_verification` the HCP and HCO
 * masters use (0306), so the three masters can never disagree about what
 * "expired" means.
 */
const SELECT_MEDICATION_COLUMNS = `m.*,
         pharma_effective_verification(m.verification_status, m.verification_expires_at)
           AS effective_verification_status`;

interface MedicationRow {
  id: string;
  clinic_id: string;
  generic_name: string;
  atc_code: string | null;
  concept_type: Medication['conceptType'];
  therapeutic_area: string | null;
  source: string;
  source_version: string | null;
  source_ref: string | null;
  license_basis: string;
  jurisdiction: string;
  verification_status: VerificationStatus;
  /** Computed by `pharma_effective_verification` — see SELECT_MEDICATION_COLUMNS. */
  effective_verification_status: VerificationStatus;
  last_verified_at: string | null;
  verified_by: string | null;
  verification_expires_at: string | null;
  verification_note: string | null;
  confidence: string | null;
  record_version: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function mapMedication(row: MedicationRow): Medication {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    genericName: row.generic_name,
    atcCode: row.atc_code,
    conceptType: row.concept_type,
    therapeuticArea: row.therapeutic_area,
    source: row.source,
    sourceVersion: row.source_version,
    sourceRef: row.source_ref,
    licenseBasis: row.license_basis,
    jurisdiction: row.jurisdiction,
    verificationStatus: row.effective_verification_status ?? row.verification_status,
    lastVerifiedAt: row.last_verified_at,
    verifiedBy: row.verified_by ?? null,
    verificationExpiresAt: row.verification_expires_at ?? null,
    verificationNote: row.verification_note ?? null,
    confidence: toNumber(row.confidence),
    recordVersion: row.record_version,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertMedication(
  client: PoolClient,
  input: {
    clinicId: string;
    genericName: string;
    atcCode: string | null;
    conceptType: Medication['conceptType'];
    therapeuticArea: string | null;
    source: string;
    sourceVersion: string | null;
    sourceRef: string | null;
    licenseBasis: string;
    jurisdiction: string;
    confidence: number | null;
    createdBy: string;
  },
): Promise<Medication> {
  const { rows } = await client.query<MedicationRow>(
    `INSERT INTO medication
       (clinic_id, generic_name, atc_code, concept_type, therapeutic_area, source,
        source_version, source_ref, license_basis, jurisdiction, confidence, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      input.clinicId,
      input.genericName,
      input.atcCode,
      input.conceptType,
      input.therapeuticArea,
      input.source,
      input.sourceVersion,
      input.sourceRef,
      input.licenseBasis,
      input.jurisdiction,
      input.confidence,
      input.createdBy,
    ],
  );
  return mapMedication(rows[0]!);
}

export async function getMedicationById(
  clinicId: string,
  id: string,
  runner: Runner = getPool(),
): Promise<Medication | null> {
  const { rows } = await runner.query<MedicationRow>(
    `SELECT ${SELECT_MEDICATION_COLUMNS} FROM medication m WHERE m.id = $1 AND m.clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapMedication(rows[0]) : null;
}

export async function getMedicationForUpdate(
  client: PoolClient,
  clinicId: string,
  id: string,
): Promise<Medication | null> {
  const { rows } = await client.query<MedicationRow>(
    `SELECT ${SELECT_MEDICATION_COLUMNS} FROM medication m
      WHERE m.id = $1 AND m.clinic_id = $2 FOR UPDATE`,
    [id, clinicId],
  );
  return rows[0] ? mapMedication(rows[0]) : null;
}

export async function searchMedications(
  clinicId: string,
  filter: {
    q: string | null;
    jurisdiction: string | null;
    atcCode: string | null;
    limit: number;
    offset: number;
  },
): Promise<Medication[]> {
  const { rows } = await getPool().query<MedicationRow>(
    `SELECT DISTINCT ${SELECT_MEDICATION_COLUMNS} FROM medication m
       LEFT JOIN medication_product p ON p.medication_id = m.id
      WHERE m.clinic_id = $1
        AND ($2::text IS NULL
             OR lower(m.generic_name) LIKE '%' || lower($2) || '%'
             OR lower(p.brand_name) LIKE '%' || lower($2) || '%')
        AND ($3::text IS NULL OR m.jurisdiction = $3)
        AND ($4::text IS NULL OR m.atc_code = $4)
      ORDER BY m.generic_name
      LIMIT $5 OFFSET $6`,
    [clinicId, filter.q, filter.jurisdiction, filter.atcCode, filter.limit, filter.offset],
  );
  return rows.map(mapMedication);
}

export async function updateMedicationVerification(
  client: PoolClient,
  clinicId: string,
  id: string,
  input: {
    verificationStatus: VerificationStatus;
    lastVerifiedAt: string | null;
    confidence: number | null;
    verifiedBy: string | null;
    expiresAt: string | null;
    note: string | null;
  },
): Promise<Medication> {
  const { rows } = await client.query<MedicationRow>(
    `WITH updated AS (
       UPDATE medication
          SET verification_status = $3,
              last_verified_at = $4,
              confidence = coalesce($5, confidence),
              verified_by = $6,
              verification_expires_at = $7,
              verification_note = $8,
              record_version = record_version + 1,
              updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING *
     )
     SELECT ${SELECT_MEDICATION_COLUMNS} FROM updated m`,
    [
      id,
      clinicId,
      input.verificationStatus,
      input.lastVerifiedAt,
      input.confidence,
      input.verifiedBy,
      input.expiresAt,
      input.note,
    ],
  );
  return mapMedication(rows[0]!);
}

/**
 * Medications whose attestation has lapsed but which still say `verified`.
 * Reads the stored columns so the 0315 partial index is usable.
 */
export async function expiredMedicationVerifications(
  client: PoolClient,
  clinicId: string,
  limit: number,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM medication
      WHERE clinic_id = $1
        AND verification_status = 'verified'
        AND verification_expires_at IS NOT NULL
        AND verification_expires_at < now()
      ORDER BY verification_expires_at
      LIMIT $2
      FOR UPDATE`,
    [clinicId, limit],
  );
  return rows.map((r) => r.id);
}

export async function insertMedicationRevision(
  client: PoolClient,
  input: {
    clinicId: string;
    medicationId: string;
    recordVersion: number;
    changeType: string;
    changedFields: string[];
    snapshot: unknown;
    source: string;
    sourceVersion: string | null;
    /** NULL for a system-written revision, such as an automatic expiry. */
    changedBy: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO medication_revision
       (clinic_id, medication_id, record_version, change_type, changed_fields, snapshot,
        source, source_version, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.clinicId,
      input.medicationId,
      input.recordVersion,
      input.changeType,
      input.changedFields,
      JSON.stringify(input.snapshot),
      input.source,
      input.sourceVersion,
      input.changedBy,
    ],
  );
}

export async function insertIngredient(
  client: PoolClient,
  input: {
    clinicId: string;
    medicationId: string;
    ingredientName: string;
    strengthValue: number | null;
    strengthUnit: string | null;
    isActiveIngredient: boolean;
    source: string;
    sourceVersion: string | null;
  },
): Promise<MedicationIngredient> {
  const { rows } = await client.query<{
    id: string;
    medication_id: string;
    ingredient_name: string;
    strength_value: string | null;
    strength_unit: string | null;
    is_active_ingredient: boolean;
    source: string;
  }>(
    `INSERT INTO medication_ingredient
       (clinic_id, medication_id, ingredient_name, strength_value, strength_unit,
        is_active_ingredient, source, source_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      input.clinicId,
      input.medicationId,
      input.ingredientName,
      input.strengthValue,
      input.strengthUnit,
      input.isActiveIngredient,
      input.source,
      input.sourceVersion,
    ],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    medicationId: row.medication_id,
    ingredientName: row.ingredient_name,
    strengthValue: toNumber(row.strength_value),
    strengthUnit: row.strength_unit,
    isActiveIngredient: row.is_active_ingredient,
    source: row.source,
  };
}

export async function listIngredients(
  clinicId: string,
  medicationId: string,
): Promise<MedicationIngredient[]> {
  const { rows } = await getPool().query<{
    id: string;
    medication_id: string;
    ingredient_name: string;
    strength_value: string | null;
    strength_unit: string | null;
    is_active_ingredient: boolean;
    source: string;
  }>(
    `SELECT * FROM medication_ingredient WHERE clinic_id = $1 AND medication_id = $2
      ORDER BY is_active_ingredient DESC, ingredient_name`,
    [clinicId, medicationId],
  );
  return rows.map((r) => ({
    id: r.id,
    medicationId: r.medication_id,
    ingredientName: r.ingredient_name,
    strengthValue: toNumber(r.strength_value),
    strengthUnit: r.strength_unit,
    isActiveIngredient: r.is_active_ingredient,
    source: r.source,
  }));
}

interface ProductRow {
  id: string;
  medication_id: string;
  brand_name: string;
  manufacturer_id: string | null;
  manufacturer_name: string | null;
  dosage_form: string;
  route: string;
  strength_text: string | null;
  package_description: string | null;
  package_size: number | null;
  package_unit: string | null;
  jurisdiction: string;
  regulatory_authority: string | null;
  regulatory_identifier: string | null;
  regulatory_status: MedicationProduct['regulatoryStatus'];
  approval_date: Date | string | null;
  withdrawal_date: Date | string | null;
  source: string;
  source_version: string | null;
  source_ref: string | null;
  license_basis: string;
  verification_status: VerificationStatus;
  effective_verification_status: VerificationStatus;
  last_verified_at: string | null;
  verified_by: string | null;
  verification_expires_at: string | null;
  verification_note: string | null;
  is_active: boolean;
  created_at: string;
}

function mapProduct(row: ProductRow): MedicationProduct {
  return {
    id: row.id,
    medicationId: row.medication_id,
    brandName: row.brand_name,
    manufacturerId: row.manufacturer_id,
    manufacturerName: row.manufacturer_name ?? null,
    dosageForm: row.dosage_form,
    route: row.route,
    strengthText: row.strength_text,
    packageDescription: row.package_description,
    packageSize: row.package_size,
    packageUnit: row.package_unit,
    jurisdiction: row.jurisdiction,
    regulatoryAuthority: row.regulatory_authority,
    regulatoryIdentifier: row.regulatory_identifier,
    regulatoryStatus: row.regulatory_status,
    approvalDate: toDateString(row.approval_date),
    withdrawalDate: toDateString(row.withdrawal_date),
    source: row.source,
    sourceVersion: row.source_version,
    sourceRef: row.source_ref,
    licenseBasis: row.license_basis,
    // The EFFECTIVE status: a lapsed product attestation reads as `expired`
    // without a sweep, exactly as the medication and the two other masters do.
    verificationStatus: row.effective_verification_status ?? row.verification_status,
    lastVerifiedAt: row.last_verified_at,
    verifiedBy: row.verified_by ?? null,
    verificationExpiresAt: row.verification_expires_at ?? null,
    verificationNote: row.verification_note ?? null,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

/** Product reads derive the effective verification status; `p` is the alias. */
const PRODUCT_EFFECTIVE = `pharma_effective_verification(p.verification_status, p.verification_expires_at)`;

export async function insertProduct(
  client: PoolClient,
  input: {
    clinicId: string;
    medicationId: string;
    brandName: string;
    manufacturerId: string | null;
    dosageForm: string;
    route: string;
    strengthText: string | null;
    packageDescription: string | null;
    packageSize: number | null;
    packageUnit: string | null;
    jurisdiction: string;
    regulatoryAuthority: string | null;
    regulatoryIdentifier: string | null;
    regulatoryStatus: MedicationProduct['regulatoryStatus'];
    approvalDate: string | null;
    withdrawalDate: string | null;
    source: string;
    sourceVersion: string | null;
    sourceRef: string | null;
    licenseBasis: string;
    createdBy: string;
  },
): Promise<MedicationProduct> {
  // The manufacturer name is resolved in the same statement so a freshly created
  // product is shaped exactly like one read back through `listProducts`.
  const { rows } = await client.query<ProductRow>(
    `WITH inserted AS (
       INSERT INTO medication_product
         (clinic_id, medication_id, brand_name, manufacturer_id, dosage_form, route, strength_text,
          package_description, package_size, package_unit, jurisdiction, regulatory_authority,
          regulatory_identifier, regulatory_status, approval_date, withdrawal_date,
          source, source_version, source_ref, license_basis, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *
     )
     SELECT i.*, m.name AS manufacturer_name,
            pharma_effective_verification(i.verification_status, i.verification_expires_at)
              AS effective_verification_status
       FROM inserted i
       LEFT JOIN manufacturer m ON m.id = i.manufacturer_id`,
    [
      input.clinicId,
      input.medicationId,
      input.brandName,
      input.manufacturerId,
      input.dosageForm,
      input.route,
      input.strengthText,
      input.packageDescription,
      input.packageSize,
      input.packageUnit,
      input.jurisdiction,
      input.regulatoryAuthority,
      input.regulatoryIdentifier,
      input.regulatoryStatus,
      input.approvalDate,
      input.withdrawalDate,
      input.source,
      input.sourceVersion,
      input.sourceRef,
      input.licenseBasis,
      input.createdBy,
    ],
  );
  return mapProduct(rows[0]!);
}

export async function listProducts(
  clinicId: string,
  medicationId: string,
  jurisdiction: string | null,
): Promise<MedicationProduct[]> {
  const { rows } = await getPool().query<ProductRow>(
    `SELECT p.*, m.name AS manufacturer_name, ${PRODUCT_EFFECTIVE} AS effective_verification_status
       FROM medication_product p
       LEFT JOIN manufacturer m ON m.id = p.manufacturer_id
      WHERE p.clinic_id = $1 AND p.medication_id = $2
        AND ($3::text IS NULL OR p.jurisdiction = $3)
      ORDER BY p.brand_name`,
    [clinicId, medicationId, jurisdiction],
  );
  return rows.map(mapProduct);
}

export async function insertManufacturer(
  client: PoolClient,
  input: {
    clinicId: string;
    name: string;
    country: string | null;
    source: string;
    sourceVersion: string | null;
    jurisdiction: string;
    createdBy: string;
  },
): Promise<{ id: string; name: string }> {
  const { rows } = await client.query<{ id: string; name: string }>(
    `INSERT INTO manufacturer (clinic_id, name, country, source, source_version, jurisdiction, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, name`,
    [
      input.clinicId,
      input.name,
      input.country,
      input.source,
      input.sourceVersion,
      input.jurisdiction,
      input.createdBy,
    ],
  );
  return rows[0]!;
}

export async function findManufacturerByName(
  runner: Runner,
  clinicId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const { rows } = await runner.query<{ id: string; name: string }>(
    `SELECT id, name FROM manufacturer WHERE clinic_id = $1 AND lower(name) = lower($2)`,
    [clinicId, name],
  );
  return rows[0] ?? null;
}

// --- Import runs ------------------------------------------------------------

export async function startImportRun(
  client: PoolClient,
  input: {
    clinicId: string;
    providerKey: string;
    providerVersion: string | null;
    sourceRef: string | null;
    licenseBasis: string;
    jurisdiction: string;
    startedBy: string;
  },
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO medication_import_run
       (clinic_id, provider_key, provider_version, source_ref, license_basis, jurisdiction, started_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [
      input.clinicId,
      input.providerKey,
      input.providerVersion,
      input.sourceRef,
      input.licenseBasis,
      input.jurisdiction,
      input.startedBy,
    ],
  );
  return rows[0]!;
}

export async function finishImportRun(
  client: PoolClient,
  id: string,
  input: {
    status: 'completed' | 'failed';
    recordsCreated: number;
    recordsUpdated: number;
    recordsSkipped: number;
    errorMessage: string | null;
  },
): Promise<void> {
  await client.query(
    `UPDATE medication_import_run
        SET status = $2, records_created = $3, records_updated = $4, records_skipped = $5,
            error_message = $6, finished_at = now()
      WHERE id = $1`,
    [
      id,
      input.status,
      input.recordsCreated,
      input.recordsUpdated,
      input.recordsSkipped,
      input.errorMessage,
    ],
  );
}

export async function listImportRuns(clinicId: string, limit: number) {
  const { rows } = await getPool().query<{
    id: string;
    provider_key: string;
    provider_version: string | null;
    license_basis: string;
    jurisdiction: string;
    status: string;
    records_created: number;
    records_updated: number;
    records_skipped: number;
    started_at: string;
    finished_at: string | null;
  }>(
    `SELECT id, provider_key, provider_version, license_basis, jurisdiction, status,
            records_created, records_updated, records_skipped, started_at, finished_at
       FROM medication_import_run
      WHERE clinic_id = $1
      ORDER BY started_at DESC
      LIMIT $2`,
    [clinicId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    providerKey: r.provider_key,
    providerVersion: r.provider_version,
    licenseBasis: r.license_basis,
    jurisdiction: r.jurisdiction,
    status: r.status,
    recordsCreated: r.records_created,
    recordsUpdated: r.records_updated,
    recordsSkipped: r.records_skipped,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }));
}

// --- product verification (migration 0315) -----------------------------------

export async function getProductForUpdate(
  client: PoolClient,
  clinicId: string,
  productId: string,
): Promise<MedicationProduct | null> {
  const { rows } = await client.query<ProductRow>(
    `SELECT p.*, m.name AS manufacturer_name, ${PRODUCT_EFFECTIVE} AS effective_verification_status
       FROM medication_product p
       LEFT JOIN manufacturer m ON m.id = p.manufacturer_id
      WHERE p.id = $1 AND p.clinic_id = $2
      FOR UPDATE OF p`,
    [productId, clinicId],
  );
  return rows[0] ? mapProduct(rows[0]) : null;
}

export async function updateProductVerification(
  client: PoolClient,
  clinicId: string,
  productId: string,
  input: {
    verificationStatus: VerificationStatus;
    lastVerifiedAt: string | null;
    verifiedBy: string | null;
    expiresAt: string | null;
    note: string | null;
  },
): Promise<MedicationProduct> {
  const { rows } = await client.query<ProductRow>(
    `WITH updated AS (
       UPDATE medication_product
          SET verification_status = $3,
              last_verified_at = $4,
              verified_by = $5,
              verification_expires_at = $6,
              verification_note = $7,
              updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING *
     )
     SELECT p.*, m.name AS manufacturer_name,
            pharma_effective_verification(p.verification_status, p.verification_expires_at)
              AS effective_verification_status
       FROM updated p
       LEFT JOIN manufacturer m ON m.id = p.manufacturer_id`,
    [
      productId,
      clinicId,
      input.verificationStatus,
      input.lastVerifiedAt,
      input.verifiedBy,
      input.expiresAt,
      input.note,
    ],
  );
  return mapProduct(rows[0]!);
}

/** Products whose attestation has lapsed but which still say `verified`. */
export async function expiredProductVerifications(
  client: PoolClient,
  clinicId: string,
  limit: number,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM medication_product
      WHERE clinic_id = $1
        AND verification_status = 'verified'
        AND verification_expires_at IS NOT NULL
        AND verification_expires_at < now()
      ORDER BY verification_expires_at
      LIMIT $2
      FOR UPDATE`,
    [clinicId, limit],
  );
  return rows.map((r) => r.id);
}
