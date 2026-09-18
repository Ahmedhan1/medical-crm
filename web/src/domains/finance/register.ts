import { registerNavSection, registerRoutes } from '../../lib/nav/registry.js';
import { registerFinanceMessages } from './i18n.js';
import { BillingDashboardPage } from './pages/BillingDashboardPage.js';
import { InvoiceListPage } from './pages/InvoiceListPage.js';
import { InvoiceCreatePage } from './pages/InvoiceCreatePage.js';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage.js';

/**
 * Finance/Billing domain registration (side-effect module). Self-registers i18n,
 * routes and nav via the platform extension points — no shared-file edit here.
 * Route/permission mapping mirrors the backend authority split (backend re-checks
 * every request; these are UX filters):
 *  - dashboard / reports: billing:report
 *  - invoice list + detail: billing:read
 *  - create invoice: invoice:create
 * The `/finance/*` prefix and nav order band (40s) are distinct from platform
 * (0–9), clinical (10s), ai (20s) and pharma (30s), so there is no collision.
 *
 * Activation needs one platform-entry import line in `web/src/main.tsx`
 * (Agent-1 coordination point — see CCR-016), exactly like the clinical domain.
 */
export function registerFinanceDomain(): void {
  registerFinanceMessages();

  registerRoutes([
    { path: '/finance', component: BillingDashboardPage, permission: 'billing:report' },
    { path: '/finance/invoices', component: InvoiceListPage, permission: 'billing:read' },
    { path: '/finance/invoices/new', component: InvoiceCreatePage, permission: 'invoice:create' },
    { path: '/finance/invoices/:id', component: InvoiceDetailPage, permission: 'billing:read' },
  ]);

  registerNavSection({
    id: 'finance',
    titleKey: 'finance.title',
    order: 40,
    items: [
      { to: '/finance', labelKey: 'finance.nav.dashboard', permission: 'billing:report' },
      { to: '/finance/invoices', labelKey: 'finance.nav.invoices', permission: 'billing:read' },
    ],
  });
}

registerFinanceDomain();
