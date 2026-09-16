# Agent 2 — Clinical Platform — State

## Current Status
Clinical Platform program **CP-1, CP-2, CP-3 and CP-8 delivered** on branch
`claude/inspiring-cori-tk3ej8`, which is fast-forwarded onto
`integration/medcore-v1` (Agent 1's integrated tree, including I001 hardening
and platform Phase 1). The earlier C001–C007 Clinical Core series is merged and
live in the integrated branch.

Suite: **469 tests / 34 files green.** Typecheck, build and a from-empty
migration run (16 migrations) all clean.

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

### CP-3 — Extensible observation engine *(migration 0106)*
- `observation_definition` (per-clinic config catalog: value type, unit,
  physiological bounds, reference range, allowed codes) and `observation`
  (FHIR-Observation-shaped values). A specialty measurement is a definition row,
  not new code.
- **Reference ranges are DATA** — the abnormal flag is computed at record time
  from the definition and stored. This is the one thing the `vital` fast-path
  hard-codes, now per-clinic configurable.
- Does NOT replace `vital`; the universal vital set keeps its fast, CHECK-
  constrained path. Observations are the open extension for everything else.
- Value coercion/bounds are driven by the definition's value type, so a
  clinic-defined observation is validated exactly like a built-in one.

### CP-8 — Allergy & prescribing safety *(migration 0107)* — HIGHEST RISK, CLOSED
- `allergy` — structured record (substance, kind, category, severity, status,
  verification, onset); partial unique on active substance. `safety_override` —
  append-only ledger of every prescribe-through-alert.
- Deterministic prescribing check (`safety.service.ts`): allergy match
  (whole-word, conservative, ref-match definitive) + duplicate-medication.
  Reads the patient's merge lineage.
- Refuse-then-acknowledge: blocked by default, returns the alerts; a doctor with
  `safety:override` prescribes through with a required reason, ledgered and
  audited. AI cannot bypass (no prescribing principal; override is a human act).
- Dry-run preview endpoint; allergies on the workspace.

## Database Changes
Migration range **0100–0199**. Used: 0100–0103, **0104, 0105, 0106, 0107**.
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

New in CP-3: `POST|GET /observation-definitions`, `POST /observations`,
`GET /encounters/:id/observations`, `GET /patients/:id/observations`.

New in CP-8: `POST|GET /patients/:id/allergies`,
`PATCH /patients/:id/allergies/:allergyId`,
`POST /encounters/:id/prescription-safety-check`.

Changed: `GET /patients/:id` — `birthDate` is now `YYYY-MM-DD` (see CCR-006).
`POST /encounters/:id/prescriptions` gains optional `acknowledgeAlerts` +
`overrideReason` (additive; absent = old behaviour unless an alert fires). No
existing endpoint changed response shape incompatibly.

## Permission Changes
Added (own file, not a contract change): `patient:update`, `patient:merge`,
`patient:contact:read|write`, `patient:identifier:read|write`,
`appointment:read|schedule|update|cancel|arrival|overbook`,
`schedule:config:read|manage`, `observation:record|read`,
`observation:config:read|manage`, `allergy:read|write`, `safety:override`.

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
`PATIENT_ARRIVED`, `OBSERVATION_RECORDED`, `ALLERGY_RECORDED`, `ALLERGY_UPDATED`,
`SAFETY_ALERT_OVERRIDDEN`.

Naming stays SCREAMING_SNAKE. The program brief suggests `appointment.created`
style, but Agent 3's automation matches `automation_rule.event_type` as a plain
string, so renaming would silently break every existing rule. Raised, not changed.

## Tests
- `test/integration/patient-lifecycle.test.ts` — 28
- `test/integration/appointments.test.ts` — 33
- `test/integration/observations.test.ts` — 18
- `test/integration/allergies-safety.test.ts` — 20
Covering lifecycle transitions, merge semantics and lineage, identifier
uniqueness, contact primary-demotion, room double-booking (and slot release),
deliberate overbooking, encounter-driven appointment status, arrival atomicity,
RBAC per role, cross-tenant isolation, append-only enforcement, and PHI
containment in audit metadata and event payloads.

## Dependencies Added
None. Runtime deps remain `fastify`, `pg`, `qrcode`, `zod` (Agent 1's governance
allowlist test passes). One PostgreSQL contrib extension: `btree_gist`.

## Contract Changes
- **CCR-007 (PROPOSED)** — coded drug↔allergen cross-reference to make the
  prescribing safety check precise once the drug master exposes codes. Additive;
  the engine already prefers a ref match. Governed read only.
- **CCR-006 (PROPOSED)** — patient record extension. Additive schema plus the
  `birthDate` serialization fix. Consumer notes for Agent 3 (a `merged` record
  should not be messaged; `preferred_language` is available for template locale)
  and for anyone reading `patient_id` longitudinally (resolve lineage or
  under-report a merged patient's history).
- Earlier: CCR-001 (medication reference) and CCR-003 (AI intake) remain as
  resolved at integration.
- No shared/contract file edited.

## Known Issues / Open Risks
1. **PDF reports are Latin-1 only.** Arabic renders as `?`. Tracked by Agent 1
   as roadmap F-03/Phase 5 (needs an embedded Unicode font).
3. **Recurring appointments and the waitlist are not built.** Deferred
   deliberately; recurrence needs a series table plus an expansion/exception
   policy.
4. **`docs/GOVERNANCE.md` permission matrix is stale** (Agent 1's file).

## Blockers
None.

## Next Tasks
- **CP-9** — document management (DocumentReference-shaped): lab/imaging/consent
  documents linked to patient/encounter/episode, metadata only (no blob storage
  in-DB), access-policy aware.
- **CP-10** — referral & care-coordination.
See `docs/workstreams/clinical-core.md` for the full CP-1..CP-21 status table.

## Last Commit
- `platform(clinical P8): allergy record and deterministic prescribing safety`
