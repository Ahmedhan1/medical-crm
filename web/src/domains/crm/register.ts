import { registerNavSection, registerRoutes } from '../../lib/nav/registry.js';
import { registerCrmMessages } from './i18n.js';
import { HcpListPage } from './pages/HcpListPage.js';
import { HcpDetailPage } from './pages/HcpDetailPage.js';
import { HcoListPage } from './pages/HcoListPage.js';
import { VisitsPage } from './pages/VisitsPage.js';

/**
 * CRM domain registration (side-effect module) — Agent 3. Wires the HCP/HCO
 * relationship + field-visit UI onto the existing pharma backend. Read routes
 * use hcp:read / hco:read / visit:read (the backend re-enforces, and the §45
 * boundary guarantees no patient data is exposed here).
 */
export function registerCrmDomain(): void {
  registerCrmMessages();

  registerRoutes([
    { path: '/crm/hcps', component: HcpListPage, permission: 'hcp:read' },
    { path: '/crm/hcps/:id', component: HcpDetailPage, permission: 'hcp:read' },
    { path: '/crm/hcos', component: HcoListPage, permission: 'hco:read' },
    { path: '/crm/visits', component: VisitsPage, permission: 'visit:read' },
  ]);

  registerNavSection({
    id: 'crm',
    titleKey: 'crm.title',
    order: 34,
    items: [
      { to: '/crm/hcps', labelKey: 'crm.nav.hcps', permission: 'hcp:read' },
      { to: '/crm/hcos', labelKey: 'crm.nav.hcos', permission: 'hco:read' },
      { to: '/crm/visits', labelKey: 'crm.nav.visits', permission: 'visit:read' },
    ],
  });
}

registerCrmDomain();
