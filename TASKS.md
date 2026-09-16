# MEDCORE — Task Board

Task IDs are stable references used in commits, branches, agent-state files and
contract requests. Status values: `TODO` · `IN_PROGRESS` · `BLOCKED` · `IN_REVIEW`
· `DONE`. Each agent keeps the Status/Owner columns for their own tasks current
and mirrors detail in their `docs/agent-state/agent-N.md`.

Legend for fields: **Obj** objective · **Deps** dependencies · **Files** modules
touched · **API** expected endpoints · **DB** expected schema changes ·
**Tests** required coverage.

---

## Foundation — Agent 1 (F0xx)

### F001 — Multi-agent foundation & contracts *(DONE)*
- **Obj:** Split hot shared files (permissions, events, routes, test reset) into
  per-workstream files + Agent-1 barrels so 4 agents work without merge chaos;
  author orchestration docs.
- **Files:** `governance/roles.ts`, `permissions.ts`(barrel)+`permissions.*.ts`,
  `domain/events.ts`(barrel)+`events.*.ts`, `http/features/*.feature.ts`,
  `http/server.ts`, `test/helpers/db.ts`, `AGENTS.md`, `TASKS.md`,
  `CONTRACT_CHANGE_REQUEST.md`, `docs/agent-state/*`, `docs/workstreams/*`.
- **DB:** none. **API:** unchanged. **Tests:** existing 30 stay green.
- **Status:** DONE · **Owner:** Agent 1

### F002 — Backup & restore engine *(TODO)*
- **Obj:** Verified automatic backups (7 daily / 4 weekly / 3 monthly), restore
  workflow, integrity check (blueprint §35).
- **Deps:** none. **Files:** `modules/backup/**`, migration 0002.
- **API:** `POST /admin/backups`, `GET /admin/backups`, `POST /admin/backups/:id/verify`.
- **DB:** `backup_run` table. **Tests:** backup→corrupt→verify-fails; restore round-trip.
- **Status:** TODO · **Owner:** Agent 1

### F003 — Observability/health dashboard API *(TODO)*
- **Obj:** Extend `/health` into component checks (db, disk, queue, providers) (§38).
- **Deps:** none. **Files:** `modules/observability/**`, `http/features/foundation.feature.ts`.
- **API:** `GET /health/detailed`. **DB:** none. **Tests:** degraded-state reporting.
- **Status:** TODO · **Owner:** Agent 1

### F004 — User & role admin API *(TODO)*
- **Obj:** CRUD for users, role assignment, activation/deactivation, with audit.
- **Deps:** none. **Files:** `modules/identity/users.service.ts`, new routes.
- **API:** `POST/GET/PATCH /users`, `POST /users/:id/roles`.
- **DB:** none (uses existing). **Tests:** authz (only ADMIN), audit, cannot self-lock-out.
- **Status:** TODO · **Owner:** Agent 1

---

## Clinical Core — Agent 2 (C0xx)

### C001 — Clinical intake + vitals *(TODO)*
- **Obj:** Structured intake (chief complaint, history) + vitals capture on an
  encounter; encounter status advances `checked_in → intake → ready`.
- **Deps:** existing encounter/patient. **Files:** `modules/clinical/intake.*`,
  `modules/clinical/vitals.*`, `permissions.clinical.ts`, `events.clinical.ts`,
  `http/routes/intake.routes.ts`, `clinical.feature.ts`, migration 0100.
- **API:** `POST /encounters/:id/intake`, `POST /encounters/:id/vitals`,
  `POST /encounters/:id/status`.
- **DB:** `intake`, `vital` tables (clinic_id, encounter_id, …).
- **Tests:** validation (vital ranges), authz (nurse/reception), event emitted,
  status-transition guards.
- **Status:** TODO · **Owner:** Agent 2

### C002 — Doctor workspace + encounter clinical fields *(TODO)*
- **Obj:** Complaint, examination, assessment, diagnosis, treatment plan,
  clinical note on an encounter; status → `in_progress`/`completed`.
- **Deps:** C001. **Files:** `modules/clinical/encounter.*`, migration 0101.
- **API:** `GET /encounters/:id`, `PATCH /encounters/:id/clinical`,
  `POST /encounters/:id/complete`.
- **DB:** `clinical_note`, `diagnosis`, `assessment`, `treatment_plan`.
- **Tests:** only DOCTOR can complete; audit on diagnosis change; append-only note history.
- **Status:** TODO · **Owner:** Agent 2

### C003 — Save & Next (queue advance) *(TODO)*
- **Obj:** Complete current encounter and atomically surface the next `ready`
  patient; keyboard-first flow (blueprint §14).
- **Deps:** C002. **API:** `POST /encounters/:id/complete-and-next`.
- **Tests:** concurrency (two doctors don't get same next patient), ordering.
- **Status:** TODO · **Owner:** Agent 2

### C004 — Patient timeline *(TODO)*
- **Obj:** Chronological encounters/observations/treatments per patient (§4.3).
- **Deps:** C002. **API:** `GET /patients/:id/timeline`.
- **Tests:** clinic scope, pagination, empty state.
- **Status:** TODO · **Owner:** Agent 2

### C005 — Treatment response episodes *(TODO)*
- **Obj:** Treatment episode with start/stop/response/discontinuation (§15).
- **Deps:** C002. **DB:** `treatment_episode`. **Tests:** longitudinal query, authz.
- **Status:** TODO · **Owner:** Agent 2

### C006 — Report engine (patient/encounter, PDF) *(TODO)*
- **Obj:** Reusable report engine; patient + encounter reports to PDF (§31).
- **Deps:** C002. **API:** `GET /reports/encounter/:id.pdf`.
- **Tests:** authz, deterministic content, no PHI leakage in filenames/logs.
- **Status:** TODO · **Owner:** Agent 2

---

## AI / Automation / WhatsApp — Agent 3 (A0xx)

### A001 — Automation engine core (event→condition→action) *(TODO)*
- **Obj:** Generic rule engine subscribing to the event store; scheduled + event
  triggers; idempotent action execution (blueprint §2 Automation, §16).
- **Deps:** event store (exists). **Files:** `modules/automation/**`,
  `permissions.automation.ts`, `events.automation.ts`, migration 0200.
- **API:** `POST/GET /automations`, `GET /automations/:id/runs`.
- **DB:** `automation_rule`, `automation_run`. **Tests:** rule fires once per event
  (idempotency), condition filtering, disabled rule no-ops.
- **Status:** TODO · **Owner:** Agent 3

### A002 — Provider abstraction (WhatsApp/SMS/Email/AI) *(TODO)*
- **Obj:** `Provider` interfaces with a local/no-op default so nothing is
  hard-coded to a vendor (blueprint §39). **Deps:** none.
- **Files:** `modules/messaging/providers/**`, `modules/ai/providers/**`.
- **DB:** `message_log` (consent/preference aware). **Tests:** provider swap,
  consent gate blocks send, no PHI in provider payload logs.
- **Status:** TODO · **Owner:** Agent 3

### A003 — WhatsApp workflows (reminders, no-show, recall) *(TODO)*
- **Obj:** Templated, consent-aware messages driven by automation rules (§16).
- **Deps:** A001, A002. **Tests:** template render, opt-out honored.
- **Status:** TODO · **Owner:** Agent 3

### A004 — AI intake extraction (review-first) *(TODO)*
- **Obj:** Free-text/voice → structured intake DRAFT; must be confirmed by a
  human before write (§12). Coordinate the write target with Agent 2 (C001) via
  a contract request. **Deps:** A002, C001.
- **Files:** `modules/ai/intake.*`. **DB:** `ai_draft` (status: pending/confirmed/rejected).
- **Tests:** draft never auto-writes clinical data; confirmation flow; audit.
- **Status:** BLOCKED (needs C001 intake contract) · **Owner:** Agent 3

### A005 — AI summaries (patient history / call debrief) *(TODO)*
- **Obj:** Longitudinal summary with cited source fields; review-first (§13, §27).
- **Deps:** A002. **Tests:** citations present, no fabrication path, authz.
- **Status:** TODO · **Owner:** Agent 3

---

## Pharma / HCP / Drug / Intelligence — Agent 4 (P0xx)

### P001 — Physician / HCP master *(DONE)*
- **Obj:** Provenance-aware HCP identity + HCO affiliations, verification state,
  source/last_verified, confidence (blueprint §6, §7). **Deps:** none.
- **Files:** `modules/hcp/**`, `permissions.pharma.ts`, `events.pharma.ts`, migration 0300.
- **API:** `POST/GET /hcps`, `GET /hcps/:id` (HCP 360 — NO patient data).
- **DB:** `hcp`, `hco`, `hcp_hco_affiliation` (+ `specialty`, `hcp_identifier`,
  `hcp_specialty`, `hcp_practice_location`, `hcp_professional_interest`,
  append-only `hcp_revision`).
- **Tests:** 20 in `hcp-master.test.ts` — provenance required, pharma-only authz,
  no patient linkage, verification is stewardship, versioning, merge,
  professional-identifiers-only.
- **Status:** DONE · **Owner:** Agent 4

### P002 — Drug / medication master *(DONE)*
- **Obj:** Canonical medication concept with jurisdiction, source, version,
  status, last_verified; import/provider architecture (§8). **Deps:** none.
- **Files:** `modules/drug/**`, migration 0301.
- **API:** `GET /medications`, `GET /medications/:id`.
- **DB:** `medication`, `medication_product`, `medication_ingredient`, provenance
  cols (+ `manufacturer`, `medication_revision`, `medication_import_run`).
- **Tests:** 17 in `drug-master.test.ts` — multi-jurisdiction, provenance/
  last_verified enforced, unregistered provider rejected (no unlicensed ingestion).
- **Status:** DONE · **Owner:** Agent 4

### P003 — Territory + Medical Rep workflow *(DONE)*
- **Obj:** Territory assignment, rep visit plan, pre-visit brief, call report (§18–20).
- **Deps:** P001. **DB:** `territory`, `territory_assignment`, `visit`, `call_report`.
- **API:** `GET /rep/territory`, `GET /rep/today`, `POST /visits`,
  `GET /visits/:id/briefing`, `POST /visits/:id/call-report`,
  `POST/GET /scientific-requests`, `GET /rep/follow-ups`.
- **Tests:** 20 in `pharma-field.test.ts` — rep sees only assigned HCPs (and a rep
  with no territory sees nothing), no patient data, authz.
- **Status:** DONE · **Owner:** Agent 4

### P004 — Approved content hub *(DONE)*
- **Obj:** Versioned approved scientific content with owner/effective/expiry/
  jurisdiction; reps access only authorized content (§21). **Deps:** P001.
- **DB:** `approved_content`, `approved_content_revision`, `content_engagement`.
- **Tests:** 21 in `pharma-content.test.ts` — expiry gating (in SQL), territory
  authz, author cannot approve their own content, append-only decision history.
- **Status:** DONE · **Owner:** Agent 4

### P005 — Intelligence firewall + aggregated signals *(DONE except the clinical input, which is blocked by design)*
- **Obj:** Pipeline: classification → authorization → de-identification →
  aggregation → min-cohort threshold → policy → signal; returns nothing below
  threshold (blueprint §24, §25). **Deps:** P001; read-only over clinical events.
- **CONTRACT:** requires a governed read path — file a contract request; pharma
  must never touch the clinical DB directly. **DB:** `aggregated_signal`.
- **API:** `GET /intelligence/signals`, `POST /intelligence/runs`,
  `GET /intelligence/sources`, `PUT/GET /intelligence/policies`.
- **DB:** `aggregated_signal`, `intelligence_run`, `intelligence_policy`.
- **Tests:** 20 unit (`firewall.test.ts`) + 63 integration
  (`pharma-firewall.test.ts`) — below-threshold → empty, no re-identification,
  pharma cannot reach patient rows, threshold cannot be weakened from API or DB,
  the clinical source refuses every request.
- **Status:** All seven stages built, tested and live over pharma's own field
  data. The `clinical_governed` source is registered and refuses every request
  (HTTP 501, audited) pending **CCR-001** — pharma must not read clinical tables
  to unblock itself. · **Owner:** Agent 4

### P006 — HCP segmentation, campaigns & engagement *(DONE)*
- **Obj:** Pharma marketing foundations: declarative HCP segments, campaigns,
  content distribution and measured engagement (blueprint §22, §26).
- **Deps:** P001, P004. **Files:** `modules/pharma/marketing.service.ts`,
  `content.service.ts`, migration 0303.
- **API:** `POST/GET /pharma/segments`, `POST /pharma/segments/:id/resolve`,
  `POST/GET /pharma/campaigns`, `POST /pharma/campaigns/:id/targets`,
  `POST /pharma/content/:id/engagements`.
- **DB:** `hcp_segment`, `hcp_segment_member`, `campaign`, `campaign_target`,
  `content_engagement`.
- **Tests:** segment criteria are declarative and contain no clinical dimension;
  rep can read but not define; engagement refused for expired content.
- **Status:** DONE · **Owner:** Agent 4

---

## Cross-cutting — Integration & Hardening (I0xx, Agent 1 at QA)

### I001 — Integration + full-suite QA *(TODO)*
- **Obj:** Merge agent branches, resolve conflicts in owned files, run full
  typecheck/test/build/migrate, security review of boundaries. **Deps:** all.
- **Status:** TODO · **Owner:** Agent 1
