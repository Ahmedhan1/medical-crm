# Agent 2 — Clinical Platform — State

## Current Status
Clinical Platform program **CP-1, CP-2, CP-3, CP-8, CP-9, CP-16, CP-10, CP-11 delivered** on branch
`claude/inspiring-cori-tk3ej8`, which is fast-forwarded onto
`integration/medcore-v1` (Agent 1's integrated tree, now including platform
P2 backup engine, merged in this session). The earlier C001–C007 Clinical Core series is merged and
live in the integrated branch.

Suite: **534 tests / 40 files green.** Typecheck, build and a from-empty
migration run (18 migrations) all clean.

### Clinical OS production audit (on `agent2/clinical-os-audit`)
End-to-end production-readiness audit against baseline
`integration/medcore-v1 @ 308ff67`. Three genuine gaps fixed (additive, nothing
rewritten); the rest of the domain verified production-ready (QR opacity,
DB-enforced concurrency, DOCTOR-only clinical authority, Reception/Nurse and
PHARMA_REP correctly excluded, PHI-clean events/audit, keyset timeline).
- **0114** — append-only DB triggers on `vital` + `observation` (insert-only in
  code but lacked the DB guard the other immutable clinical tables have).
- **Encounter-cancel → appointment sync** — a cancelled encounter no longer
  strands its linked appointment live; it closes as `left_without_being_seen`
  (the state `ck_appointment_arrival` permits post-arrival), freeing the slot.
- **Patient 360 `recentVitals`** — VITALS_READ-gated patient-level vitals reader
  wired into the 360 view. No new table; composes the existing permission-checked
  reader.
Deferred: FHIR Observation mapping for the universal vital set (no consumer yet).

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

### CP-16 — Patient 360 *(read model, no migration)*
- `GET /patients/:id/360` composes existing permission-checked readers into one
  authorization-shaped summary; no new table, no duplicated SQL. Each section is
  gated by the caller's read permission (workspace pattern). Merged record
  flagged with `mergedIntoId`. Audited (section names only, no PHI).

### CP-10 — Referrals & care coordination *(migration 0109)*
- `referral` (ServiceRequest-like) + append-only `referral_status_history`.
  Deterministic lifecycle draft→ordered→sent→accepted/declined→scheduled→
  completed (+cancelled/expired); invalid transitions fail.
- Referral status IS the coordination state — no task table (Agent 3 owns tasks).
- Authority: create/complete → DOCTOR; manage (admin middle + linkage) →
  RECEPTION+DOCTOR; NURSE read-only. Master data via FKs; external provider is
  free text. Timeline + Patient 360 integrated; reason kept out of events.

### CP-11 — Overdue follow-up detection *(migration 0110, marker columns only)*
- Read-model + idempotent event sweep over existing `follow_up` — no new table.
  0110 adds `due_event_at`/`overdue_event_at` for event idempotency only.
- `classifyDueState` pure/total/inspectable. `GET /follow-ups/detection` (read),
  `POST /follow-ups/detection/run` (sweep, `followup:detect` DOCTOR) publishes
  FOLLOW_UP_DUE/OVERDUE once per follow-up using the server date. Detection
  modifies no clinical fact. Agent 3 consumes the events; Clinical Core sends
  nothing.

### CP-9 — Document references *(migration 0108)*
- `document_reference` (FHIR DocumentReference-shaped), METADATA ONLY — bytes
  are never in the DB; `storage_key` is an opaque pointer (byte storage = CCR-008,
  a platform decision). Integrity columns for verify-on-fetch.
- Versioning by supersession (old kept, never edited); void = entered_in_error.
- Access policy: `restricted` needs `document:read:restricted`; filtered from
  lists and not-found on direct read without it (existence does not leak); title
  redacted on the timeline. Links to patient/encounter/episode; merge-lineage
  aware.

## Database Changes
Migration range **0100–0199**. Used: 0100–0108, **0109, 0110**.
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

New in CP-9: `POST /documents`, `GET /documents/:id`, `POST /documents/:id/void`,
`GET /patients/:id/documents`.

New in CP-16: `GET /patients/:id/360`.

New in CP-10: `POST|GET /referrals`, `GET /referrals/:id`,
`POST /referrals/:id/status`.

New in CP-11: `GET /follow-ups/detection`, `POST /follow-ups/detection/run`.

Changed: `GET /patients/:id` — `birthDate` is now `YYYY-MM-DD` (see CCR-006).
`POST /encounters/:id/prescriptions` gains optional `acknowledgeAlerts` +
`overrideReason` (additive; absent = old behaviour unless an alert fires). No
existing endpoint changed response shape incompatibly.

## Permission Changes
Added (own file, not a contract change): `patient:update`, `patient:merge`,
`patient:contact:read|write`, `patient:identifier:read|write`,
`appointment:read|schedule|update|cancel|arrival|overbook`,
`schedule:config:read|manage`, `observation:record|read`,
`observation:config:read|manage`, `allergy:read|write`, `safety:override`,
`document:read|read:restricted|write|manage`,
`referral:read|create|manage|complete`, `followup:detect`.

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
`SAFETY_ALERT_OVERRIDDEN`, `DOCUMENT_REGISTERED`, `DOCUMENT_SUPERSEDED`,
`DOCUMENT_VOIDED`, `REFERRAL_CREATED`, `REFERRAL_SENT`, `REFERRAL_ACCEPTED`,
`REFERRAL_DECLINED`, `REFERRAL_SCHEDULED`, `REFERRAL_COMPLETED`,
`REFERRAL_CANCELLED`, `REFERRAL_EXPIRED`, `FOLLOW_UP_DUE`, `FOLLOW_UP_OVERDUE`.

Naming stays SCREAMING_SNAKE. The program brief suggests `appointment.created`
style, but Agent 3's automation matches `automation_rule.event_type` as a plain
string, so renaming would silently break every existing rule. Raised, not changed.

## Tests
- `test/integration/patient-lifecycle.test.ts` — 28
- `test/integration/appointments.test.ts` — 33
- `test/integration/observations.test.ts` — 18
- `test/integration/allergies-safety.test.ts` — 20
- `test/integration/documents.test.ts` — 14
- `test/integration/patient360.test.ts` — 6
- `test/integration/referrals.test.ts` — 21 (incl. full red-team set)
- `test/integration/followup-detection.test.ts` — 16
Covering lifecycle transitions, merge semantics and lineage, identifier
uniqueness, contact primary-demotion, room double-booking (and slot release),
deliberate overbooking, encounter-driven appointment status, arrival atomicity,
RBAC per role, cross-tenant isolation, append-only enforcement, and PHI
containment in audit metadata and event payloads.

## Dependencies Added
None. Runtime deps remain `fastify`, `pg`, `qrcode`, `zod` (Agent 1's governance
allowlist test passes). One PostgreSQL contrib extension: `btree_gist`.

## Contract Changes
- **CCR-008 (PROPOSED)** — document byte-storage service (local-first blob
  strategy). CP-9 stores metadata only against an opaque key; the platform owns
  the backend. Authorization stays in Clinical Core.
- **CCR-007 (PROPOSED, re-reviewed CP-10/11)** — coded drug↔allergen
  cross-reference. Still pending Agent 1; conservative name-based matching
  verified in force, no drug-master duplicated, no Agent 4 import. No change.
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
- **CP-6** — procedures / treatment sessions / protocols (procedure record,
  session tracking, planned-vs-completed), building on treatment episodes.
- **CP-12** — packages (session counts, consumption), clinical side only.
- **CP-14** — clinical analytics (operational counts, PHI-safe).
See `docs/workstreams/clinical-core.md` for the full CP-1..CP-21 status table.

## Last Commit
- `platform(clinical P10+P11): referrals & care coordination + follow-up detection`
