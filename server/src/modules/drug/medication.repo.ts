import { getPool, type PoolClient } from '../../db/pool.js';
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
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
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
  isActive: boolean;
  createdAt: string;
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

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
  last_verified_at: string | null;
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
    verificationStatus: row.verification_status,
    lastVerifiedAt: row.last_verified_at,
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
    `SELECT * FROM medication WHERE id = $1 AND clinic_id = $2`,
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
    `SELECT * FROM medication WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
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
    `SELECT DISTINCT m.* FROM medication m
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
  input: { verificationStatus: VerificationStatus; lastVerifiedAt: string | null; confidence: number | null },
): Promise<Medication> {
  const { rows } = await client.query<MedicationRow>(
    `UPDATE medication
        SET verification_status = $3,
            last_verified_at = $4,
            confidence = coalesce($5, confidence),
            record_version = record_version + 1,
            updated_at = now()
      WHERE id = $1 AND clinic_id = $2
      RETURNING *`,
    [id, clinicId, input.verificationStatus, input.lastVerifiedAt, input.confidence],
  );
  return mapMedication(rows[0]!);
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
    changedBy: string;
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
  approval_date: string | null;
  withdrawal_date: string | null;
  source: string;
  source_version: string | null;
  source_ref: string | null;
  license_basis: string;
  verification_status: VerificationStatus;
  last_verified_at: string | null;
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
    approvalDate: row.approval_date,
    withdrawalDate: row.withdrawal_date,
    source: row.source,
    sourceVersion: row.source_version,
    sourceRef: row.source_ref,
    licenseBasis: row.license_basis,
    verificationStatus: row.verification_status,
    lastVerifiedAt: row.last_verified_at,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

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
  const { rows } = await client.query<ProductRow>(
    `INSERT INTO medication_product
       (clinic_id, medication_id, brand_name, manufacturer_id, dosage_form, route, strength_text,
        package_description, package_size, package_unit, jurisdiction, regulatory_authority,
        regulatory_identifier, regulatory_status, approval_date, withdrawal_date,
        source, source_version, source_ref, license_basis, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
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
    `SELECT p.*, m.name AS manufacturer_name
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
