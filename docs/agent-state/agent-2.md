# Agent 2 — Clinical Core — State

## Current Status
NOT STARTED. Foundation is ready (see agent-1 handoff). Read `AGENTS.md` and
`docs/workstreams/clinical-core.md` before writing code.

## Completed
- (Inherited from foundation) patient register/search/get, encounter check-in,
  queue. These are yours to extend now.

## In Progress
- —

## Database Changes
- Reserved migration range: **0100–0199**. None added yet.

## API Changes
- None yet. Planned: intake, vitals, encounter clinical fields, timeline, reports.

## Files Owned
- `modules/identity/patients.*`, `modules/clinical/**`, `modules/workflow/**`,
  `governance/permissions.clinical.ts`, `domain/events.clinical.ts`,
  `http/routes/patients.routes.ts`, `workflow.routes.ts`, `http/features/clinical.feature.ts`.

## Files Modified
- —

## Tests
- Inherited clinical tests green. Add tests for each new task.

## Dependencies Added
- —

## Contract Changes
- Planned: publish the intake write contract for Agent 3's A004.

## Known Issues / Blockers
- None.

## Next Tasks
C001 → C002 → C003 → C004 → C005 → C006 (see `TASKS.md`).

## Last Commit
- —
