# Agent 2 — Clinical Core — State

## Current Status
IN PROGRESS. Working the C0xx series on branch `claude/inspiring-cori-tk3ej8`
(branched from Agent 1's foundation branch `claude/serene-mendel-u5rxdv`).

## Completed
- **C001 — Clinical intake + vitals.** Structured intake (chief complaint +
  history) and vitals capture on an encounter, plus the encounter status
  machine (`checked_in → intake → ready`, cancel).

## In Progress
- C002 — Doctor workspace + encounter clinical fields.

## Database Changes
Reserved migration range **0100–0199**.
- `0100_clinical_intake_vitals.sql`
  - `intake` — one revisable row per encounter (unique `encounter_id`);
    provenance columns `source ∈ {staff, ai_assisted}`, `source_ref`,
    `confirmed_by`; CHECK rejects an `ai_assisted` row with no confirming human.
  - `vital` — row per measurement set (repeat measurements are new rows);
    hard physiological CHECK bounds on every measurement; `bmi` is a GENERATED
    STORED column; CHECKs reject an empty set, an unpaired blood pressure, and
    systolic ≤ diastolic.

## API Changes
| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/encounters/:id/intake` | `intake:record` | Upsert; auto-advances `checked_in → intake` |
| GET | `/encounters/:id/intake` | `intake:read` | |
| POST | `/encounters/:id/vitals` | `vitals:record` | Returns `{ vital, abnormal[] }` |
| GET | `/encounters/:id/vitals` | `vitals:read` | Newest first |
| POST | `/encounters/:id/status` | `encounter:status` | `intake`/`ready`/`cancelled` only |

No existing endpoint changed shape.

## Permission Changes
Added to `permissions.clinical.ts` (own file — not a contract change):
`encounter:status`, `intake:record`, `intake:read`, `vitals:record`,
`vitals:read`. Granted: `encounter:status` → RECEPTION, NURSE, DOCTOR; the
intake/vitals permissions → NURSE, DOCTOR only. RECEPTION deliberately gets **no**
clinical read or write — it keeps operational authority only. ADMIN inherits all.

## Event Changes
Added to `events.clinical.ts`: `INTAKE_RECORDED`, `VITALS_RECORDED`.
Both payloads carry identifiers and shape only — intake carries no complaint or
history text, vitals carry abnormal **field names** but never measured values.

## Files Owned / Modified
- Added: `modules/clinical/{encounter.repo,status.service,intake.repo,intake.service,vitals.repo,vitals.service}.ts`,
  `http/routes/intake.routes.ts`, `db/migrations/0100_clinical_intake_vitals.sql`,
  `test/integration/intake.test.ts`.
- Modified (all Agent-2 owned): `permissions.clinical.ts`, `events.clinical.ts`,
  `http/features/clinical.feature.ts`, `modules/workflow/checkin.service.ts`
  (now reuses the shared `encounter.repo` types instead of redeclaring them).

## Tests
`test/integration/intake.test.ts` — 24 tests: intake upsert semantics, status
auto-advance, AI-confirmation gate, validation, vitals range/pair/empty-set
rejection, BMI derivation, abnormal flagging, RBAC denial for RECEPTION,
cross-clinic 404, and no-PHI-in-audit/event assertions.
Suite: **54 passing** (30 inherited + 24 new). Typecheck and build clean.

## Dependencies Added
None.

## Contract Changes
- None filed. The **intake write contract** for Agent 3's A004 is published in
  `docs/workstreams/clinical-core.md`; it needs no shared-file change.

## Known Issues / Discrepancies
- `AGENTS.md` §2 names Agent 2's branch `agent-2/clinical-core`; the harness
  assigned `claude/inspiring-cori-tk3ej8`. Per §2 the ownership rules still
  apply, so work proceeds on the harness branch. Flagged for Agent 1 at I001.
- `TASKS.md` C001 lists "authz (nurse/reception)" for intake. Implemented as
  nurse/doctor write with reception denied, because the operational/clinical
  authority split requires reception to hold no clinical permissions. Reception
  retains `encounter:status`. Raised here rather than silently reinterpreted.

## Blockers
None.

## Next Tasks
C002 → C003 → C004 → C005 → C006 (see `TASKS.md`).

## Last Commit
- (see branch head)
