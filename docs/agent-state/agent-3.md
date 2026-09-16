# Agent 3 — AI / Automation / WhatsApp — State

## Current Status
Base: `integration/medcore-v1` (verified current source of truth: C001–C007,
A001–A005, P001–P006, I001 hardening, platform-P1 all integrated; 370 tests green
on entry). This increment adds the **Scheduling & Time Engine + engine hardening +
communication-quality guards** (program Phases 1, 3, 38) on top.

A001–A005 remain DONE (A004 review-first portion; clinical auto-promotion DEFERRED
per CCR-003). See the increment phase report at the bottom.

Verification (in `server/`): `npm run typecheck` clean · `npm run build` clean ·
26 new tests added (full suite green) · migrations `0001…0201, 0300…0304, 0900`
apply in order.

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
- Migration **`0201_scheduling.sql`** (this increment): `ALTER automation_rule`
  add `priority`, `version`; `ALTER automation_run` add `rule_version`; new tables
  `scheduled_action` (time engine) and `messaging_policy` (quiet hours + caps).
  Both new tables are `clinic_id`-scoped (governance tenant-isolation test passes).
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

## Events (in `domain/events.automation.ts`)
- `AI_DRAFT_CREATED`, `AI_DRAFT_CONFIRMED`, `AI_DRAFT_REJECTED`. Emitted from
  HTTP-initiated actions only; the engine reads the event store but never writes
  to it, so no processing loop is possible.

## Permissions (in `governance/permissions.automation.ts`)
- `automation:manage`, `automation:read`, `messaging:send`, `messaging:read`,
  `messaging:manage`, `consent:manage`, `ai:draft-create`, `ai:draft-review`,
  `ai:summary-generate`.
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
- `platform(A3-E2): scheduling & time engine, engine hardening, comms-quality guards`
  on branch `claude/magical-gates-bgfexk` (based on `integration/medcore-v1`).
