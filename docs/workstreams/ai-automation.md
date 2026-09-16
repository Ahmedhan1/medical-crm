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
