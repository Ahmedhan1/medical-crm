import { registerNavSection, registerRoutes } from '../../lib/nav/registry.js';
import { registerMessagingMessages } from './i18n.js';
import { WhatsAppSetupPage } from './pages/WhatsAppSetupPage.js';
import { ConsentPage } from './pages/ConsentPage.js';

/**
 * Messaging-setup domain registration (side-effect module) — Agent 3. WhatsApp
 * connection lifecycle + consent visibility. Route permissions mirror the backend
 * (re-checked per request):
 *  - status/consent read: messaging:read
 *  - pair/reconnect/disconnect: messaging:manage
 */
export function registerMessagingDomain(): void {
  registerMessagingMessages();

  registerRoutes([
    { path: '/messaging/whatsapp', component: WhatsAppSetupPage, permission: 'messaging:read' },
    { path: '/messaging/consent', component: ConsentPage, permission: 'messaging:read' },
  ]);

  registerNavSection({
    id: 'messaging',
    titleKey: 'msg.title',
    order: 22,
    items: [
      { to: '/messaging/whatsapp', labelKey: 'msg.nav.whatsapp', permission: 'messaging:read' },
      { to: '/messaging/consent', labelKey: 'msg.nav.consent', permission: 'messaging:read' },
    ],
  });
}

registerMessagingDomain();
