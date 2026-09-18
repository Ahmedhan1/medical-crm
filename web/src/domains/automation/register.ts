import { registerNavSection, registerRoutes } from '../../lib/nav/registry.js';
import { registerAutomationMessages } from './i18n.js';
import { AutomationRulesPage } from './pages/AutomationRulesPage.js';
import { AutomationRuleDetailPage } from './pages/AutomationRuleDetailPage.js';
import { MessagingDeliveryPage } from './pages/MessagingDeliveryPage.js';

/**
 * Automation domain registration (side-effect module) — Agent 3. Wires the
 * operator UI for the existing automation engine + messaging pipeline. Route
 * permissions mirror the backend authority split (the backend re-checks every
 * request; these are UX filters):
 *  - rules list/detail + delivery log: automation:read / messaging:read
 *  - create/enable/disable/cancel/retry: automation:manage / messaging:manage
 * No clinical authority is surfaced; consent is enforced at delivery server-side.
 */
export function registerAutomationDomain(): void {
  registerAutomationMessages();

  registerRoutes([
    { path: '/automation/rules', component: AutomationRulesPage, permission: 'automation:read' },
    { path: '/automation/rules/:id', component: AutomationRuleDetailPage, permission: 'automation:read' },
    { path: '/automation/delivery', component: MessagingDeliveryPage, permission: 'messaging:read' },
  ]);

  registerNavSection({
    id: 'automation',
    titleKey: 'auto.title',
    order: 21,
    items: [
      { to: '/automation/rules', labelKey: 'auto.nav.rules', permission: 'automation:read' },
      { to: '/automation/delivery', labelKey: 'auto.nav.delivery', permission: 'messaging:read' },
    ],
  });
}

registerAutomationDomain();
