import { registerNavSection } from './lib/nav/registry.js';

/**
 * Platform-owned navigation (order band 0–9). Domain modules register their own
 * sections in their own files; this keeps the sidebar free of merge conflicts.
 */
registerNavSection({
  id: 'platform',
  titleKey: 'app.name',
  order: 0,
  items: [{ to: '/', labelKey: 'nav.dashboard' }],
});
