import type { PoolClient } from '../../db/pool.js';
import { getPool } from '../../db/pool.js';
import type {
  CreateBatchInput, CreateLocationInput, CreateProductInput, InventoryBatch,
  InventoryLocation, InventoryProduct, StockBalance, UpdateLocationInput, UpdateProductInput,
} from './inventory.types.js';

/** Anything that can run a parameterised query — the shared pool or a tx client. */
export type Queryable = Pick<PoolClient, 'query'>;
const db = (runner?: Queryable): Queryable => runner ?? getPool();

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Normalise a `date` column (pg returns it as a Date) to a 'YYYY-MM-DD' string
 * so comparisons and JSON output are stable and timezone-free. */
export function toIsoDate(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

// -- row mappers -------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
function mapLocation(r: any): InventoryLocation {
  return {
    id: r.id, clinicId: r.clinic_id, code: r.code, name: r.name, kind: r.kind,
    isActive: r.is_active, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapProduct(r: any): InventoryProduct {
  return {
    id: r.id, clinicId: r.clinic_id, sku: r.sku, name: r.name, category: r.category,
    unitOfMeasure: r.unit_of_measure, medicationProductId: r.medication_product_id,
    isBatchTracked: r.is_batch_tracked, isExpiryTracked: r.is_expiry_tracked,
    blockExpiredIssue: r.block_expired_issue, allowNegativeStock: r.allow_negative_stock,
    reorderThreshold: num(r.reorder_threshold), reorderQuantity: num(r.reorder_quantity),
    isBillable: r.is_billable, billingCode: r.billing_code, unitPrice: num(r.unit_price),
    unitCost: num(r.unit_cost), isActive: r.is_active, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapBatch(r: any): InventoryBatch {
  return {
    id: r.id, clinicId: r.clinic_id, productId: r.product_id, lotNumber: r.lot_number,
    expiryDate: toIsoDate(r.expiry_date), isActive: r.is_active, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapBalance(r: any): StockBalance {
  return {
    id: r.id, clinicId: r.clinic_id, productId: r.product_id, locationId: r.location_id,
    batchId: r.batch_id, onHand: Number(r.on_hand), version: r.version, updatedAt: r.updated_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// -- Locations ---------------------------------------------------------------
export async function insertLocation(
  clinicId: string, actorId: string, input: CreateLocationInput, runner?: Queryable,
): Promise<InventoryLocation> {
  const { rows } = await db(runner).query(
    `INSERT INTO inventory_location (clinic_id, code, name, kind, created_by)
     VALUES ($1,$2,$3,coalesce($4,'store'),$5) RETURNING *`,
    [clinicId, input.code, input.name, input.kind ?? null, actorId],
  );
  return mapLocation(rows[0]);
}

export async function updateLocation(
  clinicId: string, id: string, patch: UpdateLocationInput, runner?: Queryable,
): Promise<InventoryLocation | null> {
  const { rows } = await db(runner).query(
    `UPDATE inventory_location SET
       name = coalesce($3, name),
       kind = coalesce($4, kind),
       is_active = coalesce($5, is_active),
       updated_at = now()
     WHERE clinic_id = $1 AND id = $2 RETURNING *`,
    [clinicId, id, patch.name ?? null, patch.kind ?? null, patch.isActive ?? null],
  );
  return rows[0] ? mapLocation(rows[0]) : null;
}

export async function getLocation(clinicId: string, id: string, runner?: Queryable): Promise<InventoryLocation | null> {
  const { rows } = await db(runner).query('SELECT * FROM inventory_location WHERE clinic_id=$1 AND id=$2', [clinicId, id]);
  return rows[0] ? mapLocation(rows[0]) : null;
}

export async function listLocations(clinicId: string, includeInactive: boolean, runner?: Queryable): Promise<InventoryLocation[]> {
  const { rows } = await db(runner).query(
    `SELECT * FROM inventory_location WHERE clinic_id=$1 AND ($2 OR is_active) ORDER BY lower(name)`,
    [clinicId, includeInactive],
  );
  return rows.map(mapLocation);
}

// -- Products ----------------------------------------------------------------
export async function insertProduct(
  clinicId: string, actorId: string, input: CreateProductInput, runner?: Queryable,
): Promise<InventoryProduct> {
  const { rows } = await db(runner).query(
    `INSERT INTO inventory_product (
       clinic_id, sku, name, category, unit_of_measure, medication_product_id,
       is_batch_tracked, is_expiry_tracked, block_expired_issue, allow_negative_stock,
       reorder_threshold, reorder_quantity, is_billable, billing_code, unit_price, unit_cost, created_by)
     VALUES ($1,$2,$3,$4,coalesce($5,'unit'),$6,
             coalesce($7,false),coalesce($8,false),coalesce($9,true),coalesce($10,false),
             $11,$12,coalesce($13,false),$14,$15,$16,$17)
     RETURNING *`,
    [
      clinicId, input.sku, input.name, input.category ?? null, input.unitOfMeasure ?? null,
      input.medicationProductId ?? null, input.isBatchTracked ?? null, input.isExpiryTracked ?? null,
      input.blockExpiredIssue ?? null, input.allowNegativeStock ?? null, input.reorderThreshold ?? null,
      input.reorderQuantity ?? null, input.isBillable ?? null, input.billingCode ?? null,
      input.unitPrice ?? null, input.unitCost ?? null, actorId,
    ],
  );
  return mapProduct(rows[0]);
}

export async function updateProduct(
  clinicId: string, id: string, patch: UpdateProductInput, runner?: Queryable,
): Promise<InventoryProduct | null> {
  const { rows } = await db(runner).query(
    `UPDATE inventory_product SET
       name = coalesce($3, name),
       category = coalesce($4, category),
       unit_of_measure = coalesce($5, unit_of_measure),
       medication_product_id = coalesce($6, medication_product_id),
       is_batch_tracked = coalesce($7, is_batch_tracked),
       is_expiry_tracked = coalesce($8, is_expiry_tracked),
       block_expired_issue = coalesce($9, block_expired_issue),
       allow_negative_stock = coalesce($10, allow_negative_stock),
       reorder_threshold = coalesce($11, reorder_threshold),
       reorder_quantity = coalesce($12, reorder_quantity),
       is_billable = coalesce($13, is_billable),
       billing_code = coalesce($14, billing_code),
       unit_price = coalesce($15, unit_price),
       unit_cost = coalesce($16, unit_cost),
       is_active = coalesce($17, is_active),
       updated_at = now()
     WHERE clinic_id = $1 AND id = $2 RETURNING *`,
    [
      clinicId, id, patch.name ?? null, patch.category ?? null, patch.unitOfMeasure ?? null,
      patch.medicationProductId ?? null, patch.isBatchTracked ?? null, patch.isExpiryTracked ?? null,
      patch.blockExpiredIssue ?? null, patch.allowNegativeStock ?? null, patch.reorderThreshold ?? null,
      patch.reorderQuantity ?? null, patch.isBillable ?? null, patch.billingCode ?? null,
      patch.unitPrice ?? null, patch.unitCost ?? null, patch.isActive ?? null,
    ],
  );
  return rows[0] ? mapProduct(rows[0]) : null;
}

export async function getProduct(clinicId: string, id: string, runner?: Queryable): Promise<InventoryProduct | null> {
  const { rows } = await db(runner).query('SELECT * FROM inventory_product WHERE clinic_id=$1 AND id=$2', [clinicId, id]);
  return rows[0] ? mapProduct(rows[0]) : null;
}

export interface ProductSearch {
  q?: string;
  category?: string;
  includeInactive?: boolean;
  limit: number;
  offset: number;
}
export async function searchProducts(clinicId: string, s: ProductSearch, runner?: Queryable): Promise<InventoryProduct[]> {
  const { rows } = await db(runner).query(
    `SELECT * FROM inventory_product
      WHERE clinic_id = $1
        AND ($2::boolean OR is_active)
        AND ($3::text IS NULL OR name ILIKE '%'||$3||'%' OR sku ILIKE '%'||$3||'%')
        AND ($4::text IS NULL OR lower(category) = lower($4))
      ORDER BY lower(name)
      LIMIT $5 OFFSET $6`,
    [clinicId, s.includeInactive ?? false, s.q ?? null, s.category ?? null, s.limit, s.offset],
  );
  return rows.map(mapProduct);
}

// -- Batches -----------------------------------------------------------------
export async function insertBatch(
  clinicId: string, actorId: string, input: CreateBatchInput, runner?: Queryable,
): Promise<InventoryBatch> {
  const { rows } = await db(runner).query(
    `INSERT INTO inventory_batch (clinic_id, product_id, lot_number, expiry_date, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [clinicId, input.productId, input.lotNumber, input.expiryDate ?? null, actorId],
  );
  return mapBatch(rows[0]);
}

export async function getBatch(clinicId: string, id: string, runner?: Queryable): Promise<InventoryBatch | null> {
  const { rows } = await db(runner).query('SELECT * FROM inventory_batch WHERE clinic_id=$1 AND id=$2', [clinicId, id]);
  return rows[0] ? mapBatch(rows[0]) : null;
}

export async function listBatches(clinicId: string, productId: string, runner?: Queryable): Promise<InventoryBatch[]> {
  const { rows } = await db(runner).query(
    `SELECT * FROM inventory_batch WHERE clinic_id=$1 AND product_id=$2
      ORDER BY (expiry_date IS NULL), expiry_date, lower(lot_number)`,
    [clinicId, productId],
  );
  return rows.map(mapBatch);
}

export { mapBalance };
