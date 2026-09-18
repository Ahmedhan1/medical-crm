import { registerNavSection, registerRoutes } from '../../lib/nav/registry.js';
import { registerAiMessages } from './i18n.js';
import { AiDraftsPage } from './pages/AiDraftsPage.js';
import { AiDraftDetailPage } from './pages/AiDraftDetailPage.js';
import { AiReceptionistPage } from './pages/AiReceptionistPage.js';
import { AiHealthPage } from './pages/AiHealthPage.js';

/**
 * AI domain registration (side-effect module) — Agent 3. Wires the review-first
 * AI UX. Route permissions mirror the backend authority split (re-checked per
 * request):
 *  - drafts review: ai:draft-review    - receptionist: ai:receptionist
 *  - eval health:   ai:eval-run
 * No autonomous clinical action is surfaced; confirming a draft is a human review
 * that does not write clinical data (CCR-001).
 */
export function registerAiDomain(): void {
  registerAiMessages();

  registerRoutes([
    { path: '/ai/drafts', component: AiDraftsPage, permission: 'ai:draft-review' },
    { path: '/ai/drafts/:id', component: AiDraftDetailPage, permission: 'ai:draft-review' },
    { path: '/ai/receptionist', component: AiReceptionistPage, permission: 'ai:receptionist' },
    { path: '/ai/health', component: AiHealthPage, permission: 'ai:eval-run' },
  ]);

  registerNavSection({
    id: 'ai',
    titleKey: 'ai.title',
    order: 20,
    items: [
      { to: '/ai/drafts', labelKey: 'ai.nav.drafts', permission: 'ai:draft-review' },
      { to: '/ai/receptionist', labelKey: 'ai.nav.receptionist', permission: 'ai:receptionist' },
      { to: '/ai/health', labelKey: 'ai.nav.health', permission: 'ai:eval-run' },
    ],
  });
}

registerAiDomain();
