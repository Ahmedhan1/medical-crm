# Agent 1 — Platform / Foundation / Governance — State

## Role
Platform Architect, Architecture Governance Lead, Platform Engineering Owner.
Owns platform architecture, shared contracts, DB/API/event conventions, auth/
authz/audit architecture, tenant isolation, i18n, observability, backup/recovery,
interoperability, dependency governance, release engineering, and integration/QA.
Does NOT build Agent 2–4 domain features.

## Current status
**Consolidated baseline I-4 established** on `integration/medcore-v1` (tag
`baseline-i4`). F001, I001, platform P1/P2/P3, and integration gates I-3A + I-4
all done. Full suite green (698 tests / 53 files); 25 migrations apply from empty
→ 91 tables; typecheck + build clean; integrated backup→restore verified.

## Final Integration Gate I-7 (2026-09-17) — Agent 4 completion consolidated
Integrated Agent 4's **frozen** deliverable `2a2b5bb` onto the I-6 baseline
`659b285`. Agent 4 had merged the integration branch into their branch and then
**completed end-to-end the formerly-reserved WIP 0307–0311** plus two additive
audit-fix migrations (0313 site/department governance, 0314 signal decision trail).
Because `659b285` was a true ancestor, this integrated as a clean **fast-forward**
(no conflicts); every changed file is docs or pharma/HCP/intelligence-owned — all
platform/clinical/AI files verified byte-unchanged.
Now integrated: HCO organisation master + sites/departments with governance
(0307/0308/0313), field-force rep platform (0309), medical-affairs request
lifecycle (0310), intelligence signal lifecycle + decision trail (0311/0314).
Gate result: **37 migrations apply from empty → 107 tables** (pharma range now
0300–0314, no gap); **1110 tests / 74 files green, 0 failures, 0 skips**;
typecheck + build clean; backup → verify → restore round-trips all 107 tables.
Full cross-domain audit clean: pharma firewall holds (no clinical reads/writes,
94-test suite green); no cross-workstream imports; every new table carries
`clinic_id`; new decision-trail tables (`aggregated_signal_event`,
`scientific_request_event`, `visit_event`) are append-only; territory
authorization enforced (`assertHcpInScope`, cross-rep `ForbiddenError`); new
permissions (`hco:verify`/`hco:merge`, medical-affairs SoD) merge through the
barrel and are role-reachable; event payloads are shape-only (no PHI/PII); inline
service queries all carry `clinic_id`. Untouchable invariants confirmed intact:
`ABSOLUTE_MIN_COHORT = 5`, banding/suppression/query-budget/narrowing controls
(firewall/disclosure/query-governance files byte-unchanged), CCR-004 fail-closed
(501), E4 Action Guard + AI gateway/classification byte-unchanged.
**Flagged cross-domain item resolved as no gap:** pharma/intelligence expiry is
DERIVED at read (`pharma_effective_verification` / `pharma_effective_signal_status`
read `now()`), so a lapsed record reads as expired without any sweep; the sweeps
are admin-gated bookkeeping that only complete the audit trail, mirroring the
platform scheduler's own operator/worker-driven `runDueActions`. Recurring
auto-scheduling recorded as **CCR-011** (deferred operational enhancement, to be
done through Agent 3's scheduler if ever wanted — never a timer inside pharma). No
genuine code gaps found, so no fixes and no new tests were required; no new
dependency.

## Integration Gate I-6 (2026-09-16) — consolidation on I-5 baseline
Baseline `integration/medcore-v1` @ `f369d83` (I-5). Integrated ONLY the three
verified deliverables, in order Clinical → AI → Pharma, by cherry-pick (all three
branches had been rebased onto the `48a456b` merge-base, so cherry-pick applied
each clean increment onto `f369d83`; zero conflicts):
- **Agent 2** (`9f5a0f6`): clinical batch — procedures (0111), care plans (0112),
  referral SLA/expiry detection (0113), follow-up completion/cancellation events,
  and a pure internal FHIR mapping foundation (no endpoint, no migration).
- **Agent 3** (`16a1980`): AI & automation batch (A3-E5) — structured output
  schemas + versioning, eval harness, AI observability (0204), read-only AI tools,
  receptionist intents, automation dry-run simulation. AI writes stay confined to
  AI tables; read-only tools verified side-effect-free.
- **Agent 4** (`9abba3e` code + `c3dca78` docs): governed aggregate reporting and
  export (batch item 6) — export-policy core, report repo/service, export receipt
  ledger `pharma_export_log` (0312, append-only), per-report permission +
  territory scope + row caps.
**WIP intentionally NOT merged (directive):** Agent 4 branches `a4/hco`
(0307/0308), `a4/field-ma` (0309/0310), `a4/intel-lifecycle` (0311) — unverified
schema-only work. Confirmed absent from the tree; the pharma range keeps a
deliberate 0307–0311 gap reserved for them. Migration 0312 and all reporting code
were verified to reference only baseline pharma/intelligence tables (no WIP-table
dependency), so the gap is safe.
Gate result: **30 migrations apply from empty → 97 tables**; **831 tests / 65
files green**; typecheck + build clean; backup → verify → restore into a fresh DB
round-trips the full 97-table schema. Security audits all clean: no AI/pharma/
automation module reads or writes clinical tables; no cross-workstream imports;
AI writes only AI tables; pharma reporting reads only pharma/intelligence tables;
CCR-004 governed clinical read stays fail-closed (501); export authorization +
territory scope enforced; PHI absent from logs and event payloads; every new
table carries `clinic_id` and the export ledger is append-only. CCR ledger: no new
CCR required and none bypassed (Agent 2 recorded a review note only); no id
collisions this gate. No new features implemented; no new dependency.

## Platform Hardening Batch (I-5, 2026-09-16)
Six platform tasks, executed inline (all touch platform-owned files; three edit
`server.ts`, and all tests share one Postgres — parallel worktrees would race,
so sequential was safer):
1. **Auth/session hardening** — in-memory per-account lockout + per-IP login
   rate limit (`modules/auth/throttle.ts`), fail-closed, generic messages
   (no enumeration), 429 + Retry-After. Wired into `login`. Config-driven.
2. **DB/API error redaction (F-06 closed)** — central pino `err` serializer in
   `server.ts` logs type/code/message/stack only; drops pg `detail`/`where`/
   `parameters` (PHI). Clients still get the generic 500 envelope.
3. **CI** — `.github/workflows/ci.yml`: typecheck, build, migrate-from-empty,
   full suite (governance/security/backup/PDF) on a Postgres service + the
   Playwright image (real PDF regression). `npm audit` informational.
4. **Observability** — `/metrics` (bounded-cardinality, PHI-safe counters via an
   onResponse hook) + `/health/detailed` enriched with pool stats + last-backup.
5. **PDF/BOX** — bundled DejaVu (Latin) alongside Amiri for deterministic,
   offline cross-box rendering; determinism test; `MEDCORE-BOX.md` Chromium/font
   packaging audit.
6. **Backup CCR-008 gap** — audited: no document bytes exist yet (metadata-only),
   so nothing to back up; recorded the clean file-store→backup integration path;
   implementation deferred (safe).
Verified: full suite green, typecheck + build clean, migrations from empty,
security/PHI/observability tests. No new runtime dependency except
`playwright-core` (already in the governance allowlist from Phase 3); no new
migration. No CCRs opened; CCR-008 design extended.

## Integration Gate I-4 (2026-09-16) — consolidation
Re-audited all agent branches (they had advanced; Agent 3 had force-pushed a
rebase). Integrated the latest valid work, preserving every ownership boundary:
- **Agent 2** (`811db4f`): merged — P10 referrals (0109) + P11 follow-up
  detection (0110).
- **Agent 3** (`670e514`): E2/E3 were rebased to new SHAs but byte-identical to
  what I-3A already integrated (verified empty diff), so I **cherry-picked only
  the new E4** — AI Action Security Kernel (0203): identity → tool registry →
  permission → classification → risk → policy → confirmation → execute, with a
  single enforced execution boundary (`executeAiAction`); human-only
  `ai:identity-manage`/`ai:action-confirm` (never granted to AI).
- **Agent 4** (`238db90`): merged — P5–P7 HCP master hardening + verification
  lifecycle (0306).
- CCR ledger: resolved another id collision — Agent 4's new "Adverse Event
  Handoff" (their CCR-007) → **CCR-010**, kept **design/proposed only, NOT
  implemented** (directive §3; fail-closed port). CCR-007 (drug↔allergen) stays
  deferred/conservative.
Security audits (AI provider/tool bypass, AI/pharma→clinical writes, PHI-in-logs,
cross-workstream imports) all clean; pharma firewall + CCR-004 fail-closed intact.

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

## Platform Phase 3 — Arabic / RTL PDF (Priority 2) — DONE (pending visual sign-off)
Engine ratified by Platform owner: Chromium (`playwright-core`, optional/additive).
- `modules/platform/pdf/` — `renderHtmlToPdf` (bundled Chromium, offline,
  robust executable resolution), Amiri (OFL) Arabic subset vendored + data-URI
  embedded, RTL/LTR clinical document builder (fields/table/footer, bidi-aware,
  HTML-escaped). Existing Latin renderer untouched (default).
- `playwright-core` added to the dependency governance allowlist.
- 7 Arabic PDF tests: glyph ink > 0, Unicode round-trip, no `?`, multi-page,
  HTML-escaping, end-to-end. Real sample PDF delivered for human glyph sign-off;
  `PRODUCTION-READINESS` flips Arabic → Ready on that sign-off.
- Decision + verification recorded in `docs/platform/PDF-ARABIC.md`.

## Next (STOP per directive §21 — separate phases)
Priority 3 (auth/session hardening + central pg-error `detail` redaction),
Priority 4 (observability expansion), Priority 9 (CI wiring of governance gates),
then FHIR / frontend / MEDCORE BOX packaging (Chromium footprint) / DR.

## Last commit
Set on push of the platform Phase-1 increment to `integration/medcore-v1`.
