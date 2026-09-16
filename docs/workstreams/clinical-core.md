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

## Next tasks
C001–C007 are DONE. See `TASKS.md` and `docs/agent-state/agent-2.md`.
