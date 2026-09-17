# @medcore/web — MEDCORE Frontend Platform

React + Vite + TypeScript SPA. This package is the **shared platform foundation**
(Agent 1). Domain product UX (Clinical / AI / Pharma) is built on top by Agents
2/3/4 — see `../docs/platform/FRONTEND-INTEGRATION.md`.

## Quick start

```bash
npm ci
npm run dev          # http://localhost:5173, proxies /api → http://localhost:4000
npm run typecheck
npm test             # unit (vitest + @testing-library/react)
npm run build        # production bundle → dist/
npm run e2e          # Playwright shell E2E (routing/RBAC/RTL/API-error)
```

Run the backend separately (`cd ../server && npm run dev`) for a full stack.

## What's here

- **App shell / routing** — `src/App.tsx`, `src/main.tsx`, `src/components/layout`.
- **Auth / session / RBAC** — `src/lib/auth`, `src/components/auth/guards.tsx`.
- **API client** — `src/lib/api` (typed, error-normalized, cancellable, 401 fail-closed).
- **i18n + RTL** — `src/lib/i18n` (EN/AR, structural `dir` switching).
- **Design system** — `src/components/ui` (import from `@/components/ui`).
- **Extension points** — `src/lib/nav/registry.ts` (nav + routes), `registerMessages` (i18n).

## Guarantees

- Local-first: only same-origin `/api` calls; renders a handled offline state.
- Security: frontend permissions are UX only; the backend is authoritative. No PHI
  in URLs, storage, or telemetry.
