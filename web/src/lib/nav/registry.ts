import type { ComponentType } from 'react';

/**
 * Navigation + route registry — the extension point for Agents 2/3/4.
 *
 * A domain module registers its nav sections and routes at import time via
 * `registerNavSection` / `registerRoutes`; the shell renders whatever is
 * registered, filtered by the caller's permissions. This means domains NEVER edit
 * the sidebar or the router directly, so there are no shared-file merge conflicts
 * over navigation. Each domain owns a distinct `section.id` and route path prefix
 * (see docs/platform/FRONTEND-INTEGRATION.md for the ownership table).
 */
export interface NavItem {
  /** Route path, e.g. `/clinical/patients`. */
  to: string;
  /** i18n key for the label. */
  labelKey: string;
  /** Permission required to see this item (UX filter; backend still enforces). */
  permission?: string;
}

export interface NavSection {
  /** Unique per domain, e.g. `clinical`, `ai`, `pharma`, `platform`. */
  id: string;
  /** i18n key for the section heading. */
  titleKey: string;
  /** Lower sorts earlier. Platform reserves 0–9; clinical 10s; ai 20s; pharma 30s. */
  order: number;
  items: NavItem[];
}

export interface AppRoute {
  path: string;
  component: ComponentType;
  /** When set, the route is wrapped so it 403s without the permission. */
  permission?: string;
}

const sections = new Map<string, NavSection>();
const routes: AppRoute[] = [];

export function registerNavSection(section: NavSection): void {
  sections.set(section.id, section);
}

export function registerRoutes(list: AppRoute[]): void {
  routes.push(...list);
}

export function getNavSections(): NavSection[] {
  return [...sections.values()].sort((a, b) => a.order - b.order);
}

export function getRoutes(): AppRoute[] {
  return [...routes];
}

/** Test/isolation helper. */
export function __resetRegistry(): void {
  sections.clear();
  routes.length = 0;
}
