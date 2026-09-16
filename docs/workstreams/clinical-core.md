# Workstream: Clinical Core (Agent 2)

## Mission
Own the clinical workflow where structured healthcare events are created:
patient record, intake, vitals, encounter/consultation, treatment response,
timeline, prescriptions, and clinical reports. Optimize for reception and
doctor speed (blueprint §11–15, §31).

## Branch
`agent-2/clinical-core` (branch from the foundation branch).

## Files you own
- `modules/identity/patients.repo.ts`, `patients.service.ts`
- `modules/clinical/**` (new), `modules/workflow/**`
- `modules/governance/permissions.clinical.ts`
- `domain/events.clinical.ts`
- `http/routes/patients.routes.ts`, `workflow.routes.ts` + new clinical routes
- `http/features/clinical.feature.ts`
- Migrations **0100–0199**
- Clinical tests, this file, `docs/agent-state/agent-2.md`

## Already built (do not rebuild)
- `patient` table + register (dedup guard) / search / get, MRN sequence.
- `encounter` state machine + `POST /encounters/check-in` + `GET /queue`.
- Events `PATIENT_REGISTERED`, `PATIENT_CHECKED_IN` and permissions
  `patient:*`, `encounter:*`, `queue:*`, `qr:*`.

## How to add things
- **Permission:** add to `ClinicalPermission` in `permissions.clinical.ts` and
  grant to a role via `roleGrants`. ADMIN gets it automatically.
- **Event:** add to `ClinicalEventType` in `events.clinical.ts`.
- **Route:** register inside `clinicalFeature` — never edit `server.ts`.
- **Table:** new migration in 0100–0199, with `clinic_id` + `timestamptz`.

## Contracts to respect
- Auth/permission/`clinic_id` scoping on every endpoint.
- Emit events transactionally with state changes; audit sensitive actions
  (diagnosis/medication changes) with no PHI in metadata.
- QR service (`modules/qr`) is Agent 1's shared library — consume it, don't fork.
- Reuse `withTransaction` for multi-write atomicity.

## Cross-agent dependencies
- Agent 3's AI intake (A004) will write DRAFTS that a human confirms into your
  intake tables (C001). AI never writes clinical data directly.

### Published: intake write contract (for A004)
`POST /encounters/:id/intake` is the ONLY write path into the `intake` table.
It is called by a **human** principal holding `intake:record`; there is no
machine principal, so an AI agent cannot invoke it unattended.

To land a confirmed AI draft, the reviewing human's client submits the normal
body plus:

```jsonc
{
  "chiefComplaint": "…",        // required, the draft's extracted value
  "source": "ai_assisted",      // provenance
  "sourceRef": "<opaque id>",   // e.g. the ai_draft id — string, NOT a foreign key
  "confirmed": true             // explicit human review acknowledgement
}
```

Guarantees Agent 3 can rely on:
- `source_ref` is an opaque string. The clinical schema holds **no foreign key**
  to Agent 3's tables, so neither workstream constrains the other's migrations.
- `confirmed_by` is set to the authenticated reviewer. A database CHECK rejects
  any `ai_assisted` row without one, so an unconfirmed draft can never become
  authoritative clinical data.
- The response is `{ intake, encounterStatus }`; `intake.id` is stable across
  revisions so a draft can be reconciled to the record it produced.

This needs no shared-file change, so **no CONTRACT_CHANGE_REQUEST is required**
to consume it. File one only if A004 needs a different write shape.

## Delivered (C001–C007)

The full clinical workflow is implemented: Patient → Registration/Identification
→ Intake → History → Vitals → Encounter → Queue → Doctor Workspace → Previous
Visits → Examination → Assessment → Diagnosis → Treatment → Prescription →
Follow-up → Patient Timeline → Treatment Response.

### API surface

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/encounters/:id/intake` | `intake:record` |
| GET | `/encounters/:id/intake` | `intake:read` |
| POST | `/encounters/:id/vitals` | `vitals:record` |
| GET | `/encounters/:id/vitals` | `vitals:read` |
| POST | `/encounters/:id/status` | `encounter:status` |
| GET | `/encounters/:id` | `encounter:read` (sections shaped per permission) |
| POST | `/encounters/:id/start` | `encounter:clinical:write` |
| PATCH | `/encounters/:id/clinical` | `encounter:clinical:write` (+ `treatment:write`) |
| POST | `/encounters/:id/diagnoses` | `diagnosis:write` |
| PATCH | `/encounters/:id/diagnoses/:diagnosisId` | `diagnosis:write` |
| POST | `/encounters/:id/notes` | `note:write` |
| POST | `/encounters/:id/complete` | `encounter:complete` |
| POST | `/encounters/:id/complete-and-next` | `encounter:complete` + `encounter:clinical:write` |
| POST | `/queue/next` | `encounter:clinical:write` |
| GET | `/patients/:id/timeline` | `timeline:read` |
| POST/GET | `/patients/:id/treatment-episodes` | `treatment_episode:write` / `:read` |
| GET | `/treatment-episodes/:id` | `treatment_episode:read` |
| POST | `/treatment-episodes/:id/responses` | `treatment_episode:write` |
| POST | `/treatment-episodes/:id/end` | `treatment_episode:write` |
| GET | `/reports/encounter/:id.pdf` | `report:generate` |
| GET | `/reports/patient/:id.pdf` | `report:generate` |
| POST/GET | `/encounters/:id/prescriptions` | `prescription:write` / `:read` |
| GET | `/prescriptions/:id` | `prescription:read` |
| POST | `/prescriptions/:id/cancel` | `prescription:write` |
| GET | `/patients/:id/prescriptions` | `prescription:read` |
| POST | `/encounters/:id/follow-ups` | `followup:write` |
| GET | `/patients/:id/follow-ups` | `followup:read` |
| GET | `/follow-ups` | `followup:read` (recall worklist) |
| POST | `/follow-ups/:id/close` | `followup:close` |

### Clinical permission matrix

The operational/clinical authority split. ADMIN inherits everything;
PHARMA_REP holds nothing here, by design.

| Permission | RECEPTION | NURSE | DOCTOR |
| --- | :---: | :---: | :---: |
| `encounter:status` | ✅ | ✅ | ✅ |
| `intake:record` / `intake:read` | — | ✅ | ✅ |
| `vitals:record` / `vitals:read` | — | ✅ | ✅ |
| `encounter:clinical:read` | — | ✅ | ✅ |
| `encounter:clinical:write` | — | — | ✅ |
| `encounter:complete` | — | — | ✅ |
| `diagnosis:write` | — | — | ✅ |
| `treatment:write` | — | — | ✅ |
| `note:write` | — | — | ✅ |
| `timeline:read` | — | ✅ | ✅ |
| `treatment_episode:read` | — | ✅ | ✅ |
| `treatment_episode:write` | — | — | ✅ |
| `report:generate` | — | — | ✅ |
| `prescription:read` | — | ✅ | ✅ |
| `prescription:write` | — | — | ✅ |
| `followup:read` | ✅ | ✅ | ✅ |
| `followup:close` | ✅ | ✅ | ✅ |
| `followup:write` | — | — | ✅ |

Reception holds **no clinical read or write permission**. It moves patients
through the workflow and works the recall list, which is the operational half of
the split; every clinical decision belongs to the nurse (collection) or the
doctor (authority).

> `docs/GOVERNANCE.md` still shows the pre-C001 eight-permission matrix. That
> file is Agent 1's, so it is not edited here — Agent 1 should regenerate it
> from `permissions.clinical.ts` at I001.

## Clinical safety rules enforced beyond the task specs
- A clinical write requires an **open consultation held by the writing doctor**;
  a second clinician performs an audited handover first.
- Completing a consultation requires an assessment or a diagnosis.
- `clinical_note`, `treatment_response` and `prescription_item` are append-only
  at the database level; `prescription` is immutable once issued (cancel and
  re-issue).
- Audit metadata and event payloads carry identifiers, controlled vocabularies
  and counts — never complaint text, measured values, medication names or
  clinical narrative. Each of those is asserted by a test.

## Clinical Platform program (post-integration)

The C0xx series delivered the clinic-grade Clinical Core. The Clinical Platform
program evolves it into a Clinical Operating System. Phases below are the
program's own numbering; status is measured against the **code**, not this file.

| # | Phase | Status |
| --- | --- | --- |
| CP-1 | Patient lifecycle (status, identifiers, contacts, merge) | **DONE** (0104) |
| CP-2 | Appointment & queue engine | **DONE** (0105) |
| CP-3 | Triage & extensible observations | **DONE** (0106) |
| CP-4 | Clinical documentation & template engine | TODO |
| CP-5 | Diagnosis / terminology abstraction | PARTIAL — coded diagnosis exists (0101); terminology service not built |
| CP-6 | Procedures | **DONE** (0111, immutable completed facts) |
| CP-7 | Prescription platform | PARTIAL — issue/cancel/immutability exist (0103); refills, substitution, supersede not built |
| CP-8 | Allergy & safety engine | **DONE** (0107) |
| CP-9 | Document management (DocumentReference) | **DONE** (0108, metadata layer; bytes = CCR-008) |
| CP-10 | Referral & care coordination | **DONE** (0109) |
| CP-11 | Follow-up & longitudinal care | **DONE** — detection + idempotent event sweep (0110) |
| CP-12 | Packages & treatment plans | TODO |
| CP-13 | Inventory consumption events | TODO (contract only; no second inventory) |
| CP-14 | Clinical analytics | TODO |
| CP-15 | Dashboard data contracts | TODO |
| CP-16 | Patient 360 | **DONE** (read model, no new table) |
| CP-17 | Clinical timeline | PARTIAL — timeline exists, keyset-paginated, lineage-aware; not yet filterable by kind |
| CP-18 | Specialty configuration engine | STARTED — `appointment_type` and `clinical_resource` are the first config primitives |
| CP-19 | Multi-tenant hierarchy (Location/Department/Room) | PARTIAL — `clinical_resource` is a bookable thing, not an org hierarchy (foundation-owned) |
| CP-20 | Local-first verification | TODO (no clinical path requires egress today) |
| CP-21 | FHIR-ready mapping | TODO (Agent 1 roadmap Phase 6) |

### Document model (CP-9)
`document_reference` (0108) is FHIR DocumentReference-shaped and stores
**metadata only** — the bytes are never in the database. `storage_key` is an
opaque pointer resolved by platform infrastructure (CCR-008); integrity columns
(`size_bytes`, `checksum_sha256`) let a resolver verify what it fetched. Keeping
content out of the DB keeps it out of logs, clinical-DB backups and every query.
- **Versioning** by supersession: a new version links to the old, which is kept
  (`superseded`), never edited or deleted. A mistake is voided
  (`entered_in_error`), not removed.
- **Access policy**: a `restricted` document needs `document:read:restricted`;
  to a caller without it the document is filtered from lists and not-found on a
  direct read, so its existence does not leak. The title (which can name a
  condition) is redacted on the timeline for restricted documents.
- Documents link to patient / encounter / episode and follow merge lineage.

### Patient 360 (CP-16)
`GET /patients/:id/360` is a read-only VIEW MODEL — no table, no duplicated
query. It composes the existing permission-checked readers (identifiers,
contacts, allergies, recent observations, upcoming appointments, recent visits,
active prescriptions, documents, treatment episodes, open follow-ups) and
includes each section only if the caller holds its read permission, the same way
the encounter workspace does. A reception 360 and a doctor 360 therefore differ
by content, not by a post-hoc filter, so an omitted section never implies the
caller was allowed to see it. A merged record is flagged with `mergedIntoId` so
the client can redirect to the survivor.

### Referral & care-coordination model (CP-10)
`referral` (0109) is a ServiceRequest-like clinical order with a deterministic
lifecycle: `draft → ordered → sent → accepted/declined → scheduled → completed`,
with `cancelled`/`expired` available while live. Invalid transitions fail. Every
move is written to the append-only `referral_status_history` and emits a typed
event (`REFERRAL_SENT`, `REFERRAL_ACCEPTED`, …).
- **The referral status IS the coordination state** — there is no separate task
  table. When downstream work is needed, Clinical Core emits an event and Agent 3
  owns the action; it does not build a task engine here.
- **Clinical authority split**: `referral:create` and `referral:complete` are
  DOCTOR (clinical decisions); the administrative middle (`referral:manage` —
  sent/accepted/declined/scheduled/cancelled/expired and linkage) is RECEPTION +
  DOCTOR; NURSE has `referral:read` only. Reception cannot create or complete a
  clinical referral.
- Master data is not duplicated: patient/practitioner are FKs; an external
  provider is free text + specialty. Appointment and document linkage are
  validated to the same patient. Referrals join the timeline and Patient 360.

### Follow-up detection model (CP-11)
Detection is a READ-MODEL + an idempotent event sweep over the existing
`follow_up` records — **no new entity table**. Migration 0110 adds only two
nullable marker columns (`due_event_at`, `overdue_event_at`) for event
idempotency.
- `classifyDueState(dueOn, asOf, approachingDays)` is a pure, total, inspectable
  function → `overdue | due | approaching | upcoming`. No AI, no probabilistic
  logic, no hidden thresholds; the clinician-defined `due_on` is the only date.
- `GET /follow-ups/detection` is the classified worklist (read; `followup:read`).
- `POST /follow-ups/detection/run` is the sweep (`followup:detect`, DOCTOR): it
  publishes `FOLLOW_UP_DUE` / `FOLLOW_UP_OVERDUE` **at most once per follow-up**
  (marker-guarded) using the server's date, then stops. It reads and stamps
  markers only — it never diagnoses, prescribes, closes an encounter, or edits a
  clinical fact.
- **Automation boundary**: Clinical Core detects and publishes the fact; Agent 3
  consumes `FOLLOW_UP_OVERDUE` to run reminders/recall/escalation. Clinical Core
  sends nothing. (Completion is signalled by the existing
  `FOLLOW_UP_CLOSED{status:completed}`.)

### Safety model (CP-8)
Allergies are now a structured record (`allergy`, 0107), distinct from the
free-text `intake.allergies` triage note. Prescribing runs a **deterministic**
safety check:
- **Allergy match** — a prescribed line against the patient's active,
  non-refuted medication allergies. Name-based today (whole-word, conservative)
  until a coded drug↔allergen cross-reference exists (CCR-007); a `ref` match is
  already treated as definitive when both sides carry one.
- **Duplicate medication** — the same drug on another active prescription.
- The check reads the patient's whole **merge lineage**, so an allergy recorded
  on a duplicate record still protects the survivor.

The platform provides the RULE; it never makes the decision. The check refuses
by default and returns the alerts, but a doctor holding `safety:override` can
prescribe through them with a required reason. Every override is written to the
append-only `safety_override` ledger and audited. AI cannot bypass it — AI holds
no prescribing principal and the override is a human acknowledgement, not a
field a draft can set. A dry-run endpoint
(`POST /encounters/:id/prescription-safety-check`) lets a client preview alerts
as the prescription is built.

### Observation engine notes (CP-3)
- **`observation` does not replace `vital`.** The universal vital set keeps its
  fast, CHECK-constrained, generated-BMI path (`vital`, 0100), which reports and
  the timeline already read. `observation` is the OPEN extension for everything
  specialty-specific — a PASI score, an ejection fraction, a gait note — driven
  by an `observation_definition` catalog. Rewriting stable vitals into a generic
  table would be a regression, not a cleanup (rule 31).
- **Reference ranges are DATA.** A definition carries min/max (validation) and
  reference_low/high (flagging); the abnormal flag is computed at record time
  from the definition and stored, so it reflects the range then in force. This
  is the one thing the vitals path hard-codes, now configurable per clinic.
- **Definitions are config, not code (Phase 18).** A new specialty measurement
  is an ADMIN-created row; clinicians read the catalog and record against it.
- Value coercion and bounds are enforced by value type, so a clinic-defined
  observation is validated exactly like a built-in one, with no code change.

### Scheduling model notes (CP-2)
- **A room cannot hold two patients at once**, so that is a database EXCLUDE
  constraint (`ex_appointment_resource`, needs the `btree_gist` extension), not
  a service check. No code path can book over it.
- **A practitioner CAN be overbooked**, because clinics do that deliberately.
  It is a service-level policy: refused by default with the conflicting
  appointment ids, permitted with an explicit `allowDoubleBooking` by a holder
  of `appointment:overbook`, and recorded as overbooked in the audit trail.
- **`in_consultation` and `completed` are not settable from the front desk.**
  They follow the linked encounter, which is the clinical source of truth for
  whether a patient was actually seen. One fact, one owner.
- **Arrival needs `encounter:checkin` as well as `appointment:arrival`,** because
  it opens a clinical encounter. A nurse can move a patient through the waiting
  room; opening the visit stays with the front desk.
- Deferred deliberately, not forgotten: **recurring appointments** (needs a
  series table plus an expansion/exception policy) and the **waitlist**.

### Event naming — deviation from the program brief
The brief suggests dotted event names (`appointment.created`). The established
contract in this repository is SCREAMING_SNAKE (`APPOINTMENT_SCHEDULED`), and
Agent 3's automation engine matches `automation_rule.event_type` against it as a
plain string. Renaming would silently break every existing rule, so the existing
convention is kept. Raised here rather than changed unilaterally.

## Parallel Clinical Expansion Batch (procedures, care plans, FHIR, hardening)

Delivered on `agent2/clinical-batch-episodes` from integration `48a456b`.

- **Treatment episodes (audit + reach).** The episode-of-care lifecycle already
  exists (0102: start / response / end; active/completed/discontinued, timeline +
  360 integrated). This batch extends its REACH: `procedure.episode_id` and
  `care_plan.episode_id` now tie procedures and care plans into an episode,
  validated across merge lineage. No rewrite of the stable episode module.
- **Procedures (0111).** FHIR Procedure-aligned, doctor-owned. A completed
  procedure is an IMMUTABLE clinical fact — a row trigger locks its content and
  permits only `completed → entered_in_error` (audit-safe void); DELETE blocked.
  Terminology (code+system) passed through, never invented. Timeline + workspace
  + 360.
- **Care plans (0112).** CarePlan + goals + interventions with explicit,
  deterministic statuses; progress is always an explicit status change, never
  inferred. Authoring is doctor-owned (`care_plan:write`); recording progress is
  open to nurses (`care_plan:progress`). Episode-linked; timeline + 360.
- **Referral hardening (0113).** SLA/expiry DETECTION: a read-model classifying
  open referrals (within_sla/approaching/breached) and an idempotent sweep that
  publishes `REFERRAL_SLA_BREACHED` at most once per referral. It NEVER
  auto-transitions status — expiry stays an explicit human decision; the
  reviewed lifecycle allow-list is unchanged and safe.
- **Follow-up completion/resolution.** The close path now emits
  `FOLLOW_UP_COMPLETED` / `FOLLOW_UP_CANCELLED` (alongside the backward-compatible
  `FOLLOW_UP_CLOSED`) so Agent 3 gets an unambiguous resolution signal. Detection
  stays read-only and idempotent; it mutates no clinical fact.
- **FHIR mapping foundation.** Pure, dependency-free `modules/clinical/fhir`
  mappers (Patient, Encounter, Observation, AllergyIntolerance, MedicationRequest,
  Condition, ServiceRequest, Procedure, CarePlan) — an INTERNAL contract, no
  product FHIR endpoint, no migration, unit-tested. Codes passed through verbatim.

Automation boundary preserved: Clinical Core publishes facts/events; it imports
no automation/messaging/AI/pharma module and sends nothing. PHI stays in the
record — event payloads carry ids, status and controlled vocab only.

## Next tasks
CP-6 (procedures/sessions/protocols) or CP-12 (packages), then CP-14 (clinical
analytics). See `docs/agent-state/agent-2.md`.
