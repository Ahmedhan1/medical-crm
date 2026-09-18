import { registerNavSection, registerRoutes } from '../../lib/nav/registry.js';
import { registerPharmaMessages } from './i18n.js';
import { PharmaDashboardPage } from './pages/PharmaDashboardPage.js';
import { MedicationsPage } from './pages/MedicationsPage.js';
import { MedicationDetailPage } from './pages/MedicationDetailPage.js';
import { PharmaContentPage } from './pages/PharmaContentPage.js';
import { PharmaReportsPage } from './pages/PharmaReportsPage.js';

/**
 * Pharma domain registration (side-effect module) — Agent 3. Wires the drug
 * master, approved content and reporting UI onto the existing pharma backend.
 * Reads use medication:read / content:read (the backend re-enforces; §45 keeps
 * patient data out of this domain).
 */
export function registerPharmaDomain(): void {
  registerPharmaMessages();

  registerRoutes([
    { path: '/pharma', component: PharmaDashboardPage, permission: 'medication:read' },
    { path: '/pharma/medications', component: MedicationsPage, permission: 'medication:read' },
    { path: '/pharma/medications/:id', component: MedicationDetailPage, permission: 'medication:read' },
    { path: '/pharma/content', component: PharmaContentPage, permission: 'content:read' },
    { path: '/pharma/reports', component: PharmaReportsPage, permission: 'medication:read' },
  ]);

  registerNavSection({
    id: 'pharma',
    titleKey: 'ph.title',
    order: 32,
    items: [
      { to: '/pharma', labelKey: 'ph.nav.dashboard', permission: 'medication:read' },
      { to: '/pharma/medications', labelKey: 'ph.nav.medications', permission: 'medication:read' },
      { to: '/pharma/content', labelKey: 'ph.nav.content', permission: 'content:read' },
      { to: '/pharma/reports', labelKey: 'ph.nav.reports', permission: 'medication:read' },
    ],
  });
}

registerPharmaDomain();
