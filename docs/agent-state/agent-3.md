# Agent 3 — AI / Automation / WhatsApp — State

## Current Status
Base: `integration/medcore-v1` @ `48a456b` (I-4 consolidated baseline; my E2/E3/E4 are
already integrated there). Agent-3 expansion increments:
- **E2** — Scheduling & Time Engine + engine hardening + comms-quality.
- **E3** — AI Safety & Governance Layer (classification, PHI/cloud policy, provider gateway).
- **E4** — AI Action Security Kernel (fail-closed AI→action boundary).
- **E5** — Parallel AI & Automation expansion batch (this increment).

A001–A005 remain DONE. Verification (in `server/`): `npm run typecheck` clean ·
`npm run build` clean · migrations `0001…0204, 0300…0306, 0900, 0901` apply from empty.

## Increment E5 — Parallel AI & Automation batch (migration 0204)
Six items; three independent pure-logic slices were built in isolated worktree
sub-agents (typecheck-only, no shared DB) and consolidated here; the coupled/
shared-wiring pieces were built inline. No Agent 1/2/4 code touched; no new deps.

1. **Structured AI output** (`modules/ai/schema/**`, agent-authored): versioned,
   strict zod schemas + `validateAiOutput`; validation issues are PHI-safe (no
   input values echoed). Wired into `intake.ts`/`summaries.ts`: a malformed/unsafe
   output is REJECTED (never becomes a draft; review-first preserved) and recorded
   as `validation_status='invalid'`; valid outputs record schema/prompt versions.
2. **AI evaluation & governance** (`modules/ai/eval/**` + `eval.service.ts`):
   deterministic, DE-IDENTIFIED fixtures + pure scoring (precision/recall,
   hallucinated-citation detection) + a local-provider runner; results persisted
   to the append-only `ai_eval_run` ledger (ids + numbers only, no PHI).
3. **AI observability**: `ai_generation` gains `attempt`, `retryable`,
   `failure_stage`, `validation_status`, `schema_version`, `prompt_version`
   (labels/versions only). No prompts/outputs/variables/secrets/PHI in logs.
4. **Bounded read-only AI** (`modules/ai/kernel/readonly-tools.ts`): real handlers
   for `clinic.info.read` (non-PHI foundation), `automation.runs.read`,
   `messaging.status.read` (Agent-3-owned aggregates) — all clinic-scoped, no
   mutation, executed ONLY through `executeAiAction` (Action Guard + classification
   + tenant policy). PHI clinical reads remain authorization-only (need a CCR).
5. **AI Receptionist Foundation** (`modules/ai/receptionist/**`): deterministic
   administrative intent classifier + FAQ/routing; CLINICAL-FIRST — any clinical
   signal escalates to human staff and NEVER receives an answer. Non-mutating
   (proposes only), governed by the E3 gateway, message text never stored.
6. **Automation simulation** (`modules/automation/simulate.ts`, agent-authored):
   pure `simulateRule(rule, event)` dry-run — trigger + conditions + planned
   actions with reasons; sends nothing, mutates nothing. Route
   `POST /automations/:id/simulate`.

**Safety preserved:** E4 Action Guard unchanged; AI cannot diagnose/prescribe/
mutate clinical facts or bypass human confirmation; AI identities hold no human
permission; consent + quiet-hours + idempotency/retry/dead-letter untouched (full
suite green). No Pharma access; CCR-003/004/010 untouched.

## Increment E4 — AI Action Security Kernel
A central, FAIL-CLOSED authorization boundary so any FUTURE AI-initiated action
must pass through it. AI is treated as an untrusted actor with an explicitly
bounded identity — it never inherits a human role or ADMIN. (No autonomous agents
built; today no AI code invokes an action — the kernel is the gate they will use.)

Chain (all in `modules/ai/kernel/`):
`AI identity → status → tool → prohibited → enabled → risk ceiling → scope →
data classification (vs tool + identity ceilings) → tenant AI policy (E3) →
human confirmation → ALLOW / DENY / REQUIRE_CONFIRMATION`.

- **AI identity** (`identity.ts`, `ai_identity` table): tenant-scoped; authority is
  only its `scopes` (an AI vocabulary distinct from RBAC) + `riskCeiling` +
  `dataCeiling`. Fresh identity is near-powerless (read-only, internal, no scopes).
- **Tool registry** (`tools.ts`): a CODE registry — unknown tool id ⇒ `undefined` ⇒
  fail closed. Mock/example executable tools (`demo.*`), authorization-only read
  tools (`patient.search`… handler deferred to owner via CCR), and the **prohibited
  clinical set** (`clinical.diagnosis.modify`, `clinical.prescription.create`, …)
  registered as `PROHIBITED` with no handler — structurally denied, and NO clinical
  mutation code exists in Agent 3.
- **Risk classes** (`risk.ts`): READ_ONLY < LOW < MEDIUM < HIGH < PROHIBITED;
  MEDIUM+ requires human confirmation; PROHIBITED never within any ceiling.
- **Action Guard** (`guard.ts`): `authorizeAiAction` — pure fail-closed decision;
  consumes the E3 `DataClass`/`policy` model (not a second one); a data-class
  downgrade cannot slip a PHI tool past a low ceiling (effective class = the more
  sensitive of declared vs the tool's level).
- **Human confirmation** (`confirmation.ts`): a stateless HMAC token (server pepper)
  bound to the exact action + short TTL; only a human (via `ai:action-confirm`) can
  mint it, the AI cannot forge or self-confirm.
- **Execution boundary** (`execute.ts`): `executeAiAction` authorizes first and runs
  the tool handler ONLY on ALLOW; the only path from an AI actor to a handler.
- **Observability** (`action-log.ts`, `ai_action_log`, append-only): one row per
  decision — identity/tool/risk/decision/reason only, NEVER tool args or PHI.

## Increment E3 — AI Safety & Governance Layer (Phases 3, 4, 5, 16)
Establishes the front of the AI governance chain so **no AI request bypasses it**:
`capability → classify → tenant policy → routing decision → provider`.
- **Data classification** (`modules/ai/classification.ts`): `DataClass`
  (PUBLIC…HIGHLY_RESTRICTED) with severity ordering; AI capabilities that touch
  patient data are classified PHI by construction (not guessed from text).
- **PHI policy engine** (`modules/ai/policy.ts`): pure `decide(class, policy)` →
  `ALLOW_LOCAL | ALLOW_CLOUD | DENY` (+ REDACT/MINIMIZE/REQUIRE_REVIEW reserved).
  **Fail-closed:** a clinic with no `tenant_ai_policy` row is local-only; PHI
  reaches a cloud provider only when the clinic explicitly opts in AND raises its
  cloud ceiling to PHI; HIGHLY_RESTRICTED never leaves the box.
- **AI gateway** (`modules/ai/gateway.ts`): the single chokepoint
  (`authorizeAiRequest`). Classifies, applies tenant policy, and returns the
  provider it is ALLOWED to use — an ALLOW_LOCAL decision never returns a cloud
  provider even when one is registered (defense-in-depth check + audited DENY).
- **Provider router** (`providers/registry.ts`): providers declare a `tier`
  (`local`/`cloud`); the registry holds a local slot (always) and an optional
  cloud slot. "A cloud model exists" and "this data may go to cloud" are
  independent decisions.
- **Wired through:** `intake.ts` and `summaries.ts` now call the gateway instead
  of the provider directly; both record the classification + decision + tier +
  request id in `ai_generation` (no PHI, no secrets).
- **Provider-secret safety:** credentials live inside a provider adapter, never
  on the `AIProvider` interface surface; tested that a cloud secret never appears
  in `ai_generation` or `audit_log`.

## Increment E2 — Scheduling & Time Engine (Phases 1, 3, 38)
- **P1 hardening:** automation rules now carry `priority` (deterministic execution
  ordering — lower first) and `version` (bumped when conditions/actions change, not
  on rename/toggle); `automation_run.rule_version` records the definition that ran.
  F-09 reviewed: the global `automation_offset` is INTENTIONAL and safe (idempotency
  is per rule+event via `UNIQUE(rule_id, dedupe_key)`, so a single global cursor
  cannot cause a double-run); kept global (matches the governance allowlist).
- **P3 time engine:** `scheduled_action` queue — durable, timezone-aware,
  delayed/scheduled actions with expiry (stale reminders dropped, not sent late),
  retry+backoff+dead-letter, and DB-enforced idempotency (`UNIQUE(clinic_id,
  dedupe_key)`). `runDueActions` claims due rows with `FOR UPDATE SKIP LOCKED`
  (concurrency-safe) and runs them through the SAME action registry as event rules.
  New action `schedule_action` lets an event rule enqueue a future action (e.g.
  "on FOLLOW_UP_SCHEDULED → WhatsApp reminder in 24h"). Two-layer retry is
  intentional and tested: a scheduled send that DISPATCHES is `done`; a transient
  delivery failure is retried by the messaging layer (`message_log`), not the
  scheduler — no double-retry.
- **P38 comms quality:** `messaging_policy` (per clinic, optionally per channel) —
  quiet hours (evaluated in the clinic timezone) + frequency caps (min gap +
  rolling-24h daily cap). Enforced centrally in the send pipeline: an immediate
  send in quiet hours or over a cap is suppressed (`quiet_hours`/`min_gap`/
  `daily_cap`); the scheduler DEFERS scheduled sends past quiet hours via
  `not_before`. **Consent is always enforced and never bypassable.** With NO policy
  configured, behaviour is fully permissive (existing behaviour unchanged).

## Completed
- **A001 — Automation engine (event → conditions → actions).** Rules stored as
  data (`automation_rule`), executed idempotently against the append-only event
  store via a processing offset. Per-(rule, event) `UNIQUE(rule_id, dedupe_key)`
  guarantees at-most-once execution. Deterministic condition evaluator, extensible
  action registry, full run history (`automation_run`), CRUD + "process now" API.
- **A002 — Provider abstraction + messaging.** Vendor-neutral `MessagingProvider`
  and `AIProvider` interfaces with local/no-op defaults (offline + test safe).
  Consent-gated, idempotent send pipeline with retry, exponential backoff,
  dead-letter, and provider delivery-status callbacks. No PHI in `message_log`
  (masked recipient, no body/address; retry re-renders from stable records).
- **A003 — WhatsApp workflows.** `send_message` automation action wires
  templates + consent into the engine; a check-in event can fire a consent-gated
  WhatsApp reminder. Template rendering substitutes only declared variables and
  refuses on a missing one. Opt-out is honored (suppressed, never sent).
- **A004 — AI intake extraction (review-first, partial).** Voice/text → structured
  intake DRAFT via the AI provider; creates a `pending` `ai_draft`, never writes a
  clinical record. Confirmation is a human action that stops at the draft (clinical
  promotion is CCR-001, blocked on C001).
- **A005 — AI summaries.** Longitudinal patient summary grounded ONLY in the
  patient's real clinic-scoped events, with citations; produced as a review-first
  draft. Local provider refuses to summarise with no sources (no fabrication path).
- AI observability (`ai_generation`, append-only) records shape only (provider,
  model, latency, sizes, source count) — never prompt/response/PHI.

## In Progress
- Awaiting C001 intake contract to complete A004's confirmed-draft → clinical
  write step (see CCR-001).

## Database Changes
- Migration **`0200_automation.sql`** (range 0200–0299) adds:
  `communication_consent`, `message_template`, `message_log`, `automation_rule`,
  `automation_run`, `automation_offset`, `ai_draft`, `ai_generation` (append-only).
- Migration **`0201_scheduling.sql`** (E2): `ALTER automation_rule`
  add `priority`, `version`; `ALTER automation_run` add `rule_version`; new tables
  `scheduled_action` (time engine) and `messaging_policy` (quiet hours + caps).
- Migration **`0202_ai_governance.sql`** (E3): new table `tenant_ai_policy`
  (`clinic_id` PK; `allow_cloud`, `cloud_max_class`); `ALTER ai_generation` add
  `data_class`, `policy_decision`, `provider_tier`, `request_id` (append-only via
  ADD COLUMN; existing rows get NULL). All `clinic_id`-scoped; governance passes.
- Migration **`0203_ai_action_kernel.sql`** (E4): `ai_identity` (tenant-scoped AI
  identities: status, risk/data ceilings, scopes jsonb) + `ai_action_log`
  (append-only guard-decision log; no PHI/args). Both `clinic_id`-scoped.
- All tenant-scoped (`clinic_id`), `timestamptz` timestamps, idempotency enforced
  by unique keys. FKs reference the shared foundation schema (`clinic`, `patient`,
  `app_user`) only; no other workstream's tables are touched.

## API Changes (all new, registered via `automation.feature.ts`)
- Automation: `POST/GET /automations`, `GET/PATCH/DELETE /automations/:id`,
  `GET /automations/:id/runs`, `POST /automations/process`.
- Scheduling (this increment): `POST /automations/run-scheduled`,
  `GET /scheduled-actions`, `POST /scheduled-actions/:id/cancel`.
- Messaging: `POST/GET /messages`, `POST /messages/:id/retry`,
  `POST /messages/retry-due`, `POST /messages/delivery-status`,
  `POST/GET /message-templates`, `POST /consent`, `GET /consent/:patientId`,
  `POST/GET /messaging-policy` (this increment).
- AI: `POST /ai/intake`, `POST /ai/summaries/patient/:patientId`,
  `GET /ai/drafts`, `GET /ai/drafts/:id`,
  `POST /ai/drafts/:id/confirm`, `POST /ai/drafts/:id/reject`.
- AI governance (E3): `GET /ai/policy`, `POST /ai/policy` (ADMIN only).
- AI Action Kernel (E4): `POST/GET /ai/identities`, `POST /ai/identities/:id/disable`,
  `GET /ai/tools`, `POST /ai/actions/authorize`, `POST /ai/actions/confirm`,
  `POST /ai/actions/execute` (identity/tool/authorize/execute gated by
  `ai:identity-manage`; confirm gated by `ai:action-confirm`; both ADMIN-only).

## Events (in `domain/events.automation.ts`)
- `AI_DRAFT_CREATED`, `AI_DRAFT_CONFIRMED`, `AI_DRAFT_REJECTED`. Emitted from
  HTTP-initiated actions only; the engine reads the event store but never writes
  to it, so no processing loop is possible.

## Permissions (in `governance/permissions.automation.ts`)
- `automation:manage`, `automation:read`, `messaging:send`, `messaging:read`,
  `messaging:manage`, `consent:manage`, `ai:draft-create`, `ai:draft-review`,
  `ai:summary-generate`, `ai:policy-manage` (E3), `ai:identity-manage` +
  `ai:action-confirm` (E4). All AI-governance perms are ADMIN-only (granted to no
  other role). These govern the kernel and are NEVER granted to an AI — an AI's
  authority is its `ai_identity.scopes`, a separate vocabulary absent from the RBAC catalog.
- Grants: RECEPTION (send/read/consent/draft-create), NURSE (read/draft-create/
  review/summary), DOCTOR (review/summary/read). ADMIN gets all automatically.
  **PHARMA_REP is granted NONE** (verified) — no patient-linked capability.

## AI provider changes
- `modules/ai/providers/*`: `AIProvider` interface + `LocalAIProvider`
  (deterministic, grounded, no network) + a swappable registry. A cloud/self-hosted
  model implements `AIProvider` and is registered at startup — no caller changes.

## WhatsApp / messaging changes
- `modules/messaging/*`: `MessagingProvider` interface + `NoopMessagingProvider`
  default + registry. Standard template keys (author per clinic): `appointment_reminder`,
  `appointment_confirmation`, `no_show_recovery`, `recall`, `follow_up`,
  `package_reminder`. Real WhatsApp/SMS/Email adapters plug into the registry.

## Automation changes
- `modules/automation/*`: types + zod validation, pure condition evaluator,
  action registry (`send_message`, `noop`), repo, idempotent engine, offset-based
  dispatcher, admin service. Extend by registering a new action handler.

## Tests (37 new; 67 total green)
- Unit: condition evaluator; template render + recipient masking; local AI
  provider (grounded extraction, no-fabrication summary).
- Integration: consent gate (opt-in required, opt-out honored), PHI-safe log,
  send idempotency, retry + delivery-status, provider-swap via registry, authz
  (pharma forbidden), cross-clinic isolation; automation authz, once-per-event
  idempotency, condition filtering, disabled no-op, run history, end-to-end
  WhatsApp-on-check-in; AI review-first drafts (never auto-write), confirm/reject
  lifecycle, summary citations, observability, append-only AI audit.

## Dependencies Added
- None. Uses existing `fastify`, `pg`, `zod`.

## Contract Changes
- **CCR-001 (PROPOSED)** — intake-draft → clinical intake write target. Needed to
  complete A004's confirmed-draft promotion. Consumes Agent 2's C001 intake
  contract; write must go only through the confirmed-draft flow. See
  `CONTRACT_CHANGE_REQUEST.md`.

## Known Issues / Blockers
- A004 clinical write step blocked on C001 (Agent 2) + CCR-003 approval (satisfied
  by Agent 2's human-invoked intake endpoint; server-side auto-promotion DEFERRED).
- Cron-style time-triggered rules (`trigger_type='schedule'`): the durable time
  engine now exists (`scheduled_action` + `runDueActions`); a periodic worker/cron
  that calls `runDueActions`/`processNewEvents` on an interval is an ops-wiring
  follow-up (both are exposed as admin endpoints and are directly callable).
- Email channel cannot auto-address a patient (no email column in core schema);
  email works with an explicit `to`. Flagged for a future core-schema CCR if needed.

## Next increments (planned, per the AI/Automation expansion program)
- **Tasks & escalation** (Phases 21/22): `task` table + `create_task` action +
  escalation policies → enables no-show recovery / follow-up staff worklists that
  ride on the events Agent 2 already emits (FOLLOW_UP_OVERDUE-style, no-show).
- **Patient-journey rule pack** (Phase 34): example rules over real clinical events
  (`ENCOUNTER_COMPLETED`, `FOLLOW_UP_SCHEDULED`, `PRESCRIPTION_ISSUED`).
- **AI Action Guard + agent tool-permissions** (Phases 29/31), **AI data
  classification + PHI firewall** (Phases 9/33), **prompt/output governance**
  (Phases 27/28) on top of the existing review-first layer.
- On CCR-003 follow-up: server-side confirmed-intake-draft → clinical write.

## Last Commit
- `platform(A3-E4): AI Action Security Kernel — identity, tool registry, risk, Action Guard, confirmation`
  on branch `claude/magical-gates-bgfexk` (rebased onto `integration/medcore-v1` @ 97f1680).
- Prior: E3 (AI governance layer), E2 (scheduling & time engine).

## Known limitations (E4)
- **Structural enforcement is by convention at the module edge.** `executeAiAction`
  is the only public execution path (tool handlers are closures inside the registry,
  not exported), but a developer editing `modules/ai/**` could still call a handler
  directly. A lint/architecture rule to forbid that is a follow-up.
- Real handlers for the authorization-only read tools (`patient.search`,
  `appointment.read`, `report.read`) are intentionally absent — they read another
  workstream's data and must be provided by the owner via a CCR.
- The E3 tenant AI policy hook (`policy_denied`) never fires today (E3 `decide`
  returns ALLOW_LOCAL/ALLOW_CLOUD, never DENY); the hook is wired for when it does.

## Next increment (planned — deferred deliberately)
Structured-output schema validation (Phase 12), prompt/output governance
(Phases 27/28), then BOUNDED agents (Reception, Scheduling, Documentation…) that
call `executeAiAction` — never one unrestricted agent. Only after the kernel is
proven and integrated. Autonomous execution remains OUT until then.
