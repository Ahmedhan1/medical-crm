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

> **Integration note (I001):** Agents 2 and 3 both filed a request numbered
> `CCR-001` on their own branches. During integration these were reconciled to
> distinct ids: **CCR-001** = prescription→medication-master (Agent 2),
> **CCR-002** = request-log PHI redaction (Agent 2), **CCR-003** = AI intake
> draft→clinical write (Agent 3, renumbered from its original CCR-001).

---

## Requests

### CCR-006 — Intelligence signal response: exact cohort size replaced by a band
- Status: PROPOSED (notification — change is confined to Agent 4's own surface)
- Requested by: Agent 4
- Date: 2026-09-16
- Affects: Agent 4 only today. Filed because `AGENTS.md` §5 lists "a change to an
  existing endpoint's request/response" as a contract change, and the rule should
  not be waived by the agent making the change.
- Contract file(s): none shared. `GET /intelligence/signals` and
  `POST /intelligence/runs` response bodies (Agent 4 owned).
- Change: published signals no longer carry `cohortSize` (an exact integer). They
  carry `cohortBand` (e.g. `"5-9"`) plus `valueRoundingBase`, and `value` is
  rounded to that base. The exact `cohort_size` remains in the
  `aggregated_signal` table for the operator's audit trail and for the 0304
  threshold CHECKs; it is simply no longer returned by the API.
- Reason: exact counts are the raw material of a differencing attack. Verified
  against the running system before the change: publishing `cohortSize: 10` for
  {A,B} and `cohortSize: 8` for {B} recovers a below-threshold cohort of 2 in A,
  and narrowing the period one day at a time isolates a single subject's
  contribution. Banding plus rounding removes the arithmetic; the query-governance
  controls in the same increment remove the repetition.
- Backward compatibility: **breaking for any consumer reading `cohortSize`**.
  There is no such consumer today — no other workstream calls the intelligence
  API, and it has not shipped to a client. Signals written before this change get
  a band derived on read, so stored history stays readable. Had there been an
  external consumer, the correct path would have been to add `cohortBand`,
  deprecate `cohortSize`, and remove it on a version boundary.
- Tests: `intelligence-redteam.test.ts` asserts no response body contains
  `cohortSize` and that the exact value is still stored;
  `query-governance.test.ts` covers banding and rounding directly.
- Decision (Agent 1): _pending — no action needed unless another workstream
  intends to consume intelligence signals._

### CCR-001 — Prescription → medication-master reference
- Status: **APPROVED** (design); live resolver DEFERRED
- Requested by: Agent 2
- Date: 2026-09-16
- Affects: Agent 4 (P002 drug/medication master), Agent 2 (C007 prescriptions)
- Change: `prescription_item` (migration 0103) stores `medication_name` (free
  text) plus an OPTIONAL opaque `medication_ref text` — deliberately **no foreign
  key** to any medication table. Future: `medication_ref` carries a stable
  `<system>:<code>` from the drug master, resolved through a service Agent 4 owns;
  Clinical never queries Agent 4's tables directly and `medication_ref` stays
  nullable.
- Reason: prescribing must work for items not yet in the catalog (compounded,
  imported, un-ingested); a hard FK would make those unprescribable and couple
  the clinical schema to another workstream's migration order.
- Backward compatibility: fully additive; `medication_ref` already nullable.
- Tests: `prescriptions.test.ts` asserts a `medicationRef` is stored/returned
  with no catalog present.
- **Decision (Agent 1 / Integration):** APPROVED as designed — the opaque,
  nullable, FK-free reference is the correct decoupling and preserves the
  no-cross-workstream-query rule. Agent 4's drug master (P002) exposes
  `medication.service` resolvers, so a future enhancement can validate/enrich a
  `medication_ref` via that service (never a direct table read). Wiring that live
  lookup is **DEFERRED** (not a production blocker); the contract shape is frozen
  as above so no data migration is needed when it lands.

### CCR-002 — Redact query strings from the request log (PHI in logs)
- Status: **APPROVED** — implemented at integration
- Requested by: Agent 2
- Date: 2026-09-16
- Affects: all workstreams (any endpoint taking a query string)
- Contract file(s): `server/src/http/server.ts` (Fastify logger configuration)
- **Finding:** Fastify's default info-level request log records the full URL
  including the query string, so `GET /patients/search?q=Ahmed` writes a patient
  name into application logs (violates `AGENTS.md` rule 9). Verified against real
  log output.
- Change: a logger `req` serializer that logs method + route PATH + hostname and
  strips the query string globally.
- Interim mitigation (shipped by Agent 2, own files only): `/patients/search`
  registered `logLevel: 'warn'`; search audited with query LENGTH only.
- Tests: `security.test.ts` captures real pino output, asserts the name is absent
  and a control route is still logged.
- **Decision (Agent 1 / Integration):** APPROVED and IMPLEMENTED as the global
  fix in `http/server.ts` (the shared logger strips query strings for every
  route). A cross-workstream regression test asserts no query value reaches the
  log. Agent 2's per-route interim mitigation is retained (defense in depth,
  harmless). Status → DONE once merged.

### CCR-003 — AI intake draft → Clinical Core intake write target
- Status: **APPROVED** — satisfied by Agent 2's published intake contract; server-side auto-promotion DEFERRED
- Requested by: Agent 3 (originally filed as CCR-001 on its branch)
- Date: 2026-09-16
- Affects: Agent 2 (Clinical Core), Agent 3 (AI/Automation)
- Change: define how a CONFIRMED AI intake draft (`ai_draft.kind='intake'`,
  `status='confirmed'`) is promoted into the clinical `intake` record without the
  AI writing clinical tables directly.
- Reason: A004 is review-first; Agent 3 must not write clinical tables (AI-safety
  rule 11 + agent boundary).
- **Decision (Agent 1 / Integration):** APPROVED. The contract already exists and
  is satisfied without any shared-file change: Agent 2 published
  `POST /encounters/:id/intake` accepting `source='ai_assisted'`, `sourceRef`
  (opaque draft id, NOT a FK) and `confirmed=true`, invoked by a **human**
  principal holding `intake:record`. A database CHECK rejects any `ai_assisted`
  intake row lacking a confirming human, so an unreviewed draft can never become
  authoritative clinical data. The review-first boundary is therefore enforced by
  BOTH code and schema. Any server-side automatic promotion is **DEFERRED**;
  today the human reviewer's client carries the confirmed fields into the intake
  endpoint. No shared file changes. Verified by AI tests (draft never auto-writes)
  + clinical intake provenance CHECK.

### CCR-004 — Governed aggregate-only read path over clinical data
- Status: **APPROVED** (contract); implementation DEFERRED (fail-closed today)
- Requested by: Agent 4 (originally filed as CCR-001 on its branch)
- Date: 2026-09-16
- Affects: Agent 1 (foundation/governance), Agent 2 (clinical), Agent 4 (intelligence)
- Contract file(s): new `modules/governance/governed-read.ts` (Agent 1 owned) — not yet created.
- Change: an `IntelligenceSource` port (already declared in
  `modules/intelligence/sources.ts`) whose `clinical_governed` implementation
  returns aggregate `CohortContribution[]` — never a clinical row. Contributions
  MUST be classified `aggregate`; the firewall aborts on any
  `patient_identifiable`/`patient_pseudonymous` input; `subjectKey` must already
  be non-reversible on the clinical side; the clinical side applies its own
  authorization/consent before returning anything.
- Reason: P005 needs a clinical INPUT, but implementing it inside the pharma
  workstream would mean pharma code reading clinical tables — forbidden by
  `AGENTS.md` §1.10 and blueprint §45. Today the pipeline runs over pharma's own
  field data and refuses the clinical source.
- Backward compatibility: fully additive; `clinical_governed` is registered with
  `available:false` and returns HTTP 501 (denied run recorded).
- Tests: `pharma-firewall.test.ts` (clinical source not wired; no pharma module
  references a clinical table) + `firewall.test.ts` (patient-class aborts;
  below-threshold returns nothing). Implementation will need clinical-side tests.
- **Decision (Agent 1 / Integration):** APPROVED as the contract shape. The
  current fail-closed behaviour (501, audited) is the correct production posture,
  so building the governed provider is **DEFERRED** — it is a security-critical
  feature that must be implemented and independently audited on the clinical side,
  not rushed during integration. NOT a production blocker: no clinical data can
  reach pharma today, by construction. Owner for the deferred build: Agent 1 +
  Agent 2.

### CCR-005 — Additional pharma role keys (fix ADMIN over-grant)
- Status: **APPROVED** — implemented at integration
- Requested by: Agent 4 (originally filed as CCR-002 on its branch)
- Date: 2026-09-16
- Affects: Agent 1 (owns `roles.ts`), Agent 4 (`permissions.pharma.ts`)
- Contract file(s): `modules/governance/roles.ts`, `permissions.pharma.ts`
- Change: add `RoleKey`s `PHARMA_DATA_STEWARD`, `MEDICAL_AFFAIRS`,
  `PHARMA_MANAGER` and grant the elevated pharma permissions
  (`hcp:verify`, `hcp:merge`, `hco:write`, `medication:write`, `territory:manage`,
  `scientificrequest:fulfill`, `content:write`, `content:approve`,
  `segment:manage`, `campaign:manage`, `intelligence:publish`) to the appropriate
  new role instead of leaving them ADMIN-only.
- Reason: those permissions are (correctly) withheld from `PHARMA_REP`, so today
  only `ADMIN` holds them — a clinic administrator should not be the person
  approving promotional material or publishing intelligence. Separation of duties
  is already coded and tested; only the role vocabulary was missing.
- Backward compatibility: purely additive; no existing grant changes and ADMIN
  keeps everything.
- Tests: `test/integration/rbac-roles.test.ts` (added at integration) asserts each
  new role holds only its intended subset, holds NO clinical permission, and that
  content author≠approver still holds.
- **Decision (Agent 1 / Integration):** APPROVED and IMPLEMENTED. This is the
  ADMIN over-grant fix the integration brief calls for, solved by least privilege
  (dedicated roles) rather than broadening existing ones. See
  `docs/agent-state/integration.md`.

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
