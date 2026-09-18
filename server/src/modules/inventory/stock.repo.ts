import type { PoolClient } from '../../db/pool.js';
import { getPool } from '../../db/pool.js';
import type { MovementDirection, MovementType, StockBalance, StockMovement } from './inventory.types.js';
import { mapBalance, toIsoDate, type Queryable } from './inventory.repo.js';
const db = (runner?: Queryable): Queryable => runner ?? getPool();

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapMovement(r: any): StockMovement {
  return {
    id: r.id, clinicId: r.clinic_id, productId: r.product_id, locationId: r.location_id,
    batchId: r.batch_id, movementType: r.movement_type, direction: r.direction,
    quantity: Number(r.quantity), quantityDelta: Number(r.quantity_delta),
    counterpartyLocationId: r.counterparty_location_id, transferGroupId: r.transfer_group_id,
    reason: r.reason, reference: r.reference, balanceAfter: Number(r.balance_after),
    actorId: r.actor_id, occurredAt: r.occurred_at, createdAt: r.created_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Ensure the balance row exists and take a ROW LOCK on it (SELECT ... FOR
 * UPDATE). Every stock mutation goes through here inside a transaction, which
 * serialises concurrent movements against the same (product, location, batch)
 * and makes the read-modify-write safe. `batch_id IS NOT DISTINCT FROM` matches
 * the NULL (untracked) row correctly.
 */
export async function lockBalance(
  client: PoolClient, clinicId: string, productId: string, locationId: string, batchId: string | null,
): Promise<StockBalance> {
  await client.query(
    `INSERT INTO stock_balance (clinic_id, product_id, location_id, batch_id, on_hand)
     VALUES ($1,$2,$3,$4,0) ON CONFLICT ON CONSTRAINT uq_stock_balance DO NOTHING`,
    [clinicId, productId, locationId, batchId],
  );
  const { rows } = await client.query(
    `SELECT * FROM stock_balance
      WHERE clinic_id=$1 AND product_id=$2 AND location_id=$3 AND batch_id IS NOT DISTINCT FROM $4
      FOR UPDATE`,
    [clinicId, productId, locationId, batchId],
  );
  return mapBalance(rows[0]);
}

/** Apply a signed delta to a locked balance row. The CHECK(on_hand >= 0) is the
 * database backstop; callers pre-check to raise a clean domain error first. */
export async function applyDelta(client: PoolClient, balanceId: string, delta: number): Promise<number> {
  const { rows } = await client.query(
    `UPDATE stock_balance SET on_hand = on_hand + $2, version = version + 1, updated_at = now()
      WHERE id = $1 RETURNING on_hand`,
    [balanceId, delta],
  );
  return Number(rows[0].on_hand);
}

export interface MovementInsert {
  clinicId: string;
  productId: string;
  locationId: string;
  batchId: string | null;
  movementType: MovementType;
  direction: MovementDirection;
  quantity: number;
  counterpartyLocationId?: string | null;
  transferGroupId?: string | null;
  reason?: string | null;
  reference?: string | null;
  idempotencyKey?: string | null;
  balanceAfter: number;
  actorId: string;
}

export async function insertMovement(client: PoolClient, m: MovementInsert): Promise<StockMovement> {
  const delta = m.direction === 'in' ? m.quantity : -m.quantity;
  const { rows } = await client.query(
    `INSERT INTO stock_movement (
       clinic_id, product_id, location_id, batch_id, movement_type, direction, quantity,
       quantity_delta, counterparty_location_id, transfer_group_id, reason, reference,
       idempotency_key, balance_after, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      m.clinicId, m.productId, m.locationId, m.batchId, m.movementType, m.direction, m.quantity,
      delta, m.counterpartyLocationId ?? null, m.transferGroupId ?? null, m.reason ?? null,
      m.reference ?? null, m.idempotencyKey ?? null, m.balanceAfter, m.actorId,
    ],
  );
  return mapMovement(rows[0]);
}

/** Both ledger rows of a transfer, by its group id (dedupe / reconciliation). */
export async function listByTransferGroup(
  clinicId: string, groupId: string, runner?: Queryable,
): Promise<StockMovement[]> {
  const { rows } = await db(runner).query(
    'SELECT * FROM stock_movement WHERE clinic_id=$1 AND transfer_group_id=$2 ORDER BY direction DESC',
    [clinicId, groupId],
  );
  return rows.map(mapMovement);
}

/** A movement already recorded under this idempotency key, if any (dedupe). */
export async function findByIdempotencyKey(
  clinicId: string, key: string, runner?: Queryable,
): Promise<StockMovement | null> {
  const { rows } = await db(runner).query(
    'SELECT * FROM stock_movement WHERE clinic_id=$1 AND idempotency_key=$2 LIMIT 1',
    [clinicId, key],
  );
  return rows[0] ? mapMovement(rows[0]) : null;
}

// -- read queries ------------------------------------------------------------
export interface MovementQuery {
  productId?: string;
  locationId?: string;
  batchId?: string;
  movementType?: MovementType;
  limit: number;
  offset: number;
}
export async function listMovements(clinicId: string, q: MovementQuery, runner?: Queryable): Promise<StockMovement[]> {
  const { rows } = await db(runner).query(
    `SELECT * FROM stock_movement
      WHERE clinic_id=$1
        AND ($2::uuid IS NULL OR product_id=$2)
        AND ($3::uuid IS NULL OR location_id=$3)
        AND ($4::uuid IS NULL OR batch_id=$4)
        AND ($5::text IS NULL OR movement_type=$5)
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT $6 OFFSET $7`,
    [clinicId, q.productId ?? null, q.locationId ?? null, q.batchId ?? null, q.movementType ?? null, q.limit, q.offset],
  );
  return rows.map(mapMovement);
}

export interface BalanceRow {
  productId: string;
  productName: string;
  sku: string;
  locationId: string;
  locationName: string;
  batchId: string | null;
  lotNumber: string | null;
  expiryDate: string | null;
  onHand: number;
}
export async function listBalances(
  clinicId: string, filter: { productId?: string; locationId?: string; onlyPositive?: boolean },
  runner?: Queryable,
): Promise<BalanceRow[]> {
  const { rows } = await db(runner).query(
    `SELECT b.product_id, p.name AS product_name, p.sku, b.location_id, l.name AS location_name,
            b.batch_id, ba.lot_number, ba.expiry_date, b.on_hand
       FROM stock_balance b
       JOIN inventory_product p ON p.id = b.product_id
       JOIN inventory_location l ON l.id = b.location_id
       LEFT JOIN inventory_batch ba ON ba.id = b.batch_id
      WHERE b.clinic_id=$1
        AND ($2::uuid IS NULL OR b.product_id=$2)
        AND ($3::uuid IS NULL OR b.location_id=$3)
        AND ($4::boolean IS FALSE OR b.on_hand > 0)
      ORDER BY lower(p.name), lower(l.name)`,
    [clinicId, filter.productId ?? null, filter.locationId ?? null, filter.onlyPositive ?? false],
  );
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return rows.map((r: any) => ({
    productId: r.product_id, productName: r.product_name, sku: r.sku, locationId: r.location_id,
    locationName: r.location_name, batchId: r.batch_id, lotNumber: r.lot_number,
    expiryDate: toIsoDate(r.expiry_date), onHand: Number(r.on_hand),
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export interface LowStockRow {
  productId: string;
  sku: string;
  name: string;
  unitOfMeasure: string;
  onHand: number;
  reorderThreshold: number;
  reorderQuantity: number | null;
}
/** Products whose total on-hand across all locations is at or below their
 * persisted reorder threshold. Products without a threshold are never "low". */
export async function lowStock(clinicId: string, runner?: Queryable): Promise<LowStockRow[]> {
  const { rows } = await db(runner).query(
    `SELECT p.id AS product_id, p.sku, p.name, p.unit_of_measure,
            coalesce(sb.total,0) AS on_hand, p.reorder_threshold, p.reorder_quantity
       FROM inventory_product p
       LEFT JOIN (
         SELECT product_id, sum(on_hand) AS total FROM stock_balance
          WHERE clinic_id=$1 GROUP BY product_id
       ) sb ON sb.product_id = p.id
      WHERE p.clinic_id=$1 AND p.is_active
        AND p.reorder_threshold IS NOT NULL
        AND coalesce(sb.total,0) <= p.reorder_threshold
      ORDER BY (coalesce(sb.total,0) - p.reorder_threshold), lower(p.name)`,
    [clinicId],
  );
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return rows.map((r: any) => ({
    productId: r.product_id, sku: r.sku, name: r.name, unitOfMeasure: r.unit_of_measure,
    onHand: Number(r.on_hand), reorderThreshold: Number(r.reorder_threshold),
    reorderQuantity: r.reorder_quantity === null ? null : Number(r.reorder_quantity),
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export interface ValuationRow {
  productId: string;
  sku: string;
  name: string;
  onHand: number;
  unitCost: number | null;
  unitPrice: number | null;
  stockValue: number | null; // onHand * unitCost, null when no cost is set
}
/** Per-product on-hand and stock value (on_hand × unit_cost) across all
 * locations. Products with any stock or a threshold are included. */
export async function valuation(clinicId: string, runner?: Queryable): Promise<ValuationRow[]> {
  const { rows } = await db(runner).query(
    `SELECT p.id AS product_id, p.sku, p.name, p.unit_cost, p.unit_price,
            coalesce(sb.total,0) AS on_hand,
            CASE WHEN p.unit_cost IS NULL THEN NULL ELSE coalesce(sb.total,0) * p.unit_cost END AS stock_value
       FROM inventory_product p
       LEFT JOIN (SELECT product_id, sum(on_hand) AS total FROM stock_balance WHERE clinic_id=$1 GROUP BY product_id) sb
         ON sb.product_id = p.id
      WHERE p.clinic_id=$1 AND p.is_active
      ORDER BY lower(p.name)`,
    [clinicId],
  );
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return rows.map((r: any) => ({
    productId: r.product_id, sku: r.sku, name: r.name, onHand: Number(r.on_hand),
    unitCost: r.unit_cost === null ? null : Number(r.unit_cost),
    unitPrice: r.unit_price === null ? null : Number(r.unit_price),
    stockValue: r.stock_value === null ? null : Number(r.stock_value),
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Total on-hand for one product across all locations/batches (for issue checks
 * and product detail). */
export async function totalOnHand(clinicId: string, productId: string, runner?: Queryable): Promise<number> {
  const { rows } = await db(runner).query(
    'SELECT coalesce(sum(on_hand),0) AS total FROM stock_balance WHERE clinic_id=$1 AND product_id=$2',
    [clinicId, productId],
  );
  return Number(rows[0].total);
}
