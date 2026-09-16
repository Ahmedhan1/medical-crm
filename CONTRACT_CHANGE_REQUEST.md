# MEDCORE — Contract Change Requests

A **contract change** is any change that affects behavior another agent relies
on: editing a shared/contract file (see `AGENTS.md` §4), adding a new `RoleKey`,
changing an existing endpoint's request/response shape, changing a shared table,
or defining a cross-workstream event/read contract.

**Not** a contract change (do it directly in your own files): adding a new
permission and granting it to an existing role in your `permissions.<workstream>.ts`;
adding a new event type in your `events.<workstream>.ts`; adding a new endpoint
inside your own feature module; adding a new table in your migration range.

## Process

1. Copy the template below to the top of the "Requests" list.
2. Assign the next `CCR-NNN` id, set **Status: PROPOSED**.
3. Agent 1 reviews. Approved → **APPROVED** (+ who implements the shared part).
   Rejected → **REJECTED** with a reason and an alternative.
4. Dependent work starts only after **APPROVED** and the shared part is merged.
5. When merged, set **Status: DONE**.

## Template

```
### CCR-NNN — <short title>
- Status: PROPOSED | APPROVED | REJECTED | DONE
- Requested by: Agent N
- Date: YYYY-MM-DD
- Affects: <agents / workstreams>
- Contract file(s): <paths>
- Change: <what changes, precisely>
- Reason: <why it is needed>
- Backward compatibility: <migration/compat plan; how existing callers keep working>
- Tests: <what proves it safe>
- Decision (Agent 1): <notes>
```

---

## Requests

### CCR-001 — Governed aggregate-only read path over clinical data
- Status: PROPOSED
- Requested by: Agent 4
- Date: 2026-09-16
- Affects: Agent 1 (foundation/governance), Agent 2 (clinical core), Agent 4 (intelligence)
- Contract file(s): new `modules/governance/governed-read.ts` (Agent 1 owned); no
  change to any existing shared file.
- Change: define a **contract interface** that lets the intelligence pipeline obtain
  cohort contributions derived from clinical data **without ever seeing a clinical
  row**. Concretely, Agent 1 (or Agent 2 under Agent 1's review) implements a
  provider satisfying the port Agent 4 already declares in
  `modules/intelligence/sources.ts`:

  ```ts
  interface IntelligenceSource {
    key: 'clinical_governed';
    fetch(request: {
      clinicId: string;
      signalType: string;
      periodStart: string;   // YYYY-MM-DD
      periodEnd: string;
      territoryIds: string[] | null;
    }): Promise<CohortContribution[]>;
  }

  interface CohortContribution {
    subjectKey: string;      // opaque; hashed under a per-run salt, never stored
    dataClass: DataClass;    // MUST be 'aggregate' — see below
    dimension: string;       // the measured dimension, e.g. a condition group
    dimensionLabel?: string;
    scopeId: string;         // territory/region id — never a patient or encounter id
    scopeLabel: string;
    weight?: number;
  }
  ```

  Requirements on the implementation, which the firewall enforces on its side:
  1. It returns **contributions, not records**: no name, identifier, date of birth,
     free text, or any field from a clinical row.
  2. Every contribution is classified `aggregate`. The pipeline refuses
     `patient_identifiable` and `patient_pseudonymous` outright
     (`intelligence/classification.ts`), so a mis-implemented provider fails closed
     rather than leaking.
  3. `subjectKey` is a value that is already non-reversible on the clinical side
     (e.g. a per-period keyed hash), because the firewall's own salt protects
     against cross-run linkage but not against the provider handing over a raw id.
  4. The provider applies the clinical side's own authorization and consent rules
     before returning anything; the pharma side asserts `intelligence:publish` in
     addition, never instead.
- Reason: `TASKS.md` P005 requires the pipeline
  `classification → authorization → de-identification → aggregation →
  minimum-cohort threshold → policy validation → signal`. Agent 4 has built and
  tested every stage, but the clinical *input* cannot be implemented inside the
  pharma workstream without pharma code reading clinical tables — exactly what
  `AGENTS.md` §1.10 and blueprint §45 forbid. The pipeline is therefore live over
  pharma's own field data and refuses the clinical source until this lands.
- Backward compatibility: fully additive. The source is already registered as
  `clinical_governed` with `available: false`; requests against it return
  HTTP 501 `governed_read_contract_unavailable` and are recorded as a denied run.
  When Agent 1 supplies the provider, Agent 4 swaps the stub for it — no schema,
  API or permission change, and no behaviour change for any existing caller.
- Tests: covered on the pharma side today by
  `test/integration/pharma-firewall.test.ts` ("the clinical source is not wired",
  plus the structural scan proving no pharma module references a clinical table)
  and `test/unit/firewall.test.ts` (patient-class input aborts a run;
  below-threshold cohorts return nothing). When implemented, the provider needs
  its own tests on the clinical side proving it emits no patient-level field.
- Decision (Agent 1): _pending_

### CCR-002 — Additional pharma role keys (data steward, medical affairs, pharma manager)
- Status: PROPOSED
- Requested by: Agent 4
- Date: 2026-09-16
- Affects: Agent 1 (owns `roles.ts`), Agent 4
- Contract file(s): `modules/governance/roles.ts`
- Change: add three `RoleKey`s — `PHARMA_DATA_STEWARD`, `MEDICAL_AFFAIRS`,
  `PHARMA_MANAGER` — and let Agent 4 grant existing pharma permissions to them in
  `permissions.pharma.ts`.
- Reason: pharma already separates duties in code: verifying master data
  (`hcp:verify`, `hcp:merge`, `medication:write`), approving content
  (`content:approve`), managing territories (`territory:manage`), answering
  scientific requests (`scientificrequest:fulfill`) and publishing intelligence
  (`intelligence:publish`) are deliberately **not** granted to `PHARMA_REP`. Today
  those permissions are therefore held only by `ADMIN`, which over-grants: a clinic
  administrator should not be the person approving promotional material. The
  separation is correct and tested; only the role vocabulary is missing.
- Backward compatibility: purely additive. No existing role's grants change, and
  `ADMIN` continues to receive every permission, so nothing that works today stops
  working. Existing tests use `ADMIN` for stewardship and keep passing.
- Tests: `test/integration/pharma-firewall.test.ts` already asserts that
  `PHARMA_REP` holds none of these permissions; the same assertions extend to the
  new roles, plus one per role proving it holds only its own subset.
- Decision (Agent 1): _pending_

---

## Known contracts to respect (baseline, do not break)

- **API error envelope:** `{ "error": { "code", "message", "details?" } }` with
  stable `code` values; success bodies are the resource JSON.
- **Auth:** `Authorization: Bearer <token>`; principal carries `clinicId`,
  `roles`, `permissions`. Every protected route runs `requireAuth`, every
  service asserts a permission and scopes by `clinic_id`.
- **QR payload:** `MEDCORE1:<opaque-base64url>`; NEVER contains PHI.
- **Audit vs events:** sensitive actions → append-only `audit_log` (no PHI in
  metadata); domain facts → append-only `event`, emitted in the same
  transaction as the state change.
- **DB conventions:** every tenant table has `clinic_id`; timestamps are
  `timestamptz`; `audit_log` and `event` reject UPDATE/DELETE.
- **Governance boundaries:** pharma gets no patient-identifiable data; AI output
  is review-first and never auto-writes clinical records.
