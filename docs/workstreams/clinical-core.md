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

## Next tasks
C001 intake+vitals → C002 doctor workspace → C003 Save&Next → C004 timeline →
C005 treatment episodes → C006 reports. See `TASKS.md`.
