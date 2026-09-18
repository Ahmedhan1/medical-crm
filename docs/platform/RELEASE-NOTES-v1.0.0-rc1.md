# MEDCORE v1.0.0-rc1 — Release Notes

Release candidate for the first production, customer-deliverable MEDCORE.

## Highlights (this production-closure release, Agent 1)
- **Production license system** (`server/src/license/**`): Ed25519 signed
  membership licenses; installation+tenant binding (anti-copy); offline grace;
  clock-rollback defense; clinical-core never gated; issuer CLI (private key stays
  vendor-side), operator CLI, and a read-only `GET /admin/license` admin endpoint.
- **Customer installer / operations**: cross-platform `install/bootstrap.mjs`
  (preflight → secure config → migrate → admin bootstrap), `install/medcorectl.mjs`
  (health/status/backup/restore/update/diagnostics), and Windows `vendor.bat`.
  Production admin bootstrap generates a one-time password.
- **Production build fix (blocker)**: `npm run build` now copies migration SQL and
  assets into `dist/` so the production artifact (`node dist/index.js`) boots.
- **Customer documentation** (`docs/customer/`): README/quick-start, Install,
  Operations, License, Admin & Security.

## Verified end-to-end
Fresh install → migrate (40 migrations → 107 tables) → admin bootstrap → service
boot → `/health` ok → admin login (110 permissions) → license status endpoint.

## Deployment
- Requirements & steps: `docs/customer/INSTALL.md`.
- Config: `server/.env` (generated). License: `docs/customer/LICENSE.md`.
- Migrations: 0001 / 0100–0114 / 0200–0205 / 0300–0315 / 0900–0901.

## Known limitations / not in this release (owned by other agents or post-v1)
- Domain UX for AI/Automation (Agent 3) and CRM/Pharma (Agent 4) frontends; full
  clinical UX QA (Agent 2) — backends are complete and tested.
- WhatsApp/GOWA pairing flow (Agent 3) — not implemented.
- In-memory auth throttle is single-box; document-byte backup deferred (CCR-008);
  Arabic PDF human visual sign-off not yet performed; feature-gate wiring deferred
  (CCR-014); online license-server component is a documented contract, not shipped.

See `docs/platform/RELEASE-READINESS-v1.md` for the full status matrix.
