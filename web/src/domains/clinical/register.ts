import { registerNavSection, registerRoutes } from '../../lib/nav/registry.js';
import { registerClinicalMessages } from './i18n.js';
import { PatientsPage } from './pages/PatientsPage.js';
import { Patient360Page } from './pages/Patient360Page.js';
import { QueuePage } from './pages/QueuePage.js';

/**
 * Clinical domain registration (side-effect module). Wires the domain's i18n,
 * routes and nav into the platform via the shared extension points — no
 * shared-file edits. The platform shell renders these RBAC-filtered.
 *
 * Route/permission mapping mirrors the backend authority split exactly (the
 * backend re-checks on every request; these are UX filters):
 *  - patients list/search + 360 read: patient:search / patient:read (all clinical roles)
 *  - queue: queue:read (all clinical roles)
 *  - register / check-in actions: patient:register / encounter:checkin (reception)
 * No diagnosis/treatment/prescription authority is surfaced here.
 *
 * NOTE: for these routes to mount in the running app, the platform entry
 * (`web/src/main.tsx`) must import this module once. That single line is an
 * Agent-1 coordination point (see CCR-2025-CLIN-FE-01); this module performs no
 * shared-file edit itself.
 */
export function registerClinicalDomain(): void {
  registerClinicalMessages();

  registerRoutes([
    { path: '/clinical/patients', component: PatientsPage, permission: 'patient:search' },
    { path: '/clinical/patients/:id', component: Patient360Page, permission: 'patient:read' },
    { path: '/clinical/queue', component: QueuePage, permission: 'queue:read' },
  ]);

  registerNavSection({
    id: 'clinical',
    titleKey: 'clinical.title',
    order: 10,
    items: [
      { to: '/clinical/patients', labelKey: 'clinical.nav.patients', permission: 'patient:search' },
      { to: '/clinical/queue', labelKey: 'clinical.nav.queue', permission: 'queue:read' },
    ],
  });
}

// Register on import so a single `import './domains/clinical/register.js'` in the
// platform entry is all that is needed to activate the domain.
registerClinicalDomain();
