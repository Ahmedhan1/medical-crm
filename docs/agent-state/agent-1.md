# Agent 1 — Foundation / Orchestration — State & Handoff

## Current Status
**Foundation & multi-agent scaffolding complete (F001 DONE).** The repo is ready
for Agents 2–4 to work in parallel. Build/typecheck/tests green; migrations and
seed verified.

## Completed
- Repository audit (verified against code, not just docs): backend-only,
  Fastify + PostgreSQL, one migration `0001_core`, 30 tests, no frontend.
- **Parallel-safety refactor** (removes cross-agent merge contention):
  - Permission catalog split → `permissions.clinical|automation|pharma.ts` with
    an Agent-1 barrel `permissions.ts` and a leaf `roles.ts` (RoleKey contract).
    ADMIN auto-gets all permissions; roles assembled from per-workstream grants.
  - Event catalog split → `events.clinical|automation|pharma.ts` + barrel `events.ts`.
  - HTTP routes → four stable feature aggregators
    (`http/features/*.feature.ts`); `server.ts` no longer changes per feature.
  - `resetDb()` truncates tables dynamically (no shared list to edit).
- Orchestration docs: `AGENTS.md`, `TASKS.md`, `CONTRACT_CHANGE_REQUEST.md`,
  `docs/workstreams/*`, `docs/agent-state/*`; updated `IMPLEMENTATION-STATUS.md`.

## In Progress
- None (handing off to Agents 2–4).

## Database Changes
- None beyond `0001_core` (unchanged). Ranges reserved per agent (AGENTS.md §6).

## API Changes
- None. Public API and error envelope unchanged; only internal wiring moved.

## Files Owned
See `AGENTS.md` §4 (Agent 1 section) — foundation + all shared contract files.

## Files Modified (this task)
- Added: `governance/roles.ts`, `permissions.{clinical,automation,pharma}.ts`,
  `domain/events.{clinical,automation,pharma}.ts`, `http/features/*.feature.ts`.
- Edited: `governance/permissions.ts` (now barrel), `domain/events.ts` (now
  barrel), `http/server.ts` (registers 4 aggregators), `test/helpers/db.ts`.

## Tests
- 30/30 passing (unit + integration + security). No tests weakened or skipped.
- Verified RBAC grants after refactor: ADMIN=8, RECEPTION=8, NURSE=5, DOCTOR=4,
  PHARMA_REP=0 (boundary intact).

## Dependencies Added
- None.

## Contract Changes
- None. Baseline contracts documented in `CONTRACT_CHANGE_REQUEST.md`.

## Known Issues
- No frontend yet (API-first). UI is a later task; not blocking backend agents.
- `agent-2/3/4` branches are not yet created in the remote (Agent 1 can only push
  its own designated branch). Each agent creates its branch from this one.

## Blockers
- None for Agent 1.

---

# HANDOFF

## What Agent 2 (Clinical Core) should do
- Read `AGENTS.md` + `docs/workstreams/clinical-core.md`.
- Branch `agent-2/clinical-core` from this foundation branch.
- Start C001 (intake+vitals) → C002 (doctor workspace) → C003 (Save&Next) →
  C004 (timeline) → C005 (treatment episodes) → C006 (reports).
- Add permissions/events/routes/tables ONLY in your files (`permissions.clinical.ts`,
  `events.clinical.ts`, `clinical.feature.ts`, migrations 0100–0199).
- Define the intake write contract Agent 3 (A004) will consume.

## What Agent 3 (AI/Automation) should do
- Read `AGENTS.md` + `docs/workstreams/ai-automation.md`.
- Branch `agent-3/ai-automation`.
- Start A001 (automation core) → A002 (provider abstraction) → A003 (WhatsApp)
  → A005 (AI summaries). A004 (AI intake) is BLOCKED on C001.
- Ship a local/no-op default provider (no vendor lock-in). AI output is
  review-first; the bot never diagnoses/prescribes.

## What Agent 4 (Pharma/Intelligence) should do
- Read `AGENTS.md` + `docs/workstreams/pharma-intelligence.md`.
- Branch `agent-4/pharma-intelligence`.
- Start P001 (HCP master) → P002 (drug master) → P003 (territory+rep) → P004
  (content hub). P005 (intelligence firewall) is BLOCKED on a governed-read
  contract from Agent 1.
- Grant pharma permissions only to pharma roles; never read clinical/patient
  tables; provenance on every reference field.

## Dependencies between agents
- A004 (Agent 3) → C001 intake contract (Agent 2).
- P005 (Agent 4) → governed aggregate-read contract (Agent 1) over the event store.
- All agents → the shared contracts owned by Agent 1 (see below).

## Files no agent may touch (except Agent 1 via CONTRACT_CHANGE_REQUEST)
`governance/roles.ts`, `governance/permissions.ts` (barrel),
`governance/rbac.ts`, `governance/audit.ts`, `domain/errors.ts`,
`domain/events.ts` (barrel), `db/pool.ts`, `config/env.ts`,
`http/server.ts`, `http/plugins/auth.ts`, `modules/qr/**`,
`modules/auth/**`, `seed.ts`, `test/helpers/**`, root build config.

## Contracts to honor
- API error envelope `{ error: { code, message, details? } }`.
- `Authorization: Bearer`; every service asserts a permission + scopes by clinic.
- QR payload `MEDCORE1:<opaque>` — no PHI.
- Append-only `audit_log` (no PHI in metadata) + `event` (emitted in-transaction).
- Every tenant table has `clinic_id`; timestamps `timestamptz`.
- Pharma ⊄ patient data; AI is review-first.

## Next Tasks (Agent 1)
- Review incoming CONTRACT_CHANGE_REQUESTs (esp. C001 intake contract, P005
  governed-read).
- F002 backup/restore, F003 observability, F004 user/role admin.
- I001 integration + final QA once Agents 2–4 land work.

## Last Commit
Set on push of F001 to `claude/serene-mendel-u5rxdv` (see git log).
