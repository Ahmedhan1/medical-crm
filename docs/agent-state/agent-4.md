# Agent 4 — Pharma / HCP / Drug / Intelligence — State

## Current Status
NOT STARTED. Foundation is ready (see agent-1 handoff). Read `AGENTS.md` and
`docs/workstreams/pharma-intelligence.md` before writing code.

## Completed
- —

## In Progress
- —

## Database Changes
- Reserved migration range: **0300–0399**. None added yet.

## API Changes
- None yet. Planned: HCP master, drug master, territory/rep, content hub, signals.

## Files Owned
- `modules/pharma/**`, `modules/hcp/**`, `modules/drug/**`, `modules/intelligence/**`,
  `governance/permissions.pharma.ts`, `domain/events.pharma.ts`,
  `http/features/pharma.feature.ts`.

## Files Modified
- —

## Tests
- Add tests per task; MANDATORY: pharma principal cannot reach any patient row;
  intelligence returns nothing below cohort threshold; provenance required.

## Dependencies Added
- —

## Contract Changes
- Planned: request a governed aggregate-only read contract from Agent 1 (P005).

## Known Issues / Blockers
- P005 (intelligence firewall) BLOCKED on the Agent 1 governed-read contract.
- Reminder: pharma roles hold ZERO clinical permissions (do not change this).

## Next Tasks
P001 → P002 → P003 → P004; P005 after the read contract (see `TASKS.md`).

## Last Commit
- —
