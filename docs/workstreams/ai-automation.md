# Workstream: AI / Automation / WhatsApp (Agent 3)

## Mission
Own the generic automation engine, provider abstractions, WhatsApp/messaging
workflows, and the review-first AI layer (blueprint §2 Automation, §12–13,
§16–17, §39). AI assists; it never decides clinically.

## Branch
`agent-3/ai-automation` (branch from the foundation branch).

## Files you own
- `modules/automation/**`, `modules/ai/**`, `modules/messaging/**` (all new)
- `modules/governance/permissions.automation.ts`
- `domain/events.automation.ts`
- `http/features/automation.feature.ts` + new automation routes
- Migrations **0200–0299**
- Automation tests, this file, `docs/agent-state/agent-3.md`

## How to add things
- **Permission/Event/Route/Table:** same pattern as other workstreams — your own
  `permissions.automation.ts` / `events.automation.ts` / `automation.feature.ts`
  / migration range 0200–0299. Never edit `server.ts` or the barrels.
- The automation engine subscribes to the existing `event` store — read it,
  don't add triggers to it.

## Hard rules (enforced + tested)
- **Provider abstraction (§39):** no vendor is hard-coded. Ship a local/no-op
  default provider so tests and offline clinics work.
- **AI is review-first (§12):** clinically consequential output is a DRAFT with
  cited sources; a human confirms before it becomes authoritative. AI never
  silently mutates a clinical record. The WhatsApp bot never diagnoses,
  prescribes, or gives dangerous medical advice.
- **Consent/preference aware:** no message sends without a consent check; never
  put PHI in provider payload logs.
- **Idempotency:** an automation rule fires at most once per triggering event;
  retries must not duplicate actions or records.

## Cross-agent dependencies
- **A004 (AI intake)** depends on Agent 2's intake write target (C001) — file a
  CONTRACT_CHANGE_REQUEST to consume it; write only via the confirmed-draft flow.
- Messaging templates for clinical events (appointment/no-show/follow-up) read
  clinical events but never expose PHI beyond the approved template variables.

## Next tasks
A001 automation core → A002 provider abstraction → A003 WhatsApp workflows →
A005 AI summaries; A004 AI intake is BLOCKED on C001. See `TASKS.md`.

---

## Built architecture (A001–A003, A005 done; A004 review-first portion done)

Migration `0200_automation.sql` (range 0200–0299). All tables carry `clinic_id`
and `timestamptz`; idempotency is enforced by database unique keys, not just code.

### Automation engine (`modules/automation/`)
`Event → Conditions → Actions`, stored as data:
- `automation.types.ts` — zod-validated rule/condition/action shapes.
- `conditions.ts` — pure, deterministic evaluator (dot-path fields; AND semantics).
- `actions.ts` — extensible action registry (`send_message`, `noop`); add a
  handler to add a capability.
- `engine.ts` — claims a run row with `UNIQUE(rule_id, dedupe_key)` BEFORE acting
  (at-most-once per event, safe under re-processing/concurrency); `processNewEvents`
  advances an offset over the append-only event store (reads it, never writes it).
- `automation.service.ts` — CRUD + run history, `AUTOMATION_MANAGE`/`_READ` gated.

### Messaging (`modules/messaging/`)
Vendor-neutral: code depends only on `MessagingProvider`; `NoopMessagingProvider`
is the offline/test default; adapters register in `providers/registry.ts`.
- Consent-gated: `consent.ts` — opt-in required; opt-out/unknown block the send.
- `templates.ts` — `{{var}}` rendering; substitutes only declared vars, refuses on
  a missing one.
- `messaging.service.ts` — pipeline: consent → idempotency (`idempotency_key`) →
  render (live, from stable records) → transmit (outside any DB tx) → record.
- `delivery.ts` — retry (re-renders; no PHI stored), batch recovery, dead-letter
  at max attempts, provider delivery-status callbacks.
- **PHI safety:** `message_log` stores masked recipient + `template_key` + status
  only — never the rendered body or full address. Retry re-renders from
  `patient_id + template_key + locale`.

Standard template keys to author per clinic: `appointment_reminder`,
`appointment_confirmation`, `no_show_recovery`, `recall`, `follow_up`,
`package_reminder`.

### Review-first AI (`modules/ai/`)
`AIProvider` interface + deterministic `LocalAIProvider` (no network, no
fabrication) + registry. Every output is a `pending` `ai_draft`; a human confirms
or rejects. **Confirmation does not write clinical data** — the clinical-write
handoff is CCR-001 (blocked on C001).
- `intake.ts` (A004) — voice/text → structured intake DRAFT.
- `summaries.ts` (A005) — longitudinal summary grounded ONLY in the patient's
  real events, with citations.
- `observability.ts` — append-only `ai_generation` audit; shape only, no PHI.

### Swapping in a real provider
Implement `MessagingProvider` / `AIProvider`, then `registerProvider(...)` /
`registerAIProvider(...)` at server startup. No business-logic or route changes.

### Endpoints
See `docs/agent-state/agent-3.md` for the full list.

---

## Increment E2 — Scheduling & Time Engine (program Phases 1, 3, 38)

Built on `integration/medcore-v1`. Migration `0201_scheduling.sql`.

### Phase 1 — Engine hardening
- `automation_rule.priority` (lower runs first; deterministic ordering when
  several rules match one event) and `automation_rule.version` (bumped on a
  definition change — conditions/actions — not on rename/enable-toggle).
  `findEnabledEventRules` orders by `(priority, created_at)`.
- **F-09 review outcome:** the global `automation_offset` is intentional and
  correct. At-most-once execution is guaranteed per (rule, event) by
  `UNIQUE(rule_id, dedupe_key)` on `automation_run`, so a single global cursor
  cannot cause a double-run; a per-clinic cursor would add tables and complexity
  for no correctness gain. Kept global (as the governance allowlist records).

### Phase 3 — Scheduling & time engine (`modules/automation/`)
- `scheduled.repo.ts` — `scheduled_action` persistence; `claimDue` uses
  `FOR UPDATE SKIP LOCKED` (concurrency-safe claim), expiry handled in the claim.
- `scheduler.ts` — `scheduleAction(...)` (idempotent on `dedupe_key`), quiet-hours
  deferral via `not_before`, `resolveScheduledFor` (delaySeconds | absolute `at`).
- `scheduler.runner.ts` — `runDueActions(...)` runs due actions through the SAME
  action registry; retry+backoff, dead-letter at the attempt cap, expired actions
  dropped (not sent late). Import layering avoids a cycle (schedule side never
  imports the registry; run side does).
- New action `schedule_action` — an event rule enqueues a future action, carrying
  the resolved patient id forward so the future send needs no event. Cannot nest.
- **Two-layer retry (intentional):** a scheduled send that dispatches is `done`;
  a transient delivery failure is retried by the messaging layer (`message_log`),
  never re-run by the scheduler.

### Phase 38 — Communication quality (`modules/messaging/policy.ts`)
- `messaging_policy` (per clinic, optionally per channel): quiet hours (evaluated
  in the clinic timezone) + frequency caps (min gap, rolling-24h daily cap).
- Enforced centrally in the send pipeline AFTER the consent gate: an immediate
  send in quiet hours / over a cap is suppressed (`quiet_hours`/`min_gap`/
  `daily_cap`); the scheduler defers scheduled sends past quiet hours.
- **Consent is always enforced and cannot be bypassed.** No policy ⇒ permissive
  (existing behaviour unchanged). `bypassPolicy` (quiet-hours/caps only, never
  consent) is reserved for genuinely urgent messages.

### Tests (26 new)
Unit: quiet-hours math (tz-aware, midnight-wrap), `resolveScheduledFor`.
Integration: end-to-end event→schedule→run (delivered once), not-due, scheduling
idempotency, expiry, action-error dead-letter, two-layer retry separation, cancel,
quiet-hours deferral; frequency caps (daily/min-gap), quiet-hours suppression,
consent-independent-of-policy, priority ordering, version bump.

### Endpoints (new)
`POST /automations/run-scheduled`, `GET /scheduled-actions`,
`POST /scheduled-actions/:id/cancel`, `POST/GET /messaging-policy`.

---

## Increment E3 — AI Safety & Governance Layer (program Phases 3, 4, 5, 16)

Built on `integration/medcore-v1`. Migration `0202_ai_governance.sql`. Establishes
the FRONT of the AI safety chain so no AI request can bypass it:

```
capability → classify input → tenant AI policy → routing decision → provider
```

### Modules (`modules/ai/`)
- `classification.ts` — `DataClass` (PUBLIC…HIGHLY_RESTRICTED) + severity ordering;
  `classifyCapabilityInput` marks intake/summary/transcription as PHI by design.
- `policy.ts` — `decide(class, policy)` → `ALLOW_LOCAL | ALLOW_CLOUD | DENY`
  (REDACT/MINIMIZE/REQUIRE_REVIEW reserved); `tenant_ai_policy` read/set (admin).
  **Fail-closed:** no policy row ⇒ local-only; PHI→cloud only on explicit opt-in
  at a PHI ceiling; HIGHLY_RESTRICTED never leaves the box.
- `gateway.ts` — `authorizeAiRequest` is the single chokepoint: classify → policy
  → provider selection. ALLOW_LOCAL never returns a cloud provider even if one is
  registered (defense-in-depth guard; audited DENY). Emits a `requestId`.
- `providers/registry.ts` — providers declare `tier` (`local`/`cloud`); a local
  slot (always present) + an optional cloud slot. Registering a cloud provider
  does NOT authorize cloud use — policy does.
- `intake.ts` / `summaries.ts` now call the gateway, not the provider directly,
  and record `data_class`, `policy_decision`, `provider_tier`, `request_id` in
  `ai_generation` (no PHI, no secrets).

### Safety properties (tested)
- PHI routed to the local provider by default **even when a cloud provider is
  registered** (cloud provider call-count asserted 0).
- PHI reaches cloud **only** when the clinic opts in at the PHI ceiling.
- A cloud provider's secret credential never appears in `ai_generation` or
  `audit_log`.
- Tenant isolation: one clinic opting into cloud does not route another off-box.
- `ai:policy-manage` is ADMIN-only; pharma/reception/doctor get 403.

### Not in this increment (next, deferred deliberately)
Tool-permission system, AI agent identity, AI Action Guard, structured-output
schema validation, prompt/output governance, bounded agents. These are the RIGHT
half of the chain and are only needed once AI generates *actions* (today AI only
produces review-first drafts). They plug into this gateway.

---

## Increment E4 — AI Action Security Kernel

Built on `integration/medcore-v1` (rebased onto P2). Migration `0203_ai_action_kernel.sql`.
A central, FAIL-CLOSED authorization boundary between an AI actor and any tool/action.
AI is an untrusted actor with an explicitly bounded identity — never a human role,
never ADMIN. No autonomous agents are built; this is the gate future agents use.

### Chain (`modules/ai/kernel/`)
`identity → status → tool → prohibited → enabled → risk ceiling → scope →
classification (vs tool + identity ceilings) → tenant AI policy (E3) → confirmation
→ ALLOW / DENY / REQUIRE_CONFIRMATION`

- `risk.ts` — READ_ONLY < LOW < MEDIUM < HIGH < PROHIBITED; MEDIUM+ needs human
  confirmation; PROHIBITED never within any ceiling.
- `tools.ts` — a CODE tool registry (unknown id ⇒ fail closed). Mock executable
  tools; authorization-only read tools (handlers deferred to owners via CCR); the
  prohibited clinical set registered as PROHIBITED with no handler (structurally
  denied; no clinical mutation code in Agent 3).
- `identity.ts` + `ai_identity` — tenant-scoped AI identities; authority is only
  `scopes` (AI vocabulary, not RBAC) + `riskCeiling` + `dataCeiling`; near-powerless
  by default.
- `guard.ts` — `authorizeAiAction`, fail-closed. Reuses the E3 `DataClass`/`policy`
  model. Data-class downgrade is blocked (effective class = more sensitive of
  declared vs the tool's level).
- `confirmation.ts` — stateless HMAC token (server pepper) bound to the exact
  action + TTL; only a human (`ai:action-confirm`) can mint it; the AI cannot forge.
- `execute.ts` — `executeAiAction` is THE boundary; runs a handler ONLY on ALLOW.
- `action-log.ts` + `ai_action_log` (append-only) — decision shape only; never
  tool args or PHI.

### Separation of concerns
Provider authorization (E3 gateway) and action authorization (E4 kernel) are
distinct. An AI capability that reads via a provider AND performs an action passes
through both. E4 does not call providers; E3 is unchanged.

### Tested (28 new)
Identity (valid/disabled/unknown/tenant-mismatch), tool registry (resolve/unknown/
disabled/scope), risk (read-only/low/medium-confirmation/ceiling), classification
(within/above tool/above identity/PHI/HIGHLY_RESTRICTED/downgrade), clinical safety
(every prohibited op denied), tenant isolation, confirmation (required/confirmed/
missing/forged/different-action/expired), fail-closed, PHI-never-in-log,
append-only, authz (ADMIN-only), and a 16-point RED-TEAM.

### Endpoints
`POST/GET /ai/identities`, `POST /ai/identities/:id/disable`, `GET /ai/tools`,
`POST /ai/actions/authorize`, `POST /ai/actions/confirm`, `POST /ai/actions/execute`.

### Deferred (intentionally)
Structured-output schema validation, prompt/output governance, and BOUNDED agents
(Reception, Scheduling, Documentation…) that call `executeAiAction`. No autonomous
execution until the kernel is proven and integrated.

---

## Increment E5 — Parallel AI & Automation batch (migration 0204)

Built on `integration/medcore-v1` @ 48a456b. Six items; three independent
pure-logic slices (structured-output schemas, automation simulation, AI-eval
fixtures/scoring) were produced by isolated worktree sub-agents (typecheck-only,
no shared DB — races avoided), then cherry-picked and consolidated here; the
coupled pieces were built inline.

- **Structured AI output** (`modules/ai/schema/**`): versioned strict zod schemas +
  `validateAiOutput` (PHI-safe issues). `intake.ts`/`summaries.ts` reject malformed
  output (never a draft) and tag `ai_generation` with validation status + versions.
- **AI evaluation** (`modules/ai/eval/**`, `eval.service.ts`): deterministic
  PHI-free fixtures + pure scoring + local-provider runner; `ai_eval_run`
  append-only ledger (ids + numbers only). `POST /ai/eval/run`, `GET /ai/eval/runs`.
- **AI observability**: `ai_generation` + `attempt/retryable/failure_stage/
  validation_status/schema_version/prompt_version` (labels only, no PHI).
- **Bounded read-only AI** (`modules/ai/kernel/readonly-tools.ts`): `clinic.info.read`,
  `automation.runs.read`, `messaging.status.read` — clinic-scoped aggregates, no
  mutation, executed only through `executeAiAction` (Action Guard + classification
  + tenant policy). Clinical PHI reads stay authorization-only (need a CCR).
- **AI Receptionist** (`modules/ai/receptionist/**`): deterministic admin intent +
  routing; clinical-first escalation (never answers a medical question); non-mutating;
  governed by the E3 gateway; text never stored. `POST /ai/receptionist`.
- **Automation simulation** (`modules/automation/simulate.ts`): pure dry-run;
  `POST /automations/:id/simulate` — no sends, no mutations.

Permissions added (ADMIN-only unless noted): `ai:receptionist` (also RECEPTION),
`ai:eval-run`. Safety invariants (E4 guard, human confirmation, consent, quiet
hours, idempotency/retry, tenant isolation, no Pharma access) preserved and green.
