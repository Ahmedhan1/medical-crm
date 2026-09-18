import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import * as ledger from './stock.repo.js';
import type { MovementType, StockMovement } from './inventory.types.js';

/** On-hand balances (optionally filtered), joined with product/location/batch. */
export function listBalances(
  p: Principal, filter: { productId?: string; locationId?: string; onlyPositive?: boolean } = {},
): Promise<ledger.BalanceRow[]> {
  requirePermission(p, Permission.INVENTORY_READ);
  return ledger.listBalances(p.clinicId, filter);
}

/** The append-only movement ledger, filtered + paginated. */
export function listMovements(
  p: Principal,
  q: { productId?: string; locationId?: string; batchId?: string; movementType?: MovementType; limit?: number; offset?: number } = {},
): Promise<StockMovement[]> {
  requirePermission(p, Permission.INVENTORY_READ);
  return ledger.listMovements(p.clinicId, {
    productId: q.productId, locationId: q.locationId, batchId: q.batchId, movementType: q.movementType,
    limit: Math.min(q.limit ?? 50, 200), offset: q.offset ?? 0,
  });
}

/** Products at or below their persisted reorder threshold. */
export function lowStock(p: Principal): Promise<ledger.LowStockRow[]> {
  requirePermission(p, Permission.INVENTORY_READ);
  return ledger.lowStock(p.clinicId);
}

/** Per-product on-hand and stock value (valuation report). */
export async function valuation(
  p: Principal,
): Promise<{ rows: ledger.ValuationRow[]; totalValue: number }> {
  requirePermission(p, Permission.INVENTORY_READ);
  const rows = await ledger.valuation(p.clinicId);
  const totalValue = rows.reduce((sum, r) => sum + (r.stockValue ?? 0), 0);
  return { rows, totalValue };
}
