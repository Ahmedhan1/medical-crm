# MEDCORE — Production Readiness Matrix

Living matrix (directive §40). A component is **Ready** only with tested
evidence. "Partial" = implemented + tested but incomplete for full production.
"Planned" = designed, not built. Nothing is marked Ready without evidence.

| Area | Status | Evidence | Risk | Owner |
| --- | --- | --- | --- | --- |
| Database schema | Ready | 12→14 migrations apply from empty; 70 tables; append-only triggers, CHECK constraints | Low | A1 |
| Migrations (integrity) | Ready | checksum-guarded runner; governance test enforces naming/ranges | Low | A1 |
| **Backup** | Ready | `createBackup` (pg_dump custom + checksum + optional AES-256-GCM); round-trip + CLI tested | Low | A1 |
| **Restore** | Ready | tested restore into a fresh DB — migrations, tables, a clinical row, RBAC, triggers, indexes all survive; CLI restore + live-restore refusal | Low | A1 |
| Backup security | Ready | creds via PG* env (never argv); no download/restore HTTP endpoint; artifacts gitignored; PHI-free ledger; audited | Low | A1 |
| Authentication | Ready | scrypt+pepper, opaque hashed sessions, logout revocation, enumeration-resistant login, **per-account lockout + per-IP login rate limit (fail-closed, 429+Retry-After)** | in-memory throttle (single-box); multi-instance needs a shared store | A1 |
| Authorization (RBAC) | Ready | per-permission catalog; ADMIN=all; pharma SoD roles; negative-authz tests | Low | A1 |
| Tenant isolation | Ready | every domain table `clinic_id`; governance test; cross-clinic 404 tests | Low | A1 |
| PHI logging | Ready | global query-string redaction + header redaction + **central error serializer strips pg detail/where/parameters** (F-06 closed); serializer + audit tests | A1 |
| Observability | Ready (core) | `/health` (liveness), `/health/detailed` (db latency, migration count, pool stats, backup status), `/metrics` (bounded-cardinality, PHI-safe) | tracing/provider-health later | A1 |
| CI | Ready | `.github/workflows/ci.yml`: typecheck, build, migrate-from-empty (pg reset, no psql), full suite (governance/security/backup/PDF) on Postgres + Playwright image; required checks documented in `CI-REQUIRED-CHECKS.md` | wire required-checks in repo settings | A1 |
| PDF / Latin | Ready | Agent 2 base-14 renderer (unchanged, default) | Low | A2 |
| PDF / Arabic (RTL) | Implemented — pending visual sign-off | Chromium+Amiri(OFL) renderer; 7 tests: glyph ink + Unicode round-trip + no `?` + multi-page; sample sent for human sign-off | flips to Ready on sign-off; adds Chromium to BOX (Phase 11) | A1 |
| Error contract | Ready | consistent `{error:{code,message,details,request_id}}`; internals never leaked; opaque per-request UUID on every response (`x-request-id`) and in every envelope, logged as `reqId` for traceability | Low | A1 |
| Security headers | Ready | static PHI-free set on every response — strict CSP (`default-src 'none'`), `X-Frame-Options: DENY`, nosniff, `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`, HSTS; no dependency (Phase 0) | Low | A1 |
| Membership / BOX foundation | Foundation (contract) | `modules/platform/entitlement`: Ed25519 signed-entitlement verify (fail-closed), offline grace, installation+tenant binding, feature gate that never gates `core:*`; pure logic + 21 tests, unwired | cloud plane, persistence, installer = Final phase; wiring gated by CCR-014 | A1 |
| Configuration | Ready | zod-validated fail-fast config incl. backup; prod refuses placeholder pepper | Low | A1 |
| Frontend | Planned | none exists | n/a until Priority 5 | A1 |
| Design system | Planned | none (no client yet) | n/a until Priority 6 | A1 |
| FHIR | Planned | naming-aligned only | Priority 7 | A1 |
| Performance | Partial | high-value indexes added; no load testing | Priority 10 | A1 |
| Deployment / BOX | Planned | single-host run works; no packaging | Priority 11 | A1 |
| Upgrade | Partial | forward-only migrate-on-boot; backup-before-upgrade now possible | rollback flow not automated (Priority 12) | A1 |
| Disaster recovery | Partial | verified restore exists; full DR drill not scripted | Priority 12 | A1 |

## RPO / RTO (operational targets — configurable, not guarantees)

These are **targets to be measured per deployment**, not guarantees. MEDCORE
provides the mechanism (scheduled backups + verified restore); the clinic sets
and validates the numbers on its own hardware.

- **RPO (Recovery Point Objective):** bounded by backup frequency. Default
  guidance: at least daily scheduled backups → RPO ≤ 24h; a clinic wanting a
  tighter RPO increases frequency (e.g. hourly). The retention policy
  (`BACKUP_RETAIN_DAILY/WEEKLY/MONTHLY`, default 7/4/3) governs history depth.
- **RTO (Recovery Time Objective):** dominated by `pg_restore` time for the DB
  size on the target hardware. On the test dataset a full restore completes in
  ~1–2s; a real clinic must measure against its own data volume and record the
  number here. Restore is a single operator command (`npm run backup -- restore
  <id> --target <url>`).

## Release gates (directive §41) — current status

| Gate | Status |
| --- | --- |
| clean migration / build / full tests | PASS (see phase report) |
| tenant isolation / RBAC / PHI-leak tests | PASS |
| backup test / restore test | PASS (this phase) |
| Arabic PDF test | PASS — implemented (Chromium+Amiri); 7 tests green; visual sign-off pending |
| auth security test (rate-limit/lockout) | PASS — lockout + IP rate limit tested; error-redaction (pg detail) tested |
| prod config validation / health-readiness / error redaction | PARTIAL |
| deployment / upgrade / rollback tests | not yet (Priority 11/12) |

## Consolidated baseline I-9 (2026-09-17) — current source of truth

Final integration + production-readiness gate. Three latest VERIFIED completion
branches consolidated on `integration/medcore-v1` by clean cherry-pick (Clinical
`7aac579`, AI `f6877be`, Pharma `f5ecfc1`).

- **Migrations:** 40 apply from empty in order (0001 / 0100–0114 / 0200–0205 /
  0300–0315 / 0900–0901) → **107 tables**. No duplicates, no gaps.
- **Tests:** **1243 / 83 files green, 0 failures, 0 skips**; typecheck + build clean.
- **Integrated recovery:** backup → verify (checksum + archive) → restore into a
  fresh DB round-trips all 107 tables.
- **New this gate:** vital/observation append-only (0114) + merged-patient guards
  (Agent 2); message-retry race/bypass fixes + AI-identity-scope validation (0205,
  Agent 3); drug-master product verification end-to-end + free-text governance
  screening (0315, Agent 4).
- **Cross-domain audit:** no workstream reads/writes clinical tables; no illegal
  cross-workstream imports; new tables tenant-scoped; decision/lifecycle tables
  append-only; territory authz, export permission + read permission, HCP/HCO/
  product provenance + verification all enforced.
- **Invariants (byte-unchanged, re-verified):** cohort floor = 5, banding/
  suppression/query budgets, CCR-004 fail-closed (501), E4 Action Guard, AI gateway
  + classification. "AI never holds a human RBAC permission" now a validated
  invariant.
- **Scheduler/expiry:** four admin-gated sweeps (HCO/HCP/medication/signal); no
  fake scheduler; expiry DERIVED at read (fail-safe). Wiring to Agent 3's scheduler
  stays CCR-011 (deferred, not bypassed).
- **CCRs:** collision resolved (Agent 4 CCR-011 → CCR-013); CCR-012 added; ledger
  now 001–013 with no duplicates. CCR-003/004/007/008/010/011/012/013 remain
  PROPOSED/deferred as recorded; nothing silently closed.

## Consolidated baseline I-7 (2026-09-17) — current source of truth

Final integration of Agent 4's frozen deliverable (`2a2b5bb`) onto I-6 (`659b285`)
as a clean fast-forward. All four workstreams are now fully consolidated on
`integration/medcore-v1`.

- **Migrations:** 37 apply from empty in order (0001 / 0100–0113 / 0200–0204 /
  0300–0314 / 0900–0901) → **107 tables**. Pharma range 0300–0314 is now complete
  (the earlier 0307–0311 reservation is filled and verified end-to-end).
- **Tests:** **1110 / 74 files green, 0 failures, 0 skips**; typecheck + build clean.
- **Integrated recovery (§6):** backup → verify (checksum + archive) → restore into a
  fresh DB round-trips all 107 tables, including HCO master/sites/departments, field
  force, medical affairs, and the signal lifecycle + decision trail.
- **Newly integrated (Agent 4):** HCO organisation master + site/department
  governance (0307/0308/0313), field-force rep platform (0309), medical-affairs
  request lifecycle (0310), intelligence signal lifecycle + decision trail
  (0311/0314). Ten pre-existing pharma audit findings closed within Agent 4's domain.
- **Cross-domain audit (this gate):** pharma firewall holds (94 firewall tests +
  21 red-team tests green; no clinical reads/writes; no cross-workstream imports);
  every new table tenant-scoped; new decision-trail tables append-only; territory
  authorization enforced; new permissions role-reachable via the barrel; event
  payloads shape-only; inline service queries carry `clinic_id`.
- **Invariants confirmed intact:** cohort floor = 5, banding/suppression/query
  budgets (files byte-unchanged), CCR-004 fail-closed (501), E4 Action Guard + AI
  gateway/classification byte-unchanged.
- **Expiry scheduling (known item) — no gap:** expiry is DERIVED at read
  (`pharma_effective_verification` / `pharma_effective_signal_status`), so lapsed
  records read as expired with no sweep; sweeps are admin-gated audit-trail
  bookkeeping, driven the same operator/worker way as the platform's own scheduler.
  Recurring auto-scheduling deferred as **CCR-011** (via Agent 3's scheduler if ever
  wanted; never a timer inside pharma).
- **CCRs:** no ledger conflicts; added CCR-011 (expiry-sweep scheduling contract,
  design-only). CCR-004/007/008/010 unchanged; disclosure controls untouched.

## Consolidated baseline I-6 (2026-09-16) — current source of truth

On `integration/medcore-v1`, on the I-5 hardening baseline (`f369d83`). Integrated
the three verified workstream deliverables (Clinical `9f5a0f6`, AI/automation
`16a1980`, Pharma reporting/export `9abba3e`+`c3dca78`) by clean cherry-pick.

- **Migrations:** 30 apply from empty in order (0001 / 0100–0113 / 0200–0204 /
  0300–0306 / **0312** / 0900–0901) → **97 tables**. The pharma range keeps a
  deliberate **0307–0311 gap** reserved for Agent 4's unverified WIP (HCO master,
  field force, medical affairs, intelligence lifecycle) — those branches were
  **NOT merged**.
- **Tests:** **831 / 65 files green**; typecheck + build clean.
- **Integrated recovery (§6):** backup → verify (checksum + archive) → restore into
  a fresh DB round-trips all 97 tables, including the new `procedure`, `care_plan`,
  `ai_eval_run`, and `pharma_export_log`.
- **Security (verified this gate):** no AI/pharma/automation module reads or writes
  clinical tables; no cross-workstream imports; AI writes only AI-owned tables;
  pharma reporting reads only pharma/intelligence tables; CCR-004 governed clinical
  read stays fail-closed (501); export enforces per-report permission + territory
  scope + row caps and writes an append-only receipt (`pharma_export_log`); PHI
  absent from logs and event payloads; every new table carries `clinic_id`.
- **CCRs:** no new CCR required, none bypassed, no id collisions (Agent 2 recorded a
  clinical-batch review note only). CCR-004 fail-closed, CCR-007/CCR-010 unchanged.

## Consolidated baseline I-4 (2026-09-16) — current source of truth

Tag `baseline-i4`. All four workstreams consolidated on `integration/medcore-v1`.
Adds since I-3A: Agent 2 referrals + follow-up detection (0109–0110); Agent 3
**E4 AI Action Security Kernel** (0203, cherry-picked — E2/E3 already integrated);
Agent 4 HCP master hardening + verification lifecycle (0306).

- **Migrations:** 25 apply from empty in order (0001 / 0100–0110 / 0200–0203 /
  0300–0306 / 0900–0901) → **91 tables**. Ranges respected, no duplicates.
- **Tests:** **698 / 53 files green**; typecheck + build clean.
- **Integrated recovery (§6):** `backup.test.ts` green against the 91-table
  schema — backup → fresh DB → restore preserves migrations, table count, a
  clinical row, RBAC catalog, append-only triggers, platform indexes, and
  cross-domain tables.
- **Security (verified this gate):** AI actions run only through the E4
  `executeAiAction` guard (authorize→[confirm]→execute; deny/confirm never
  execute; args never logged); AI tool/provider access has no bypass; no AI or
  pharma module reads/writes clinical tables; PHARMA_REP isolation + query
  governance + cohort banding intact; CCR-004 clinical source and CCR-010
  adverse-event handoff both remain fail-closed / not implemented.
- **CCRs:** CCR-010 (adverse-event handoff) recorded design-only; CCR-007
  (drug↔allergen) reaffirmed deferred/conservative.

## Integration baseline I-3A (2026-09-16)

All active agent branches integrated into `integration/medcore-v1`
(Agent 2 CP-1..CP-9 + Patient 360; Agent 3 E2 scheduling/hardening + E3 AI
governance; Agent 4 P28/P29 disclosure control + query governance).

- **Migrations:** 21 apply from empty in order (0001 / 0100–0108 / 0200–0202 /
  0300–0305 / 0900–0901) → **86 tables**. Ranges respected, no duplicates.
- **Tests:** **583 / 46 files green**; typecheck + build clean.
- **Integrated recovery:** backup → fresh DB → restore verified that migrations,
  table count, a clinical row, RBAC catalog, append-only triggers, platform
  indexes, and representative clinical/AI/pharma tables (`appointment`, `allergy`,
  `ai_generation`, `aggregated_signal`, `backup_run`) all survive.
- **Security (verified statically + by tests):** no AI/pharma/intelligence module
  reads or writes clinical tables; AI writes only `ai_draft`/`ai_generation`/
  `tenant_ai_policy`; E3 gateway enforces PHI-local fail-closed; CCR-004 clinical
  source still refuses (501); intelligence now bands cohort size (CCR-009).
- **Backup-scope caveat (CCR-008):** document *bytes* are stored outside Postgres
  (metadata-only today), so the DB backup does not yet cover document blobs — the
  future platform file-store must ship with its own backup before documents are
  used for primary storage.
- **Arabic/RTL PDF:** decision recorded (`PDF-ARABIC.md`); implementation is the
  next increment, gated on engine-footprint ratification + human visual sign-off.
  Still **Not Ready**.
