import { registerNavSection, registerRoutes } from '../../lib/nav/registry.js';
import { registerInventoryMessages } from './i18n.js';
import { InventoryProductsPage } from './pages/InventoryProductsPage.js';
import { InventoryProductDetailPage } from './pages/InventoryProductDetailPage.js';
import { InventoryLocationsPage } from './pages/InventoryLocationsPage.js';
import { InventoryMovementsPage } from './pages/InventoryMovementsPage.js';
import { InventoryReportsPage } from './pages/InventoryReportsPage.js';

/**
 * Inventory domain registration (side-effect module) — Agent 3. Wires the
 * operator UI for the inventory/stock backend. Read routes need inventory:read;
 * stock mutations are gated per-action in the pages (the backend re-enforces
 * inventory:manage / stock:receive|issue|transfer|adjust on every request).
 */
export function registerInventoryDomain(): void {
  registerInventoryMessages();

  registerRoutes([
    { path: '/inventory/products', component: InventoryProductsPage, permission: 'inventory:read' },
    { path: '/inventory/products/:id', component: InventoryProductDetailPage, permission: 'inventory:read' },
    { path: '/inventory/locations', component: InventoryLocationsPage, permission: 'inventory:read' },
    { path: '/inventory/movements', component: InventoryMovementsPage, permission: 'inventory:read' },
    { path: '/inventory/reports', component: InventoryReportsPage, permission: 'inventory:read' },
  ]);

  registerNavSection({
    id: 'inventory',
    titleKey: 'inv.title',
    order: 30,
    items: [
      { to: '/inventory/products', labelKey: 'inv.nav.products', permission: 'inventory:read' },
      { to: '/inventory/locations', labelKey: 'inv.nav.locations', permission: 'inventory:read' },
      { to: '/inventory/movements', labelKey: 'inv.nav.movements', permission: 'inventory:read' },
      { to: '/inventory/reports', labelKey: 'inv.nav.reports', permission: 'inventory:read' },
    ],
  });
}

registerInventoryDomain();
