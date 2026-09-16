# Agent 2 — Clinical Core — State

## Current Status
IN PROGRESS. Working the C0xx series on branch `claude/inspiring-cori-tk3ej8`
(branched from Agent 1's foundation branch `claude/serene-mendel-u5rxdv`).

## Completed
- **C001 — Clinical intake + vitals.** Structured intake (chief complaint +
  history) and vitals capture on an encounter, plus the encounter status
  machine (`checked_in → intake → ready`, cancel).
- **C002 — Doctor workspace + encounter clinical fields.** Consultation
  lifecycle (claim / audited handover / complete), complaint, examination,
  assessment, diagnoses, treatment plan, append-only clinical notes, and the
  permission-shaped workspace read with previous visits.

- **C003 — Save & Next (queue advance).** Atomic complete-then-claim, plus a
  standalone "take the next patient" entry point.

- **C004 — Patient timeline.** One chronological stream of every clinical
  record for a patient, keyset-paginated.

- **C005 — Treatment response episodes.** Longitudinal treatment episodes with
  an append-only response series, completion and discontinuation.

- **C006 — Report engine.** Neutral document model plus a dependency-free
  PDF 1.4 renderer; encounter and patient summary reports.

## In Progress
- C007 — Prescriptions and follow-ups (see Discrepancies: in the workstream
  mission, absent from `TASKS.md`).

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
- `0101_clinical_encounter.sql`
  - `encounter_clinical` — 1:1 consultation record (complaint, examination,
    `attending_doctor_id`, `started_at`, `completed_at`). Kept out of the
    foundation-owned `encounter` table so no shared table changes shape.
  - `assessment` — 1:1, summary + severity.
  - `diagnosis` — many per encounter; partial unique index allows at most one
    `primary`; CHECK rejects a code without its coding system.
  - `treatment_plan` — 1:1, summary, instructions, `follow_up_in_days`.
  - `clinical_note` — append-only (statement-level trigger, same as `event` and
    `audit_log`); a correction is a new note linked via `supersedes_id`.
- `0102_treatment_episode.sql`
  - `treatment_episode` — spans encounters; CHECKs tie `ended_on` to a
    non-active status, keep `ended_on >= started_on`, and allow a
    `discontinuation_reason` only on a discontinuation.
  - `treatment_response` — append-only observation series; "latest response" is
    derived in the query, never denormalized onto the episode where it could
    drift from the observations it summarizes.

## API Changes
| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| POST | `/encounters/:id/intake` | `intake:record` | Upsert; auto-advances `checked_in → intake` |
| GET | `/encounters/:id/intake` | `intake:read` | |
| POST | `/encounters/:id/vitals` | `vitals:record` | Returns `{ vital, abnormal[] }` |
| GET | `/encounters/:id/vitals` | `vitals:read` | Newest first |
| POST | `/encounters/:id/status` | `encounter:status` | `intake`/`ready`/`cancelled` only |
| GET | `/encounters/:id` | `encounter:read` | Sections shaped by permission |
| POST | `/encounters/:id/start` | `encounter:clinical:write` | Claim or audited handover |
| PATCH | `/encounters/:id/clinical` | `encounter:clinical:write` (+`treatment:write` for the plan) | Partial |
| POST | `/encounters/:id/diagnoses` | `diagnosis:write` | |
| PATCH | `/encounters/:id/diagnoses/:diagnosisId` | `diagnosis:write` | Audited before/after |
| POST | `/encounters/:id/notes` | `note:write` | Append-only |
| POST | `/encounters/:id/complete` | `encounter:complete` | Requires assessment or diagnosis |
| POST | `/encounters/:id/complete-and-next` | `encounter:complete` + `encounter:clinical:write` | Atomic; returns `{ completed, next }` |
| POST | `/queue/next` | `encounter:clinical:write` | Claim the next waiting patient |
| GET | `/patients/:id/timeline` | `timeline:read` | `?limit` (1–100, default 50), `?cursor`; returns `{ entries, nextCursor }` |
| POST | `/patients/:id/treatment-episodes` | `treatment_episode:write` | |
| GET | `/patients/:id/treatment-episodes` | `treatment_episode:read` | `?status`, `?limit` |
| GET | `/treatment-episodes/:id` | `treatment_episode:read` | Episode + full response series |
| POST | `/treatment-episodes/:id/responses` | `treatment_episode:write` | |
| POST | `/treatment-episodes/:id/end` | `treatment_episode:write` | `completed` or `discontinued` |
| GET | `/reports/encounter/:id.pdf` | `report:generate` | `application/pdf`, filename `encounter-<uuid>.pdf` |
| GET | `/reports/patient/:id.pdf` | `report:generate` | `application/pdf`, filename `patient-<uuid>.pdf` |

No existing endpoint changed shape.

## Permission Changes
Added to `permissions.clinical.ts` (own file — not a contract change):
`encounter:status`, `intake:record`, `intake:read`, `vitals:record`,
`vitals:read`, `encounter:clinical:read`, `encounter:clinical:write`,
`encounter:complete`, `diagnosis:write`, `treatment:write`, `note:write`,
`timeline:read`, `treatment_episode:read`, `treatment_episode:write`,
`report:generate`.

Grants — the operational/clinical authority split:
- RECEPTION: `encounter:status` only. **No** clinical read or write.
- NURSE: intake + vitals record/read, `encounter:clinical:read` (read-only).
- DOCTOR: everything above plus every clinical write and `encounter:complete`.
- `timeline:read`, `treatment_episode:read` → NURSE, DOCTOR.
- `treatment_episode:write`, `report:generate` → DOCTOR.
- ADMIN inherits all automatically.

## Event Changes
Added to `events.clinical.ts`: `INTAKE_RECORDED`, `VITALS_RECORDED`,
`ENCOUNTER_STARTED`, `ENCOUNTER_CLINICAL_UPDATED`, `DIAGNOSIS_RECORDED`,
`DIAGNOSIS_REVISED`, `TREATMENT_PLAN_RECORDED`, `CLINICAL_NOTE_ADDED`,
`ENCOUNTER_COMPLETED`, `TREATMENT_EPISODE_STARTED`,
`TREATMENT_RESPONSE_RECORDED`, `TREATMENT_EPISODE_ENDED`,
`CLINICAL_REPORT_GENERATED`.

Every payload carries identifiers and shape only: intake carries no complaint or
history text; vitals carry abnormal **field names** but never measured values;
clinical updates carry the names of the sections touched, never their content.

## Files Owned / Modified
- Added: `modules/clinical/{encounter.repo,status.service,intake.repo,intake.service,vitals.repo,vitals.service,encounter.clinical.repo,workspace.service}.ts`,
  `modules/clinical/{timeline,episodes}.service.ts`,
  `modules/clinical/report/{pdf,report.service}.ts`,
  `modules/workflow/queue.service.ts`,
  `http/routes/{intake,encounters,treatment,reports}.routes.ts`,
  `db/migrations/{0100_clinical_intake_vitals,0101_clinical_encounter,0102_treatment_episode}.sql`,
  `test/integration/{intake,workspace,queue,timeline,episodes,reports}.test.ts`,
  `test/unit/pdf.test.ts`.
- Modified (all Agent-2 owned): `permissions.clinical.ts`, `events.clinical.ts`,
  `http/features/clinical.feature.ts`, `http/routes/{patients,workflow}.routes.ts`,
  `modules/workflow/checkin.service.ts` (now reuses the shared `encounter.repo`
  types instead of redeclaring them).

## Tests
- `test/integration/intake.test.ts` — 24 tests: intake upsert semantics, status
  auto-advance, AI-confirmation gate, validation, vitals range/pair/empty-set
  rejection, BMI derivation, abnormal flagging, RBAC denial for RECEPTION,
  cross-clinic 404, and no-PHI-in-audit/event assertions.
- `test/integration/workspace.test.ts` — 24 tests: claim/handover authority,
  doctor-only completion, one-primary-diagnosis rule, diagnosis-revision audit
  before/after, append-only note enforcement at the DB level, record closed
  after completion, permission-shaped workspace read, cross-clinic 404.
- `test/integration/queue.test.ts` — 8 tests, including a genuine concurrency
  test: two overlapping transactions claim while the first still holds its row
  lock uncommitted, proving `FOR UPDATE SKIP LOCKED` never hands one patient to
  two doctors. Also FIFO ordering, empty queue, cross-clinic isolation, and
  rollback (a refused completion leaves the next patient queued).
- `test/integration/timeline.test.ts` — 8 tests: every record type present,
  newest-first ordering, full keyset walk asserting no entry is skipped or
  repeated, page-size bounds, malformed cursor rejection, patient and clinic
  isolation, RBAC, and a no-PHI audit assertion.
- `test/integration/episodes.test.ts` — 15 tests: longitudinal response series
  and derived latest response, append-only enforcement, discontinuation-reason
  rules, chronology guards, cross-patient encounter reference rejection, status
  filtering, nurse read-only, reception fully denied, cross-clinic 404, no-PHI
  audit, and timeline integration.
- `test/unit/pdf.test.ts` — 9 tests: PDF structure, byte-accurate xref offsets
  (every offset must land on its own object header), byte determinism,
  pagination and page numbering, PDF string-escaping of injected operators,
  non-Latin-1 substitution, and wrapping bounds.
- `test/integration/reports.test.ts` — 10 tests: report content, no patient name
  in the filename, identical bytes for the same data and stamp, patient summary,
  empty-visit rendering, RBAC denial for nurse and reception, 401 unauthenticated,
  cross-clinic 404, and a no-PHI audit assertion.

Suite: **128 passing** (30 inherited + 98 new). Typecheck and build clean.
Output was additionally verified against a real PDF parser (`pypdf`): the
generated report opens, paginates to 3 pages and extracts the expected text.

## Dependencies Added
None.

## Contract Changes
- None filed. The **intake write contract** for Agent 3's A004 is published in
  `docs/workstreams/clinical-core.md`; it needs no shared-file change.

## Known Issues / Discrepancies
- **One unreproduced test failure.** A single `npm test` run (immediately after
  C006 landed) reported `1 failed | 127 passed`; the summary was truncated
  before I captured which test. Eight consecutive full runs since have been
  green (128/128), so I could not reproduce or diagnose it. Recording it rather
  than assuming it was environmental — if it recurs, the suspects are the
  30s hook/test timeout under load and the two explicit pool connections held
  by the queue concurrency test against a `max: 10` pool.
- **PDF text is Latin-1 only.** The renderer uses the base-14 Helvetica faces
  with WinAnsi encoding and embeds no font, so characters outside Latin-1 —
  Arabic patient names in particular, which matters for the Egypt deployment —
  render as `?`. Fixing this needs an embedded Unicode font (a font asset plus
  TrueType subsetting, or a PDF dependency). Raised for Agent 1 to decide at
  I001 rather than pulling in a dependency unilaterally; the report engine
  builds a neutral document model, so swapping the renderer changes nothing
  about how reports are composed or authorized.
- `AGENTS.md` §2 names Agent 2's branch `agent-2/clinical-core`; the harness
  assigned `claude/inspiring-cori-tk3ej8`. Per §2 the ownership rules still
  apply, so work proceeds on the harness branch. Flagged for Agent 1 at I001.
- Two rules were added that `TASKS.md` does not specify, because a consultation
  record without them is unsafe: (1) a clinical write requires the writer to be
  the attending doctor, so a second clinician must perform an audited handover
  first; (2) completing a consultation requires an assessment or a diagnosis, so
  a closed visit cannot be an empty hole in the patient history. Both are
  documented here for Agent 1 rather than assumed.
- `TASKS.md` C001 lists "authz (nurse/reception)" for intake. Implemented as
  nurse/doctor write with reception denied, because the operational/clinical
  authority split requires reception to hold no clinical permissions. Reception
  retains `encounter:status`. Raised here rather than silently reinterpreted.

## Blockers
None.

## Next Tasks
C007 — prescriptions and follow-ups (completes the workflow this workstream owns).

## Last Commit
- (see branch head)
