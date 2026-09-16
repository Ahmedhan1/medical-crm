# Agent 2 — Clinical Platform — State

## Current Status
Clinical Platform program **CP-1 and CP-2 delivered** on branch
`claude/inspiring-cori-tk3ej8`, which is fast-forwarded onto
`integration/medcore-v1` (Agent 1's integrated tree, including I001 hardening
and platform Phase 1). The earlier C001–C007 Clinical Core series is merged and
live in the integrated branch.

Suite: **431 tests / 32 files green.** Typecheck, build and a from-empty
migration run (14 migrations) all clean.

## Completed

### Clinical Core (C001–C007) — merged at integration
Intake + vitals, doctor workspace, Save & Next, patient timeline, treatment
episodes, report engine, prescriptions + follow-ups. See git history.

### CP-1 — Patient lifecycle *(migration 0104)*
- `patient` extended: `status` (active/inactive/deceased/merged),
  `deceased_date`, `merged_into_id`, `preferred_language`, `email`, `address`.
  Purely additive; no existing column, constraint or index changed.
- `patient_identifier` — external identifiers; `system` is free text because
  identifier schemes are jurisdictional. Unique on (clinic, system, value), so a
  duplicate passport is a 409 at the moment reception types it.
- `patient_contact` — emergency contact / next of kin / guardian; a contact with
  no phone and no email is rejected by the schema; promoting a primary demotes
  the previous one in the same transaction.
- `patient_merge` — append-only ledger.
- **Merge links, it does not rewrite.** Clinical tables are append-only at the
  database level, so repointing their `patient_id` is impossible by construction
  — and correct: a note was written about the record the clinician was looking
  at. The loser is marked merged and points at the survivor;
  `resolvePatientLineage` makes longitudinal reads whole. The timeline uses it.
- Duplicate detection is deterministic and explainable (national id, phone, name
  + date of birth); every candidate reports which signal matched. No fuzzy score.
- **Bug fixed:** `date` columns arrive from `pg` as JS `Date`, so `birthDate`
  serialized as a UTC timestamp and rendered as the previous day west of UTC.
  Normalized through `modules/clinical/dates.ts`. Visible response change,
  declared in CCR-006.

### CP-2 — Appointment & scheduling engine *(migration 0105)*
- `clinical_resource` (room/chair/equipment), `appointment_type`, `appointment`,
  `appointment_status_history` (append-only).
- Lifecycle allow-list: scheduled → confirmed → arrived → waiting →
  in_consultation → completed, with cancelled / no_show /
  left_without_being_seen as alternative terminals.
- **Room conflicts are a database EXCLUDE constraint** (`btree_gist`); cancelled
  and completed appointments release the slot.
- **Practitioner conflicts are policy, not a constraint** — refused by default,
  permitted with an audited `allowDoubleBooking` by a holder of
  `appointment:overbook`, because clinics overbook deliberately.
- `in_consultation` / `completed` follow the linked encounter, not the desk.
- Arrival opens an encounter through the existing check-in service and lands the
  patient on the existing queue; done before the appointment transaction so a
  failure cannot leave an appointment arrived with no visit.

## Database Changes
Migration range **0100–0199**. Used: 0100, 0101, 0102, 0103, **0104, 0105**.
0105 requires the `btree_gist` contrib extension (created by the migration; a
role that cannot `CREATE EXTENSION` needs a DBA to enable it first).

## API Changes
New in CP-1: `PATCH /patients/:id`, `POST /patients/:id/status`,
`GET /patients/:id/duplicates`, `POST /patients/:id/merge`,
`POST|GET /patients/:id/identifiers`, `DELETE /patients/:id/identifiers/:id`,
`POST|GET /patients/:id/contacts`, `DELETE /patients/:id/contacts/:id`.

New in CP-2: `POST|GET /appointments`, `GET|PATCH /appointments/:id`,
`POST /appointments/:id/status`, `GET /patients/:id/appointments`,
`POST|GET /schedule/resources`, `POST|GET /appointment-types`.

Changed: `GET /patients/:id` — `birthDate` is now `YYYY-MM-DD` (see CCR-006).
No other existing endpoint changed shape.

## Permission Changes
Added (own file, not a contract change): `patient:update`, `patient:merge`,
`patient:contact:read|write`, `patient:identifier:read|write`,
`appointment:read|schedule|update|cancel|arrival|overbook`,
`schedule:config:read|manage`.

Grants keep the operational/clinical split: reception runs the patient index and
the front desk; nurse reads contacts/identifiers and moves patients through the
waiting room but cannot open a visit or book; doctor books and reschedules;
`patient:merge` and `schedule:config:manage` are ADMIN-only. Verified against the
seeded database: **PHARMA_REP holds zero patient, appointment or schedule
permissions.**

## Event Changes
Added: `PATIENT_UPDATED`, `PATIENT_STATUS_CHANGED`, `PATIENT_MERGED`,
`APPOINTMENT_SCHEDULED`, `APPOINTMENT_CONFIRMED`, `APPOINTMENT_RESCHEDULED`,
`APPOINTMENT_CANCELLED`, `APPOINTMENT_NO_SHOW`,
`APPOINTMENT_LEFT_WITHOUT_BEING_SEEN`, `APPOINTMENT_COMPLETED`,
`PATIENT_ARRIVED`.

Naming stays SCREAMING_SNAKE. The program brief suggests `appointment.created`
style, but Agent 3's automation matches `automation_rule.event_type` as a plain
string, so renaming would silently break every existing rule. Raised, not changed.

## Tests
- `test/integration/patient-lifecycle.test.ts` — 28
- `test/integration/appointments.test.ts` — 33
Covering lifecycle transitions, merge semantics and lineage, identifier
uniqueness, contact primary-demotion, room double-booking (and slot release),
deliberate overbooking, encounter-driven appointment status, arrival atomicity,
RBAC per role, cross-tenant isolation, append-only enforcement, and PHI
containment in audit metadata and event payloads.

## Dependencies Added
None. Runtime deps remain `fastify`, `pg`, `qrcode`, `zod` (Agent 1's governance
allowlist test passes). One PostgreSQL contrib extension: `btree_gist`.

## Contract Changes
- **CCR-006 (PROPOSED)** — patient record extension. Additive schema plus the
  `birthDate` serialization fix. Consumer notes for Agent 3 (a `merged` record
  should not be messaged; `preferred_language` is available for template locale)
  and for anyone reading `patient_id` longitudinally (resolve lineage or
  under-report a merged patient's history).
- Earlier: CCR-001 (medication reference) and CCR-003 (AI intake) remain as
  resolved at integration.
- No shared/contract file edited.

## Known Issues / Open Risks
1. **Allergies are free text only (CP-8).** `intake.allergies` is a text field;
   there is no structured allergy record and therefore **no prescribing safety
   check anywhere in the platform**. This is the highest-severity clinical gap
   and is the intended next major increment after CP-3.
2. **PDF reports are Latin-1 only.** Arabic renders as `?`. Tracked by Agent 1
   as roadmap F-03/Phase 5 (needs an embedded Unicode font).
3. **Recurring appointments and the waitlist are not built.** Deferred
   deliberately; recurrence needs a series table plus an expansion/exception
   policy.
4. **`docs/GOVERNANCE.md` permission matrix is stale** (Agent 1's file).

## Blockers
None.

## Next Tasks
- **CP-3** — triage engine with extensible structured observations (units,
  reference ranges, custom observations, performer/source), keeping the core
  specialty-neutral and FHIR-Observation-shaped.
- **CP-8** — allergy & safety engine, then deterministic prescribing checks.
See `docs/workstreams/clinical-core.md` for the full CP-1..CP-21 status table.

## Last Commit
- `platform(clinical P2): appointment and scheduling engine`
