# MEDCORE — Platform Roadmap

Owner: Agent 1 (Platform Architect / Architecture Governance). This document is
the phased plan for evolving MEDCORE from an integrated clinic system into a
global-ready, local-first Healthcare Operating System. It is grounded in an
audit of the **actual** integrated codebase (`integration/medcore-v1`), not the
documentation.

Guiding constraint: **local-first + cloud-optional + offline-capable + secure +
auditable + extensible + global-ready.** The platform supports Agents 2–4; it
does not compete with them on domain features.

---

## Phase 1 — Platform audit (findings)

Measured on the integrated tree: 13 modules, 16 route files, 4 feature
aggregators, 11 migrations → **69 tables**, 28 test files (**360 tests green**),
~18k LOC of `src`.

### Strengths (keep)
- **Parallel-safe seams held under load.** Per-workstream permission/event files
  + barrels, four stable feature aggregators, disjoint migration ranges — four
  agents merged with zero code conflicts. This is the platform's core asset.
- **Dependency discipline.** Only 4 runtime deps: `fastify`, `pg`, `qrcode`,
  `zod`. No ORM, no bloat. Keep this bar.
- **Governance in the schema, not just code.** Append-only triggers
  (`event`, `audit_log`, `clinical_note`, `treatment_response`,
  `prescription_item`, `*_revision`), immutable `prescription`, min-cohort CHECKs
  on intelligence tables, `verified ⇒ last_verified_at`.
- **Tenant scoping is consistent.** Every domain data table carries `clinic_id`;
  the only tables without it are legitimately global (org/clinic, RBAC catalog,
  session, `schema_migrations`, `automation_offset`).
- **PHI discipline.** Global request-log serializer strips query strings; audit
  metadata and event payloads carry ids/vocab/counts only.

### Findings (prioritized)

| # | Finding | Severity | Phase |
| --- | --- | --- | --- |
| F-01 | ~80 foreign keys lack a backing index. Most are low-value actor columns, but `patient_id`/`clinic_id` on child tables drive real tenant + patient-history reads. | HIGH (perf) | 1 (this increment: high-value subset) |
| F-02 | No executable architecture-governance guardrails — drift (a tenant table without `clinic_id`, an un-vetted dependency, a mis-numbered migration, an append-only regression) would only be caught by review. | HIGH (governance) | 1 (this increment) |
| F-03 | PDF reports render Arabic as `????` (base-14/WinAnsi). Blocks Egypt patient-facing reports. | HIGH (i18n) | 5 |
| F-04 | No backup/restore engine; "local-first" reliability is unproven. | HIGH | 4 |
| F-05 | `/health` is shallow (single `SELECT 1`); no component/observability surface. | MEDIUM | 1 (this increment) + 8 |
| F-06 | No design system / frontend shell exists yet; workstreams are API-only. Building one now would be speculative. | MEDIUM | 2 (after a frontend shell decision) |
| F-07 | No i18n/currency/date-format platform primitives; locale handling is implicit. Core defaults (`country=EG`, `Africa/Cairo`) are configurable per org/clinic (good) but there is no shared locale/format layer. | MEDIUM | 5 |
| F-08 | No FHIR-facing mapping layer; internal model is FHIR-aligned in naming only. | MEDIUM | 6 |
| F-09 | `automation_offset` is not clinic-scoped — verify the cross-clinic processing model is intentional (Agent 3 owned). | LOW (review) | 10 (governance review) |
| F-10 | No shared pagination/filtering contract; each workstream rolls its own (keyset in timeline, ad-hoc `?limit` elsewhere). Works, but inconsistent. | LOW | 7 |
| F-11 | No feature-flag or central config service; behavior toggles would be ad-hoc. | LOW | 7 |
| F-12 | No CI wiring for the governance/security gates (they run locally only). | MEDIUM | 9 |

---

## Phased plan

Each phase ends with: test · typecheck · build · document · commit · push.
"Implemented now" = delivered in this increment; everything else is planned.

### Phase 1 — Platform hardening & governance *(in progress)*
- **Executable architecture governance** (`test/platform/governance.test.ts`): tenant
  tables carry `clinic_id` (explicit global allowlist); runtime dependencies within
  an approved allowlist; migrations well-named, uniquely numbered, in-range;
  platform append-only invariants (`event`, `audit_log`) enforced. *(implemented now)*
- **Performance: high-value indexes** (`0900_platform_indexes.sql`, reserved
  platform range): add `patient_id` and `clinic_id` indexes on child tables that
  drive tenant/patient reads. Additive, `IF NOT EXISTS`, runs after all domain
  migrations. *(implemented now)*
- **Observability: `/health/detailed`** — DB reachability + latency, applied
  migration count, node/uptime. No PHI. *(implemented now)*

### Phase 2 — Design system (deferred until a frontend shell exists)
No client app exists yet. Rather than speculatively build components with no
consumer, the plan is: (1) choose the client stack (React + Vite + TypeScript,
tokens-first), (2) ship a minimal shell (auth, nav, one workstream screen), then
(3) grow the shared component library (tokens: typography/spacing/color; button,
input, form, table, card, modal, drawer, nav, tabs, badge, alert, toast,
dashboard, chart, calendar, queue, clinical form, loading/empty/error, command
palette) with **LTR/RTL, a11y, responsive, keyboard-nav** from day one. One
system; workstreams may not fork it.

### Phase 3 — Local-first platform
MEDCORE BOX profile (app + Postgres on one LAN host). Harden: migrate-on-boot
(exists), graceful shutdown (exists), a documented single-host deploy, and clean
isolation of internet-dependent adapters (messaging/AI providers already behind
interfaces with local/no-op defaults — verify nothing in the core clinical path
requires egress).

### Phase 4 — Backup / recovery — **DONE** (delivered as Platform Phase 2)
`modules/backup` + `0901_backup.sql` (`backup_run` ledger): logical backups
(`pg_dump` custom format), optional AES-256-GCM at-rest encryption, checksum +
archive-readability verification, GFS retention/rotation (7/4/3, configurable),
and a **tested restore round-trip** into a fresh DB (migrations, tables, a
clinical row, RBAC catalog, append-only triggers and platform indexes all
verified to survive). Admin API (create/list/verify — no download, no HTTP
restore) + operator CLI (`npm run backup`) + audit. See `PRODUCTION-READINESS.md`
for RPO/RTO.

**Recovery runbook (operator):**
1. `npm run backup -- list` — find the backup id.
2. `npm run backup -- verify <id>` — confirm integrity before trusting it.
3. Restore into a scratch DB first: `npm run backup -- restore <id> --target <scratch-url>`.
4. Disaster recovery over the live DB: `npm run backup -- restore <id> --yes`
   (refused without `--yes`). Take a fresh backup before any upgrade.

### Phase 5 — Globalization
`platform/i18n` (locale, timezone, currency, date/number formatting) as a shared
library; message-catalog structure (en, ar-EG) ready for the client. Remove any
implicit Egypt-only assumption from shared code paths; keep Egypt as the default
profile, not the boundary.

**Arabic/RTL PDF — DONE** (delivered as Platform Phase 3): Chromium-based
`modules/platform/pdf/` renderer with a vendored Amiri (OFL) Arabic font;
correct shaping + bidi + tables + multi-page; existing Latin renderer unchanged.
Engine/font decision in `PDF-ARABIC.md`; the "Ready" flip waits on human visual
sign-off of the delivered sample. Chromium becomes a BOX packaging line item
(Phase 11) for clinics needing Arabic documents.

### Phase 6 — Interoperability / FHIR readiness
A read-only mapping layer (`platform/fhir`) translating internal Patient /
Encounter / Observation / MedicationRequest / Practitioner / Organization /
Appointment / DocumentReference to FHIR R4 resource shapes at the boundary only.
No formal compliance claim without validation against a public validator.

### Phase 7 — Shared platform services
Only genuinely shared infra, without new hot files: a typed pagination/filter/sort
contract (opt-in helper), a config service, and a feature-flag service
(per-clinic, DB-backed, cached). Provide as libraries workstreams adopt — never a
forced refactor.

### Phase 8 — Observability (full)
Extend Phase-1 health into readiness vs liveness, structured job/event/queue
status, backup status, integration status — all PHI-safe.

### Phase 9 — Security governance (continuous)
Wire the governance + security regression tests into CI; add dependency
vulnerability scanning and migration-integrity checks to the pipeline; periodic
adversarial tenant-isolation and firewall runs.

### Phase 10 — Architecture governance (ongoing)
Gate cross-workstream changes through `CONTRACT_CHANGE_REQUEST.md`, checking
ownership, API/DB/event contract, and security/PHI/migration/test impact. Resolve
open reviews (F-09 automation offset scoping; CCR-004 governed clinical read).

---

## Platform conventions (authoritative)

- **Migration ranges:** foundation `0001–0099`; clinical `0100–0199`; automation
  `0200–0299`; pharma `0300–0399`; **platform cross-cutting (must run after all
  domain tables) `0900–0999`** (new — for indexes/constraints spanning domains).
- **Dependencies:** runtime deps require a documented decision here and an entry in
  the governance allowlist; default answer is "no". Current allowlist: `fastify`,
  `pg`, `qrcode`, `zod`.
- **Tenant scoping:** every tenant table has `clinic_id`; global tables are the
  fixed allowlist in the governance test.
- **Append-only:** `event` and `audit_log` are platform invariants; domains may
  add their own append-only tables.
- **No PHI** in logs, QR payloads, audit metadata, or event payloads.
