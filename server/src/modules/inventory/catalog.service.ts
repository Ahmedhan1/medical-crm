import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { audit } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { withTransaction } from '../../db/pool.js';
import * as repo from './inventory.repo.js';
import type {
  CreateBatchInput, CreateLocationInput, CreateProductInput, InventoryBatch,
  InventoryLocation, InventoryProduct, UpdateLocationInput, UpdateProductInput,
} from './inventory.types.js';

/** Detect a unique-constraint violation (duplicate SKU / code / lot). */
function isUnique(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// -- Locations ---------------------------------------------------------------
export async function createLocation(p: Principal, input: CreateLocationInput): Promise<InventoryLocation> {
  requirePermission(p, Permission.INVENTORY_MANAGE);
  if (!input.code?.trim() || !input.name?.trim()) throw new ValidationError('Location code and name are required');
  try {
    const loc = await repo.insertLocation(p.clinicId, p.userId, input);
    await audit({ clinicId: p.clinicId, actorId: p.userId, action: 'inventory.location.create', targetType: 'inventory_location', targetId: loc.id, metadata: { code: loc.code } });
    return loc;
  } catch (err) {
    if (isUnique(err)) throw new ConflictError('A location with this code already exists');
    throw err;
  }
}

export async function updateLocation(p: Principal, id: string, patch: UpdateLocationInput): Promise<InventoryLocation> {
  requirePermission(p, Permission.INVENTORY_MANAGE);
  const updated = await repo.updateLocation(p.clinicId, id, patch);
  if (!updated) throw new NotFoundError('Location');
  await audit({ clinicId: p.clinicId, actorId: p.userId, action: 'inventory.location.update', targetType: 'inventory_location', targetId: id });
  return updated;
}

export async function listLocations(p: Principal, includeInactive = false): Promise<InventoryLocation[]> {
  requirePermission(p, Permission.INVENTORY_READ);
  return repo.listLocations(p.clinicId, includeInactive);
}

export async function getLocation(p: Principal, id: string): Promise<InventoryLocation> {
  requirePermission(p, Permission.INVENTORY_READ);
  const loc = await repo.getLocation(p.clinicId, id);
  if (!loc) throw new NotFoundError('Location');
  return loc;
}

// -- Products ----------------------------------------------------------------
export async function createProduct(p: Principal, input: CreateProductInput): Promise<InventoryProduct> {
  requirePermission(p, Permission.INVENTORY_MANAGE);
  if (!input.sku?.trim() || !input.name?.trim()) throw new ValidationError('Product SKU and name are required');
  if (input.isExpiryTracked && input.isBatchTracked === false) {
    throw new ValidationError('An expiry-tracked product must also be batch-tracked');
  }
  return withTransaction(async (client) => {
    // If linked to the drug master, that product must belong to this clinic.
    if (input.medicationProductId) {
      const { rows } = await client.query(
        'SELECT 1 FROM medication_product WHERE id=$1 AND clinic_id=$2',
        [input.medicationProductId, p.clinicId],
      );
      if (rows.length === 0) throw new ValidationError('Linked medication product not found in this clinic');
    }
    try {
      const product = await repo.insertProduct(p.clinicId, p.userId, input, client);
      await audit({ clinicId: p.clinicId, actorId: p.userId, action: 'inventory.product.create', targetType: 'inventory_product', targetId: product.id, metadata: { sku: product.sku } });
      return product;
    } catch (err) {
      if (isUnique(err)) throw new ConflictError('A product with this SKU already exists');
      throw err;
    }
  });
}

export async function updateProduct(p: Principal, id: string, patch: UpdateProductInput): Promise<InventoryProduct> {
  requirePermission(p, Permission.INVENTORY_MANAGE);
  const existing = await repo.getProduct(p.clinicId, id);
  if (!existing) throw new NotFoundError('Product');
  const willExpiry = patch.isExpiryTracked ?? existing.isExpiryTracked;
  const willBatch = patch.isBatchTracked ?? existing.isBatchTracked;
  if (willExpiry && !willBatch) throw new ValidationError('An expiry-tracked product must also be batch-tracked');
  const updated = await repo.updateProduct(p.clinicId, id, patch);
  if (!updated) throw new NotFoundError('Product');
  await audit({ clinicId: p.clinicId, actorId: p.userId, action: 'inventory.product.update', targetType: 'inventory_product', targetId: id });
  return updated;
}

export async function getProduct(p: Principal, id: string): Promise<InventoryProduct> {
  requirePermission(p, Permission.INVENTORY_READ);
  const product = await repo.getProduct(p.clinicId, id);
  if (!product) throw new NotFoundError('Product');
  return product;
}

export async function searchProducts(
  p: Principal, s: { q?: string; category?: string; includeInactive?: boolean; limit?: number; offset?: number },
): Promise<InventoryProduct[]> {
  requirePermission(p, Permission.INVENTORY_READ);
  return repo.searchProducts(p.clinicId, {
    q: s.q, category: s.category, includeInactive: s.includeInactive,
    limit: Math.min(s.limit ?? 50, 200), offset: s.offset ?? 0,
  });
}

// -- Batches -----------------------------------------------------------------
export async function createBatch(p: Principal, input: CreateBatchInput): Promise<InventoryBatch> {
  requirePermission(p, Permission.INVENTORY_MANAGE);
  if (!input.lotNumber?.trim()) throw new ValidationError('Lot number is required');
  const product = await repo.getProduct(p.clinicId, input.productId);
  if (!product) throw new NotFoundError('Product');
  if (!product.isBatchTracked) throw new ValidationError('This product is not batch-tracked');
  if (product.isExpiryTracked && !input.expiryDate) throw new ValidationError('This product requires an expiry date on every batch');
  try {
    const batch = await repo.insertBatch(p.clinicId, p.userId, input);
    await audit({ clinicId: p.clinicId, actorId: p.userId, action: 'inventory.batch.create', targetType: 'inventory_batch', targetId: batch.id, metadata: { productId: product.id } });
    return batch;
  } catch (err) {
    if (isUnique(err)) throw new ConflictError('A batch with this lot number already exists for this product');
    throw err;
  }
}

export async function listBatches(p: Principal, productId: string): Promise<InventoryBatch[]> {
  requirePermission(p, Permission.INVENTORY_READ);
  return repo.listBatches(p.clinicId, productId);
}
