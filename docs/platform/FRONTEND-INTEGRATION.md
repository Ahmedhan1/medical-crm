# MEDCORE Frontend — Integration Protocol (Agent 1 platform → Agents 2/3/4)

The frontend lives in `web/` (React + Vite + TypeScript, npm). Agent 1 owns the
shared platform; Agents 2/3/4 build domain product UX **on top of it** without
duplicating infrastructure or editing shared files.

## Ownership

| Area | Owner | Path |
| --- | --- | --- |
| App shell, routing, layout, design system, API/auth/i18n/nav infra | Agent 1 | `web/src/{components,lib,styles,pages,App.tsx,main.tsx}` |
| Clinical UX | Agent 2 | `web/src/domains/clinical/**` + route prefix `/clinical/*` |
| AI / Automation / WhatsApp UX | Agent 3 | `web/src/domains/ai/**` + `/ai/*`, `/automation/*` |
| Pharma / HCP / Intelligence UX | Agent 4 | `web/src/domains/pharma/**` + `/pharma/*` |
| Backend | respective domain owners | `server/**` (unchanged by frontend work) |

Rule: never edit another workstream's folder, and never edit an Agent-1 shared
file to add a domain concern — use the extension points below.

## How to add a domain workspace (no shared-file edits)

1. Create `web/src/domains/<domain>/register.ts`:
   ```ts
   import { registerNavSection, registerRoutes } from '../../lib/nav/registry';
   import { registerMessages } from '../../lib/i18n/I18nContext';

   registerMessages('en', { 'clinical.patients': 'Patients' });
   registerMessages('ar', { 'clinical.patients': 'المرضى' });

   registerRoutes([
     { path: '/clinical/patients', component: PatientsPage, permission: 'patient:read' },
   ]);
   registerNavSection({
     id: 'clinical',            // unique per domain
     titleKey: 'clinical.title',
     order: 10,                 // bands: platform 0–9, clinical 10s, ai 20s, pharma 30s
     items: [{ to: '/clinical/patients', labelKey: 'clinical.patients', permission: 'patient:read' }],
   });
   ```
2. Import it once in `web/src/main.tsx`'s domain-registration block — the ONE
   coordinated line per domain, added via Agent 1 (a one-line, conflict-free merge).
   The shell then renders the nav (RBAC-filtered) and routes automatically.

## Shared components (use, don't fork)

Import everything from the barrels:
- UI: `import { Button, Input, Table, Dialog, Drawer, Tabs, Badge, Alert, EmptyState, ErrorState, Skeleton, Pagination, useToast } from '@/components/ui'` (path: `web/src/components/ui`).
- Layout: `PageHeader` from `web/src/components/layout/PageHeader`.
- Auth/RBAC: `useAuth()`, `<PermissionGate permission="...">`, `<ProtectedRoute>`.
- Data: `useQuery(fetcher, deps)` + the `api` client from `web/src/lib/api`.
- i18n/format: `useI18n()`, `formatDate/formatDateTime/formatNumber`.

Need a new shared primitive? Propose it to Agent 1; do not add it to a domain
folder (that recreates the duplication this platform exists to prevent).

## API contract expectations

- All calls go through `web/src/lib/api/client.ts` (`api.get/post/...`). It attaches
  the bearer token, normalizes errors to `ApiError`, surfaces `request_id`, cancels
  via `AbortSignal`, and fails closed on 401. Never call `fetch` directly.
- Backend base path is `/api` (dev proxy; same-origin in the BOX). No CORS.
- Error envelope is `{ error: { code, message, details?, request_id } }`.
- **PHI safety:** identifiers go in the path or JSON body, never in a query string;
  no PHI in `localStorage`, telemetry, or console. Authorization shown in the UI is
  a convenience only — the backend is authoritative on every request.

## Migration ownership

Frontend adds no migrations. Backend migration ranges are unchanged (clinical
0100s, AI 0200s, pharma 0300s, platform 0900s). A frontend need that requires a
backend change goes through the **CCR process** in `CONTRACT_CHANGE_REQUEST.md` —
never a silent backend edit.

## Merge / integration process

- Branch per agent off `integration/medcore-v1`; Agent 1 integrates.
- Domain work touches only that domain's folder + its one registration import.
- Shared changes (design system, shell, API client, i18n platform strings) are
  Agent 1's; request them via CCR/coordination, never overwrite.
- CI (`web` job) must stay green: typecheck, unit tests, build, shell E2E.

## Commands

```
cd web
npm ci
npm run dev        # Vite dev server (proxies /api → http://localhost:4000)
npm run typecheck
npm test           # unit (vitest + testing-library)
npm run build      # production bundle
npm run e2e        # Playwright shell E2E (set MEDCORE_E2E_BACKEND=1 for full-stack)
```
