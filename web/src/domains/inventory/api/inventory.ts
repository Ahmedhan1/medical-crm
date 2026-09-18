import { api } from '../../../lib/api/client.js';

/**
 * Inventory API layer — thin typed wrappers over the Agent-3 inventory backend.
 * No business logic here: the backend re-checks RBAC + tenant on every call and
 * owns all stock correctness (locking, negative-stock, expiry, idempotency).
 */
export type MovementType = 'RECEIVE' | 'ISSUE' | 'TRANSFER' | 'ADJUSTMENT' | 'RETURN';
export type LocationKind = 'store' | 'dispensary' | 'room' | 'cold_chain' | 'other';

export interface InventoryLocation {
  id: string; code: string; name: string; kind: LocationKind; isActive: boolean;
  createdAt: string; updatedAt: string;
}
export interface InventoryProduct {
  id: string; sku: string; name: string; category: string | null; unitOfMeasure: string;
  medicationProductId: string | null; isBatchTracked: boolean; isExpiryTracked: boolean;
  blockExpiredIssue: boolean; allowNegativeStock: boolean; reorderThreshold: number | null;
  reorderQuantity: number | null; isBillable: boolean; billingCode: string | null;
  unitPrice: number | null; unitCost: number | null; isActive: boolean;
  createdAt: string; updatedAt: string;
}
export interface InventoryBatch {
  id: string; productId: string; lotNumber: string; expiryDate: string | null;
  isActive: boolean; createdAt: string; updatedAt: string;
}
export interface StockBalanceRow {
  productId: string; productName: string; sku: string; locationId: string;
  locationName: string; batchId: string | null; lotNumber: string | null;
  expiryDate: string | null; onHand: number;
}
export interface StockMovement {
  id: string; productId: string; locationId: string; batchId: string | null;
  movementType: MovementType; direction: 'in' | 'out'; quantity: number; quantityDelta: number;
  counterpartyLocationId: string | null; transferGroupId: string | null;
  reason: string | null; reference: string | null; balanceAfter: number;
  actorId: string | null; occurredAt: string; createdAt: string;
}
export interface LowStockRow {
  productId: string; sku: string; name: string; unitOfMeasure: string;
  onHand: number; reorderThreshold: number; reorderQuantity: number | null;
}
export interface ValuationRow {
  productId: string; sku: string; name: string; onHand: number;
  unitCost: number | null; unitPrice: number | null; stockValue: number | null;
}

export interface CreateProductBody {
  sku: string; name: string; category?: string | null; unitOfMeasure?: string;
  isBatchTracked?: boolean; isExpiryTracked?: boolean; blockExpiredIssue?: boolean;
  allowNegativeStock?: boolean; reorderThreshold?: number | null; reorderQuantity?: number | null;
  isBillable?: boolean; billingCode?: string | null; unitPrice?: number | null; unitCost?: number | null;
}
export interface StockOpBody {
  productId: string; locationId: string; batchId?: string | null; quantity: number;
  reason?: string | null; reference?: string | null; idempotencyKey?: string | null;
}

// -- Products ----------------------------------------------------------------
export function listProducts(
  params: { q?: string; category?: string; includeInactive?: boolean; limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<InventoryProduct[]> {
  return api.get<{ products: InventoryProduct[] }>('/inventory/products', {
    query: { q: params.q, category: params.category, includeInactive: params.includeInactive, limit: params.limit, offset: params.offset },
    signal,
  }).then((r) => r.products);
}
export interface ProductDetail { product: InventoryProduct; balances: StockBalanceRow[]; batches: InventoryBatch[] }
export function getProduct(id: string, signal?: AbortSignal): Promise<ProductDetail> {
  return api.get<ProductDetail>(`/inventory/products/${id}`, { signal });
}
export function createProduct(body: CreateProductBody): Promise<InventoryProduct> {
  return api.post<InventoryProduct>('/inventory/products', body);
}
export function updateProduct(id: string, body: Partial<CreateProductBody> & { isActive?: boolean }): Promise<InventoryProduct> {
  return api.patch<InventoryProduct>(`/inventory/products/${id}`, body);
}

// -- Locations ---------------------------------------------------------------
export function listLocations(signal?: AbortSignal): Promise<InventoryLocation[]> {
  return api.get<{ locations: InventoryLocation[] }>('/inventory/locations', { signal }).then((r) => r.locations);
}
export function createLocation(body: { code: string; name: string; kind?: LocationKind }): Promise<InventoryLocation> {
  return api.post<InventoryLocation>('/inventory/locations', body);
}

// -- Batches -----------------------------------------------------------------
export function createBatch(body: { productId: string; lotNumber: string; expiryDate?: string | null }): Promise<InventoryBatch> {
  return api.post<InventoryBatch>('/inventory/batches', body);
}

// -- Stock operations --------------------------------------------------------
export function receiveStock(body: StockOpBody): Promise<StockMovement> { return api.post('/inventory/stock/receive', body); }
export function issueStock(body: StockOpBody): Promise<StockMovement> { return api.post('/inventory/stock/issue', body); }
export function returnStock(body: StockOpBody): Promise<StockMovement> { return api.post('/inventory/stock/return', body); }
export function adjustStock(body: StockOpBody & { direction: 'in' | 'out' }): Promise<StockMovement> { return api.post('/inventory/stock/adjust', body); }
export function transferStock(body: Omit<StockOpBody, 'locationId'> & { fromLocationId: string; toLocationId: string }): Promise<{ out: StockMovement; in: StockMovement }> {
  return api.post('/inventory/stock/transfer', body);
}

// -- Reporting ---------------------------------------------------------------
export function listMovements(
  params: { productId?: string; locationId?: string; movementType?: MovementType; limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<StockMovement[]> {
  return api.get<{ movements: StockMovement[] }>('/inventory/movements', { query: params, signal }).then((r) => r.movements);
}
export function lowStock(signal?: AbortSignal): Promise<LowStockRow[]> {
  return api.get<{ products: LowStockRow[] }>('/inventory/reports/low-stock', { signal }).then((r) => r.products);
}
export function valuation(signal?: AbortSignal): Promise<{ rows: ValuationRow[]; totalValue: number }> {
  return api.get<{ rows: ValuationRow[]; totalValue: number }>('/inventory/reports/valuation', { signal });
}
