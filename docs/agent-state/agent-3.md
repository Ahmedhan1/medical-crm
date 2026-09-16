# Agent 3 — AI / Automation / WhatsApp — State

## Current Status
A001, A002, A003 and A005 are IMPLEMENTED, tested, and green. A004 (AI intake)
is implemented up to the review-first draft boundary; the clinical-write handoff
is BLOCKED on Clinical Core (C001) and filed as CCR-001. Branch built on the
foundation branch; ready for integration review.

Verification (in `server/`): `npm run typecheck` clean · `npm test` 67 passing
(30 pre-existing + 37 new) · `npm run build` clean · `npm run migrate` applies
`0001_core, 0200_automation` · `npm run seed` seeds all 9 new permissions.

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
- All tenant-scoped (`clinic_id`), `timestamptz` timestamps, idempotency enforced
  by unique keys. FKs reference the shared foundation schema (`clinic`, `patient`,
  `app_user`) only; no other workstream's tables are touched.

## API Changes (all new, registered via `automation.feature.ts`)
- Automation: `POST/GET /automations`, `GET/PATCH/DELETE /automations/:id`,
  `GET /automations/:id/runs`, `POST /automations/process`.
- Messaging: `POST/GET /messages`, `POST /messages/:id/retry`,
  `POST /messages/retry-due`, `POST /messages/delivery-status`,
  `POST/GET /message-templates`, `POST /consent`, `GET /consent/:patientId`.
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
- A004 clinical write step blocked on C001 (Agent 2) + CCR-001 approval.
- Scheduled (`trigger_type='schedule'`) rules: schema + validation in place; the
  cron dispatcher is a follow-up (event triggers are fully implemented).
- Email channel cannot auto-address a patient (no email column in core schema);
  email works with an explicit `to`. Flagged for a future core-schema CCR if needed.

## Next Tasks
- On C001 + CCR-001 approval: implement confirmed-intake-draft → clinical write.
- Scheduled-trigger dispatcher (appointment reminders on a time basis) once an
  appointment/schedule source exists in Clinical Core.

## Last Commit
- `A00x: AI + WhatsApp + Automation platform layer (engine, messaging, review-first AI)`
  on branch `claude/magical-gates-bgfexk`.
