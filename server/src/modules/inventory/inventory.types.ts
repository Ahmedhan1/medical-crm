/**
 * Inventory domain types (Agent 3). Numeric columns are returned by `pg` as
 * strings to avoid precision loss; repos convert them to `number` at the edge,
 * so every quantity/price here is a plain number.
 */

export type LocationKind = 'store' | 'dispensary' | 'room' | 'cold_chain' | 'other';
export type MovementType = 'RECEIVE' | 'ISSUE' | 'TRANSFER' | 'ADJUSTMENT' | 'RETURN';
export type MovementDirection = 'in' | 'out';

export interface InventoryLocation {
  id: string;
  clinicId: string;
  code: string;
  name: string;
  kind: LocationKind;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryProduct {
  id: string;
  clinicId: string;
  sku: string;
  name: string;
  category: string | null;
  unitOfMeasure: string;
  medicationProductId: string | null;
  isBatchTracked: boolean;
  isExpiryTracked: boolean;
  blockExpiredIssue: boolean;
  allowNegativeStock: boolean;
  reorderThreshold: number | null;
  reorderQuantity: number | null;
  isBillable: boolean;
  billingCode: string | null;
  unitPrice: number | null;
  unitCost: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryBatch {
  id: string;
  clinicId: string;
  productId: string;
  lotNumber: string;
  expiryDate: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StockBalance {
  id: string;
  clinicId: string;
  productId: string;
  locationId: string;
  batchId: string | null;
  onHand: number;
  version: number;
  updatedAt: string;
}

export interface StockMovement {
  id: string;
  clinicId: string;
  productId: string;
  locationId: string;
  batchId: string | null;
  movementType: MovementType;
  direction: MovementDirection;
  quantity: number;
  quantityDelta: number;
  counterpartyLocationId: string | null;
  transferGroupId: string | null;
  reason: string | null;
  reference: string | null;
  balanceAfter: number;
  actorId: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface CreateProductInput {
  sku: string;
  name: string;
  category?: string | null;
  unitOfMeasure?: string;
  medicationProductId?: string | null;
  isBatchTracked?: boolean;
  isExpiryTracked?: boolean;
  blockExpiredIssue?: boolean;
  allowNegativeStock?: boolean;
  reorderThreshold?: number | null;
  reorderQuantity?: number | null;
  isBillable?: boolean;
  billingCode?: string | null;
  unitPrice?: number | null;
  unitCost?: number | null;
}

export type UpdateProductInput = Partial<Omit<CreateProductInput, 'sku'>> & { isActive?: boolean };

export interface CreateLocationInput {
  code: string;
  name: string;
  kind?: LocationKind;
}

export type UpdateLocationInput = Partial<Omit<CreateLocationInput, 'code'>> & { isActive?: boolean };

export interface CreateBatchInput {
  productId: string;
  lotNumber: string;
  expiryDate?: string | null;
}
