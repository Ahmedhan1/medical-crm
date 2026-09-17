import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetRegistry,
  getNavSections,
  getRoutes,
} from '../../../lib/nav/registry.js';
import { registerClinicalDomain } from '../register.js';

describe('clinical domain registration', () => {
  beforeEach(() => __resetRegistry());

  it('registers a clinical nav section in the clinical order band (10s)', () => {
    registerClinicalDomain();
    const section = getNavSections().find((s) => s.id === 'clinical');
    expect(section).toBeDefined();
    expect(section!.order).toBeGreaterThanOrEqual(10);
    expect(section!.order).toBeLessThan(20);
    expect(section!.items.map((i) => i.to)).toEqual(['/clinical/patients', '/clinical/queue']);
  });

  it('registers routes under the /clinical prefix with permission gates', () => {
    registerClinicalDomain();
    const routes = getRoutes().filter((r) => r.path.startsWith('/clinical'));
    const byPath = Object.fromEntries(routes.map((r) => [r.path, r.permission]));
    expect(byPath['/clinical/patients']).toBe('patient:search');
    expect(byPath['/clinical/patients/:id']).toBe('patient:read');
    expect(byPath['/clinical/queue']).toBe('queue:read');
  });

  it('every clinical nav item carries a permission (no un-gated clinical nav)', () => {
    registerClinicalDomain();
    const section = getNavSections().find((s) => s.id === 'clinical')!;
    expect(section.items.every((i) => typeof i.permission === 'string')).toBe(true);
  });
});
