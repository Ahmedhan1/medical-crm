import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRegistry,
  getNavSections,
  getRoutes,
  registerNavSection,
  registerRoutes,
} from './registry.js';

beforeEach(() => __resetRegistry());

describe('nav/route registry (domain extension point)', () => {
  it('sorts sections by order band so domains never edit the shell', () => {
    registerNavSection({ id: 'pharma', titleKey: 'p', order: 30, items: [] });
    registerNavSection({ id: 'platform', titleKey: 'x', order: 0, items: [] });
    registerNavSection({ id: 'clinical', titleKey: 'c', order: 10, items: [] });
    expect(getNavSections().map((s) => s.id)).toEqual(['platform', 'clinical', 'pharma']);
  });

  it('accumulates routes registered by domains', () => {
    const C = () => null;
    registerRoutes([{ path: '/clinical/patients', component: C, permission: 'patient:read' }]);
    registerRoutes([{ path: '/pharma/hcp', component: C }]);
    const paths = getRoutes().map((r) => r.path);
    expect(paths).toContain('/clinical/patients');
    expect(paths).toContain('/pharma/hcp');
  });
});
