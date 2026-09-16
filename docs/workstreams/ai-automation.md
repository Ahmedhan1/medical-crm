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
