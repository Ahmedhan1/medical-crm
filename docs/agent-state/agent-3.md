# Agent 3 — AI / Automation / WhatsApp — State

## Current Status
NOT STARTED. Foundation is ready (see agent-1 handoff). Read `AGENTS.md` and
`docs/workstreams/ai-automation.md` before writing code.

## Completed
- —

## In Progress
- —

## Database Changes
- Reserved migration range: **0200–0299**. None added yet.

## API Changes
- None yet. Planned: automations CRUD + runs, messaging, AI drafts/summaries.

## Files Owned
- `modules/automation/**`, `modules/ai/**`, `modules/messaging/**`,
  `governance/permissions.automation.ts`, `domain/events.automation.ts`,
  `http/features/automation.feature.ts`.

## Files Modified
- —

## Tests
- Add tests per task: idempotency, provider swap, consent gating, review-first AI.

## Dependencies Added
- —

## Contract Changes
- Planned: request Agent 2's intake write contract (for A004).

## Known Issues / Blockers
- A004 (AI intake) BLOCKED on C001 (Agent 2 intake tables).

## Next Tasks
A001 → A002 → A003 → A005; A004 after C001 (see `TASKS.md`).

## Last Commit
- —
