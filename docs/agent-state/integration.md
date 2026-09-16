# MEDCORE — Integration, Security & Hardening Report (I001)

Owner: Agent 1 (Integration Lead). Branch: `integration/medcore-v1`.
Date: 2026-09-16.

Status legend: **PASS** (tested and verified) · **FIXED** (defect found and
resolved here) · **BLOCKED** · **DEFERRED** (out of integration scope, needs a
follow-up task) · **NOT VERIFIED**.

---

## 1. Integration summary

Four workstreams branched from the Agent 1 foundation (`be5211a`) and were
merged in order into `integration/medcore-v1`:

| Step | Workstream | Branch | Commits |
| --- | --- | --- | --- |
| 1 | Clinical Core (C001–C007) | `claude/inspiring-cori-tk3ej8` | 10 |
| 2 | AI/WhatsApp/Automation (A001–A005) | `claude/magical-gates-bgfexk` | 1 |
| 3 | Pharma/HCP/Drug/Intelligence (P001–P006) | `claude/jolly-carson-8t7ufe` | 3 |

**The parallel-safety foundation worked.** Every *code* file was disjoint across
branches — the barrels (`permissions.ts`, `events.ts`), `server.ts`, and the
migration ranges (0100–0103 / 0200 / 0300–0304) had zero collisions. The only
merge conflicts were in two shared docs (`TASKS.md`, `CONTRACT_CHANGE_REQUEST.md`).

### Conflicts resolved
- `CONTRACT_CHANGE_REQUEST.md` (Agent 3, then Agent 4): **CCR id collision** —
  all three agents numbered requests from CCR-001. Reconciled to distinct ids
  (see §3). Resolved by understanding each request's contract, not by ours/theirs.
- `TASKS.md`: auto-merged; statuses reconciled.

### Post-merge gate (each step)
Typecheck clean and full suite green after every merge: 154 (after A2) → 191
(after A3) → **352 (after A4)**. Final gate after hardening: see §12.

---

## 2. Cross-workstream contracts (reconciled)

| Seam | Verdict | Notes |
| --- | --- | --- |
| Clinical ↔ AI (draft→review→clinical) | **PASS** | AI writes only `ai_draft` (pending); a human confirms; the clinical `intake` write is a human-invoked endpoint whose DB CHECK rejects an `ai_assisted` row with no confirmer. AI cannot write clinical data — enforced in code AND schema. |
| Clinical ↔ Drug Master (prescriptions) | **PASS** (decoupled) | `prescription_item.medication_ref` is a nullable, opaque, FK-free string. No direct coupling; live resolver via drug-master service DEFERRED (CCR-001). |
| Clinical → Intelligence | **PASS** (fail-closed) | The `clinical_governed` intelligence source is registered but refuses (HTTP 501, audited). No clinical data reaches pharma today. Governed aggregate-read contract DEFERRED (CCR-004). |
| Pharma → Clinical | **PASS (denied by architecture)** | Verified independently — see §4. |
| Automation ↔ Messaging | **PASS** | `send_message` action is consent-gated and idempotent; engine reads the event store, never writes it (no loop). |

---

## 3. Contract Change Requests (reconciled + decided)

| CCR | Title | Requester | Decision |
| --- | --- | --- | --- |
| CCR-001 | Prescription → medication-master reference | Agent 2 | **APPROVED** (design); live resolver DEFERRED |
| CCR-002 | Redact query strings from request log | Agent 2 | **APPROVED + IMPLEMENTED** here (global fix) |
| CCR-003 | AI intake draft → clinical write | Agent 3 (was CCR-001) | **APPROVED**; satisfied by existing human-invoked intake contract; auto-promotion DEFERRED |
| CCR-004 | Governed aggregate-only clinical read | Agent 4 (was CCR-001) | **APPROVED** (contract); implementation DEFERRED (fail-closed today) |
| CCR-005 | Pharma separation-of-duties roles | Agent 4 (was CCR-002) | **APPROVED + IMPLEMENTED** here |

Full text and rationale in `CONTRACT_CHANGE_REQUEST.md`.

---

## 4. Security audit

### 4.1 Pharma data firewall — **PASS**
Independently verified (not trusting Agent 4's summary):
- **Code:** `grep` over `modules/{pharma,hcp,drug,intelligence}` — no import of
  clinical/identity/patient code; no SQL against a clinical table. (Also asserted
  by `pharma-firewall.test.ts` static scan, 30+ files, with a non-vacuous
  self-check.)
- **Schema:** no pharma migration (0300–0304) references `patient`/`encounter`;
  no FK or column crosses the boundary. Verified by grep + `information_schema`
  test.
- **Authorization:** `PHARMA_REP` and the new pharma roles hold **zero** clinical
  permissions; no clinical role holds a pharma permission (asserted in
  `pharma-firewall.test.ts` and `rbac-roles.test.ts`; live 403s both directions).
- **Intelligence firewall:** 7 stages as pure functions; min cohort = 5 enforced
  in code AND as DB CHECKs on `intelligence_policy` and `aggregated_signal`
  (`cohort_size >= min_cohort_size >= 5`, `deidentified`, `policy_status='passed'`)
  — a direct INSERT cannot persist a re-identifiable cohort. Below-threshold
  returns nothing and is indistinguishable from "no data". Per-run non-persisted
  salt prevents cross-run linkage. Clinical source fails closed (501).
  Adversarial reconstruction covered by `pharma-firewall.test.ts` (63) +
  `firewall.test.ts` (20).

### 4.2 PHI in logs — **FIXED**
- **Finding (Agent 2, verified):** Fastify's default request log records the full
  URL incl. query string, so `GET /patients/search?q=<name>` wrote a patient name
  to application logs.
- **Fix (this integration, CCR-002):** global `req` log serializer in
  `http/server.ts` strips the query string for **every** route and returns method
  + path + hostname only; pino `redact` removes `authorization`/`cookie`/
  `x-api-key` headers. Regression test `phi-logging.test.ts` exercises the real
  `buildServer` logger: query values (`AhmedHassan`, a phone) and the bearer token
  are absent, path still present.
- `console.*` in source is limited to boot/CLI operational metadata (migration
  names, signals) — no PHI. Domain audit/event payloads carry ids/vocab/counts
  only (asserted by clinical + pharma tests).

### 4.3 RBAC — **FIXED (ADMIN over-grant) + PASS**
- Authoritative matrix from a fresh seed (64 permissions total):

  | Role | # perms |
  | --- | --- |
  | ADMIN | 64 (all) |
  | DOCTOR | 27 |
  | NURSE | 20 |
  | RECEPTION | 15 |
  | PHARMA_REP | 16 |
  | PHARMA_DATA_STEWARD | 9 |
  | MEDICAL_AFFAIRS | 10 |
  | PHARMA_MANAGER | 16 |

- **ADMIN over-grant (Agent 4 finding) FIXED via CCR-005:** governed pharma
  actions (`hcp:verify/merge`, `medication:write`, `content:approve`,
  `territory:manage`, `intelligence:publish`, `scientificrequest:fulfill`) were
  ADMIN-only; now held by purpose-built least-privilege roles. Solved by adding
  roles, **not** by broadening existing ones. `rbac-roles.test.ts` asserts each
  new role's subset, that none holds a clinical permission, and ADMIN still holds
  all.
- Negative authorization verified: pharma↔clinical separation (both directions).

### 4.4 Tenant / clinic isolation — **PASS (via workstream tests)**
Every service scopes queries by `clinic_id`; cross-clinic reads return not-found.
Covered by foundation `security.test.ts` and workstream isolation tests. Included
in the full green suite. *Not independently re-derived beyond the existing
adversarial tests + code scoping review.*

### 4.5 AI safety — **PASS**
AI output is untrusted: drafts are `pending`, never auto-write; confirmation is a
human action; clinical promotion needs the human-invoked intake endpoint whose
CHECK rejects unconfirmed `ai_assisted` rows. The local AI provider refuses to
summarize with no sources (no fabrication path). Covered by `ai.test.ts`.

---

## 5. Database / migrations — **PASS**
- 11 migrations apply cleanly IN ORDER from an empty DB: `0001, 0100–0103, 0200,
  0300–0304` → **69 tables**. Ranges disjoint; no duplicate objects; checksum
  guard active (an edited applied migration is rejected).
- Governance carried in constraints: append-only triggers on `event`,
  `audit_log`, `clinical_note`, `treatment_response`, `prescription_item`;
  immutable `prescription`; min-cohort CHECKs on intelligence tables; `verified`
  requires `last_verified_at`; content `approved` requires approver + dates.
- Seed is idempotent and syncs the RBAC catalog automatically.

## 6. Event system — **PASS (reviewed)**
Clinical, automation and pharma event catalogs merge via the barrel with no
collisions. Payloads carry ids/vocabulary/counts, not PHI (asserted by tests).
The automation engine reads the event store and never writes it (no cycle).

## 7. Concurrency — **PASS (via tests)**
Save & Next / queue claiming use atomic complete-then-claim; automation uses
`UNIQUE(rule_id, dedupe_key)` for at-most-once; duplicate patient + duplicate
active encounter guarded by unique indexes; HCP merge and content approval have
tests. Covered by `queue.test.ts`, `workspace.test.ts`, `automation.test.ts`.

---

## 8. Findings & production readiness

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | Request-log query-string PHI leak | HIGH | **FIXED** (CCR-002) |
| 2 | Governed pharma actions were ADMIN-only | MEDIUM | **FIXED** (CCR-005) |
| 3 | PDF reports render Arabic as `????` (base-14/WinAnsi) | HIGH (Egypt) | **DEFERRED** — see below |
| 4 | Live drug-master resolution for `medication_ref` | LOW | **DEFERRED** (CCR-001) |
| 5 | Governed clinical→intelligence read path | MEDIUM | **DEFERRED** (CCR-004); safe (fail-closed) |
| 6 | Error logs may include pg error `detail` (could echo a value) | LOW | **NOT VERIFIED** / follow-up |
| 7 | Scheduled automation (cron) dispatcher | LOW | **DEFERRED** (event triggers work) |

### Finding 3 (Arabic PDF) — recommended solution
The from-scratch renderer uses base-14 Helvetica + WinAnsi, so any non-Latin-1
glyph becomes `?`. For an Egypt deployment this is not shippable for patient-facing
reports. Correct fix: embed a Unicode TrueType subset with Identity-H/CID
encoding AND apply Arabic contextual shaping + RTL (bidi). Recommended: adopt a
maintained engine (`pdfkit` or `pdf-lib`) with **Noto Naskh Arabic** (SIL OFL
1.1 — free to embed/redistribute, deterministic, Docker-friendly, ~cost is font
size ~400KB subset). This is feature-scale and correctness-sensitive (mis-shaping
is worse than `?`), so it must be a dedicated task with its own tests — not rushed
during integration. Until then, ASCII/Latin reports are correct; Arabic is a
known limitation.

### Production blockers
- **None that make the system unsafe.** Governance boundaries (pharma↔clinical,
  AI review-first, PHI-in-logs) are enforced and tested.
- **Ship-gating for the Egypt clinical rollout:** Finding 3 (Arabic PDFs) should
  be treated as a release blocker for patient-facing Arabic reports specifically.

---

## 9. What was NOT done (honest scope)
- Did not implement the governed clinical→intelligence provider (CCR-004) — safe
  by fail-closed design; needs its own security review.
- Did not implement server-side AI-draft→clinical auto-promotion (CCR-003) —
  human-invoked path is sufficient and safer.
- Did not implement Arabic PDF (Finding 3) — feature-scale.
- Tenant isolation and concurrency verified via the agents' existing adversarial
  tests + code review, not a fresh independent adversarial campaign.

## 10. Files changed during integration (beyond merges)
- `http/server.ts` — global request-log serializer + header redaction (CCR-002).
- `governance/roles.ts` — 3 new pharma RoleKeys (CCR-005).
- `governance/permissions.pharma.ts` — grants for the 3 new roles (CCR-005).
- `CONTRACT_CHANGE_REQUEST.md` — reconciled ledger + decisions.
- New tests: `phi-logging.test.ts`, `rbac-roles.test.ts`.
- Docs: this file, `IMPLEMENTATION-STATUS.md`, `TASKS.md`.

## 11. Final quality gate
See §12 (filled after the final run): typecheck, full suite, fresh migrate+seed,
build, git-cleanliness.

## 12. Final gate results

| Gate | Result |
| --- | --- |
| Fresh DB migration (0001→0304) | **PASS** — 11 migrations, 69 tables, in order from empty |
| Seed | **PASS** — RBAC synced, demo clinic + users created |
| Typecheck | **PASS** — clean |
| Full test suite | **PASS** — **360 tests / 28 files** green (exit 0) |
| Production build (`tsc -p tsconfig.build.json`) | **PASS** — clean |
| API smoke (all 4 workstreams booted) | **PASS** — health/login OK; clinical register 201; automations 200; medications 200; intelligence 200 |
| PHI-in-logs (live production log) | **PASS** — no query string appears in any logged URL |
| RBAC matrix | **PASS** — ADMIN=64(all); least-privilege per role; pharma↔clinical separated |
| Git cleanliness | **PASS** — no `.env`/secrets/`node_modules`/`dist`/artifacts committed (only `.env.example`) |

Included security/adversarial coverage in the suite: pharma firewall (structural
+ permission + input-screen + intelligence, 63), firewall unit (20), tenant
isolation, AI review-first, messaging consent/PHI, automation idempotency,
concurrency (Save & Next, queue claim), plus the two integration regressions
(`phi-logging`, `rbac-roles`).

**Bottom line:** the four workstreams behave as one coherent system. No unsafe
production blocker. The one ship-gating item for the Egypt clinical rollout is
Finding 3 (Arabic PDFs), which is DEFERRED to a dedicated task with a concrete
recommended solution.
