# Agent 1 — Platform / Foundation / Governance — State

## Role
Platform Architect, Architecture Governance Lead, Platform Engineering Owner.
Owns platform architecture, shared contracts, DB/API/event conventions, auth/
authz/audit architecture, tenant isolation, i18n, observability, backup/recovery,
interoperability, dependency governance, release engineering, and integration/QA.
Does NOT build Agent 2–4 domain features.

## Current status
**Foundation (F001) done; integration (I001) done; platform Phase 1 done;
platform Phase 2 (Backup & Restore) done; Integration Gate I-3A done** on
`integration/medcore-v1`. Full suite green; migrations apply from empty.

## Integration Gate I-3A (2026-09-16)
Re-integrated all active agent branches (they had advanced past I001):
- Agent 2 (`inspiring-cori` → e42c4aa): CP-1..CP-9 patient lifecycle, scheduling,
  observation engine, allergy+safety, document references, Patient 360 (0104–0108).
- Agent 3 (`magical-gates` → 75b51c6): E2 scheduling/time engine + engine
  hardening + comms-quality guards; E3 AI governance gateway (classify → tenant
  policy → route → provider), PHI-local fail-closed (0201–0202).
- Agent 4 (`jolly-carson` → 2225465): P28/P29 disclosure control + query
  governance for the intelligence layer (0305).
All three merged **conflict-free** (parallel-safe seams held again). Migrations
0001→0901 (21 files) apply from empty → 86 tables; **583 tests / 46 files green**;
typecheck + build clean. Security audits (AI/clinical/pharma bypass, PHI-in-logs)
clean; integrated backup→restore recovery verified across all domains.
CCR decisions recorded: 006/007/009 (APPROVED; 007 impl deferred conservative),
008 (platform file-storage, deferred), 004 reaffirmed fail-closed. Arabic PDF
engine/font decision recorded (`PDF-ARABIC.md`).

## Platform Phase 2 — Backup & Restore (Priority 1)
Objectively the highest-priority incomplete risk (local-first with no recovery).
- `modules/backup` — `pg_dump` custom-format backups, optional AES-256-GCM
  at-rest encryption (dependency-free `node:crypto`), SHA-256 integrity,
  verify (checksum + archive readability), GFS retention selector, restore.
  Credentials passed via PG* env (never argv); no shell.
- `0901_backup.sql` — instance-level `backup_run` ledger (no PHI, no creds).
- Admin API `POST/GET /admin/backups`, `POST /admin/backups/:id/verify`
  (`backup:manage`, ADMIN) — **no download, no HTTP restore** by design.
- Operator CLI `npm run backup -- backup|list|verify|prune|restore` — restore is
  CLI-only; live-DB restore refused without `--yes`.
- New `permissions.platform.ts` (`backup:manage`) wired into the barrel.
- Config: `BACKUP_DIR`, `BACKUP_ENCRYPTION_KEY`, retention counts (validated).
- **Tested for real:** backup → drop/create fresh DB → restore → verified
  migrations, tables, a clinical row, RBAC catalog, append-only triggers and
  platform indexes all survive; encryption tamper/wrong-key detection; CLI smoke.
- Docs: `PRODUCTION-READINESS.md` (matrix + RPO/RTO + release gates), roadmap
  recovery runbook.

## History
- **F001 — Multi-agent foundation.** Parallel-safe seams (per-workstream
  permission/event files + barrels, four stable feature aggregators, disjoint
  migration ranges, dynamic test reset), orchestration docs.
- **I001 — Integration.** Merged Clinical/AI/Pharma into `integration/medcore-v1`
  (zero code conflicts). Reconciled the CCR ledger (CCR-001..005). Fixed the
  request-log PHI leak globally (CCR-002) and the ADMIN over-grant via pharma
  separation-of-duties roles (CCR-005). Full report: `docs/agent-state/integration.md`.

## Platform Phase 1 (this increment)
- **`docs/platform/PLATFORM-ROADMAP.md`** — audit findings (F-01..F-12) + 10-phase
  plan + authoritative platform conventions (migration ranges incl. new platform
  `0900–0999`, dependency allowlist, tenant/append-only/PHI rules).
- **Executable architecture governance** — `test/platform/governance.test.ts`:
  tenant tables carry `clinic_id` (explicit global allowlist); runtime deps within
  the approved allowlist (`fastify`,`pg`,`qrcode`,`zod`); migrations well-named,
  uniquely numbered, in reserved ranges; `event`/`audit_log` append-only. Drift
  now fails CI, not just review.
- **Performance (F-01)** — `0900_platform_indexes.sql` adds high-value
  `patient_id` (patient-history reads) and `clinic_id` (tenant filtering) indexes
  on child tables that lacked a leading index. Additive, `IF NOT EXISTS`, runs
  after all domain migrations. Low-value actor columns intentionally left
  unindexed.
- **Observability** — `GET /health/detailed`: DB reachability + latency, applied-
  migration count, uptime, node version. PHI-free; no auth (ops probe).

## Database / migrations
- 12 migrations apply cleanly from empty in order (0001, 0100–0103, 0200,
  0300–0304, **0900**) → 69 tables + platform indexes. Ranges reserved per
  `PLATFORM-ROADMAP.md`.

## Files owned / touched this phase
- Added: `docs/platform/PLATFORM-ROADMAP.md`, `test/platform/governance.test.ts`,
  `test/integration/observability.test.ts`, `src/db/migrations/0900_platform_indexes.sql`.
- Edited: `src/http/server.ts` (`/health/detailed`).

## Dependencies added
- None. Runtime deps unchanged (governance test enforces the allowlist).

## Contract changes
- None this phase. Reserved the platform migration range `0900–0999` (documented
  in the roadmap + enforced by the governance test).

## Known platform items (deferred, see roadmap)
- F-03 Arabic PDF (HIGH, Phase 5); F-04 backup/recovery (Phase 4); F-06 design
  system (Phase 2, after a frontend shell); F-07 i18n primitives (Phase 5);
  F-08 FHIR mapping (Phase 6); F-09 automation_offset scoping review (Agent 3);
  F-10 shared pagination; F-11 feature flags; F-12 CI wiring for the gates.

## What Agents 2–4 must keep honoring
- Migration ranges (theirs) + platform `0900–0999` (mine). New tenant tables MUST
  carry `clinic_id`. New runtime deps require a roadmap decision + allowlist entry
  (governance test enforces). Cross-workstream changes go through
  `CONTRACT_CHANGE_REQUEST.md`. No PHI in logs/QR/audit/event payloads.

## Next
Priority 2 — **Arabic / RTL document generation** (F-03): fix Arabic PDFs
(`????`) with an embedded OFL Unicode font + shaping, offline-capable. Then
Priority 3 (auth/session hardening + central pg-error redaction), Priority 4
(observability expansion), Priority 9 (CI wiring of the governance gates).

## Last commit
Set on push of the platform Phase-1 increment to `integration/medcore-v1`.
