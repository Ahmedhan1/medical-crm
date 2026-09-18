import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { withTransaction, type PoolClient } from '../../db/pool.js';
import * as repo from './inventory.repo.js';
import * as ledger from './stock.repo.js';
import type { InventoryBatch, InventoryProduct, StockMovement } from './inventory.types.js';

export interface StockOpInput {
  productId: string;
  locationId: string;
  batchId?: string | null;
  quantity: number;
  reason?: string | null;
  reference?: string | null;
  /** A caller-supplied key so a retried request is a no-op, not a double move. */
  idempotencyKey?: string | null;
}
export interface TransferInput extends Omit<StockOpInput, 'locationId'> {
  fromLocationId: string;
  toLocationId: string;
}
export interface AdjustInput extends StockOpInput {
  direction: 'in' | 'out';
}

function assertQuantity(q: number): void {
  if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0) {
    throw new ValidationError('Quantity must be a positive number');
  }
}

function isExpired(batch: InventoryBatch): boolean {
  if (!batch.expiryDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  return batch.expiryDate < today; // last usable day is the expiry date itself
}

/** Resolve + validate product/location/batch for a mutation, all clinic-scoped. */
async function resolveContext(
  client: PoolClient, clinicId: string, productId: string, locationId: string, batchId: string | null | undefined,
): Promise<{ product: InventoryProduct; batch: InventoryBatch | null }> {
  const product = await repo.getProduct(clinicId, productId, client);
  if (!product) throw new NotFoundError('Product');
  if (!product.isActive) throw new ValidationError('Product is inactive');
  const location = await repo.getLocation(clinicId, locationId, client);
  if (!location) throw new NotFoundError('Location');
  let batch: InventoryBatch | null = null;
  if (product.isBatchTracked) {
    if (!batchId) throw new ValidationError('This product is batch-tracked; a batch is required');
    batch = await repo.getBatch(clinicId, batchId, client);
    if (!batch) throw new NotFoundError('Batch');
    if (batch.productId !== productId) throw new ValidationError('Batch does not belong to this product');
  } else if (batchId) {
    throw new ValidationError('This product is not batch-tracked; a batch must not be supplied');
  }
  return { product, batch };
}

/** Return an already-recorded movement for this idempotency key, or null. */
async function existingIdempotent(clinicId: string, key: string | null | undefined): Promise<StockMovement | null> {
  if (!key) return null;
  return ledger.findByIdempotencyKey(clinicId, key);
}

async function recordInbound(
  p: Principal, input: StockOpInput, type: 'RECEIVE' | 'RETURN', permission: (typeof Permission)[keyof typeof Permission],
): Promise<StockMovement> {
  requirePermission(p, permission);
  assertQuantity(input.quantity);
  const dup = await existingIdempotent(p.clinicId, input.idempotencyKey);
  if (dup) return dup;
  try {
    return await withTransaction(async (client) => {
      const { batch } = await resolveContext(client, p.clinicId, input.productId, input.locationId, input.batchId);
      const balance = await ledger.lockBalance(client, p.clinicId, input.productId, input.locationId, batch?.id ?? null);
      const after = await ledger.applyDelta(client, balance.id, input.quantity);
      const movement = await ledger.insertMovement(client, {
        clinicId: p.clinicId, productId: input.productId, locationId: input.locationId, batchId: batch?.id ?? null,
        movementType: type, direction: 'in', quantity: input.quantity, reason: input.reason,
        reference: input.reference, idempotencyKey: input.idempotencyKey, balanceAfter: after, actorId: p.userId,
      });
      await auditTx(client, { clinicId: p.clinicId, actorId: p.userId, action: `inventory.stock.${type.toLowerCase()}`, targetType: 'inventory_product', targetId: input.productId, metadata: { locationId: input.locationId, quantity: input.quantity } });
      return movement;
    });
  } catch (err) {
    // A concurrent duplicate (same idempotency key) — return the winner.
    if ((err as { code?: string }).code === '23505' && input.idempotencyKey) {
      const won = await ledger.findByIdempotencyKey(p.clinicId, input.idempotencyKey);
      if (won) return won;
    }
    throw err;
  }
}

/** Receive stock into a location (purchase, delivery). */
export function receiveStock(p: Principal, input: StockOpInput): Promise<StockMovement> {
  return recordInbound(p, input, 'RECEIVE', Permission.STOCK_RECEIVE);
}

/** Return stock back into a location (e.g. an unused issue). */
export function returnStock(p: Principal, input: StockOpInput): Promise<StockMovement> {
  return recordInbound(p, input, 'RETURN', Permission.STOCK_RECEIVE);
}

/** Issue/consume stock out of a location. Blocks negative stock and (when the
 * product requires it) issuing from an expired batch. */
export async function issueStock(p: Principal, input: StockOpInput): Promise<StockMovement> {
  requirePermission(p, Permission.STOCK_ISSUE);
  assertQuantity(input.quantity);
  const dup = await existingIdempotent(p.clinicId, input.idempotencyKey);
  if (dup) return dup;
  try {
    return await withTransaction(async (client) => {
      const { product, batch } = await resolveContext(client, p.clinicId, input.productId, input.locationId, input.batchId);
      if (batch && product.blockExpiredIssue && isExpired(batch)) {
        throw new ValidationError('Cannot issue from an expired batch');
      }
      const balance = await ledger.lockBalance(client, p.clinicId, input.productId, input.locationId, batch?.id ?? null);
      if (!product.allowNegativeStock && balance.onHand < input.quantity) {
        throw new ConflictError('Insufficient stock at this location', { onHand: balance.onHand, requested: input.quantity });
      }
      const after = await ledger.applyDelta(client, balance.id, -input.quantity);
      const movement = await ledger.insertMovement(client, {
        clinicId: p.clinicId, productId: input.productId, locationId: input.locationId, batchId: batch?.id ?? null,
        movementType: 'ISSUE', direction: 'out', quantity: input.quantity, reason: input.reason,
        reference: input.reference, idempotencyKey: input.idempotencyKey, balanceAfter: after, actorId: p.userId,
      });
      await auditTx(client, { clinicId: p.clinicId, actorId: p.userId, action: 'inventory.stock.issue', targetType: 'inventory_product', targetId: input.productId, metadata: { locationId: input.locationId, quantity: input.quantity } });
      return movement;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505' && input.idempotencyKey) {
      const won = await ledger.findByIdempotencyKey(p.clinicId, input.idempotencyKey);
      if (won) return won;
    }
    throw err;
  }
}

/** Adjust on-hand up or down with a mandatory reason (stock count correction,
 * breakage, expiry write-off). */
export async function adjustStock(p: Principal, input: AdjustInput): Promise<StockMovement> {
  requirePermission(p, Permission.STOCK_ADJUST);
  assertQuantity(input.quantity);
  if (input.direction !== 'in' && input.direction !== 'out') throw new ValidationError('Adjustment direction must be in or out');
  if (!input.reason?.trim()) throw new ValidationError('An adjustment requires a reason');
  const dup = await existingIdempotent(p.clinicId, input.idempotencyKey);
  if (dup) return dup;
  try {
    return await withTransaction(async (client) => {
      const { product, batch } = await resolveContext(client, p.clinicId, input.productId, input.locationId, input.batchId);
      const balance = await ledger.lockBalance(client, p.clinicId, input.productId, input.locationId, batch?.id ?? null);
      const delta = input.direction === 'in' ? input.quantity : -input.quantity;
      if (input.direction === 'out' && !product.allowNegativeStock && balance.onHand < input.quantity) {
        throw new ConflictError('Adjustment would drive stock negative', { onHand: balance.onHand, requested: input.quantity });
      }
      const after = await ledger.applyDelta(client, balance.id, delta);
      const movement = await ledger.insertMovement(client, {
        clinicId: p.clinicId, productId: input.productId, locationId: input.locationId, batchId: batch?.id ?? null,
        movementType: 'ADJUSTMENT', direction: input.direction, quantity: input.quantity, reason: input.reason,
        reference: input.reference, idempotencyKey: input.idempotencyKey, balanceAfter: after, actorId: p.userId,
      });
      await auditTx(client, { clinicId: p.clinicId, actorId: p.userId, action: 'inventory.stock.adjust', targetType: 'inventory_product', targetId: input.productId, metadata: { locationId: input.locationId, direction: input.direction, quantity: input.quantity } });
      return movement;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505' && input.idempotencyKey) {
      const won = await ledger.findByIdempotencyKey(p.clinicId, input.idempotencyKey);
      if (won) return won;
    }
    throw err;
  }
}

/** Move stock between two locations. Recorded as two linked ledger rows (out at
 * source, in at destination) so both sides reconcile. Balance rows are locked in
 * a deterministic order to avoid deadlocks under concurrency. */
export async function transferStock(p: Principal, input: TransferInput): Promise<{ out: StockMovement; in: StockMovement }> {
  requirePermission(p, Permission.STOCK_TRANSFER);
  assertQuantity(input.quantity);
  if (input.fromLocationId === input.toLocationId) throw new ValidationError('Source and destination must differ');
  const dup = await existingIdempotent(p.clinicId, input.idempotencyKey);
  if (dup?.transferGroupId) {
    const pair = await ledger.listByTransferGroup(p.clinicId, dup.transferGroupId);
    const out = pair.find((m) => m.direction === 'out');
    const inn = pair.find((m) => m.direction === 'in');
    if (out && inn) return { out, in: inn };
  }
  const transferGroupId = randomUUID();
  try {
    return await withTransaction(async (client) => {
      const { product, batch } = await resolveContext(client, p.clinicId, input.productId, input.fromLocationId, input.batchId);
      const toLocation = await repo.getLocation(p.clinicId, input.toLocationId, client);
      if (!toLocation) throw new NotFoundError('Destination location');
      // Lock both balance rows in a deterministic order (by location id) to avoid deadlock.
      const [firstLoc, secondLoc] = [input.fromLocationId, input.toLocationId].sort();
      await ledger.lockBalance(client, p.clinicId, input.productId, firstLoc!, batch?.id ?? null);
      await ledger.lockBalance(client, p.clinicId, input.productId, secondLoc!, batch?.id ?? null);
      // Re-read the source balance (now locked) for the availability check.
      const source = await ledger.lockBalance(client, p.clinicId, input.productId, input.fromLocationId, batch?.id ?? null);
      if (!product.allowNegativeStock && source.onHand < input.quantity) {
        throw new ConflictError('Insufficient stock at the source location', { onHand: source.onHand, requested: input.quantity });
      }
      const afterOut = await ledger.applyDelta(client, source.id, -input.quantity);
      const dest = await ledger.lockBalance(client, p.clinicId, input.productId, input.toLocationId, batch?.id ?? null);
      const afterIn = await ledger.applyDelta(client, dest.id, input.quantity);
      const out = await ledger.insertMovement(client, {
        clinicId: p.clinicId, productId: input.productId, locationId: input.fromLocationId, batchId: batch?.id ?? null,
        movementType: 'TRANSFER', direction: 'out', quantity: input.quantity, counterpartyLocationId: input.toLocationId,
        transferGroupId, reason: input.reason, reference: input.reference, idempotencyKey: input.idempotencyKey,
        balanceAfter: afterOut, actorId: p.userId,
      });
      const inn = await ledger.insertMovement(client, {
        clinicId: p.clinicId, productId: input.productId, locationId: input.toLocationId, batchId: batch?.id ?? null,
        movementType: 'TRANSFER', direction: 'in', quantity: input.quantity, counterpartyLocationId: input.fromLocationId,
        transferGroupId, reason: input.reason, reference: input.reference, balanceAfter: afterIn, actorId: p.userId,
      });
      await auditTx(client, { clinicId: p.clinicId, actorId: p.userId, action: 'inventory.stock.transfer', targetType: 'inventory_product', targetId: input.productId, metadata: { from: input.fromLocationId, to: input.toLocationId, quantity: input.quantity } });
      return { out, in: inn };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505' && input.idempotencyKey) {
      const won = await ledger.findByIdempotencyKey(p.clinicId, input.idempotencyKey);
      if (won?.transferGroupId) {
        const pair = await ledger.listByTransferGroup(p.clinicId, won.transferGroupId);
        const out = pair.find((m) => m.direction === 'out');
        const inn = pair.find((m) => m.direction === 'in');
        if (out && inn) return { out, in: inn };
      }
    }
    throw err;
  }
}
