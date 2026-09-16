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

### CCR-008 — Document byte storage (local-first blob strategy)
- Status: PROPOSED
- Requested by: Agent 2 (Clinical Platform)
- Date: 2026-09-16
- Affects: Agent 1 (platform / local-first infrastructure), Agent 2 (documents)
- Contract file(s): none. This asks the platform owner to choose a storage
  backend; the clinical layer is already built against an opaque `storage_key`.
- Change: CP-9 stores document METADATA only (`document_reference`, 0108). The
  bytes are NOT in the database — `storage_key` is an opaque pointer. A platform
  storage service is needed to (a) accept an upload, write the bytes to a
  local-first backend (filesystem/object store on the MEDCORE box), return a
  key + size + SHA-256, and (b) stream the bytes back on an authorized read.
  Proposed shape: `putObject(clinicId, bytes) -> {key,size,sha256}` and
  `getObject(clinicId, key) -> stream`, both tenant-scoped, with the clinical
  layer remaining the authority on WHO may read a given document.
- Reason: storing blobs in Postgres bloats the clinical DB, its backups and its
  replication, and byte storage is a local-first infrastructure decision (Agent
  1 roadmap Phase 3), not a clinical one. Keeping content out of the DB also
  keeps it out of logs and every clinical query by construction.
- Security: the storage service holds encrypted-at-rest bytes; it must never be
  the authorization point — a read is authorized by Clinical Core
  (`GET /documents/:id`, confidentiality-gated) which then resolves the key.
  The integrity columns (`size_bytes`, `checksum_sha256`) let the resolver
  verify what it fetched.
- Backward compatibility: additive. Until the service exists, documents can be
  registered against externally-produced keys (already supported and tested).
- Tests: `test/integration/documents.test.ts` covers metadata, versioning,
  access policy and isolation; byte round-trip tests arrive with the service.
- Decision (Agent 1): _pending_

### CCR-007 — Coded drug↔allergen cross-reference for prescribing safety
- Status: PROPOSED
- Requested by: Agent 2 (Clinical Platform)
- Date: 2026-09-16
- Affects: Agent 4 (drug/medication master, P002), Agent 2 (safety engine, CP-8)
- Contract file(s): none edited. This is a forward-looking data contract; the
  safety engine works today without it.
- Change: the prescribing safety check (Phase 8) currently matches a prescribed
  `medication_name` against an allergy `substance` by a conservative,
  whole-word name heuristic (`safety.service.ts`), because there is no coded
  drug↔ingredient↔allergen relationship available. Proposed: once the drug
  master exposes stable ingredient/allergen codes, an allergy carries a
  `substance_ref` and a prescription item a `medication_ref` drawn from it, and
  the safety engine treats a `ref` match as definitive (it already does when
  both refs are present), reserving the name heuristic for the un-coded case.
- Reason: the name heuristic is deliberately conservative and will both
  over-warn (a clinician clears it) and, for brand vs generic names, potentially
  under-warn. A coded cross-reference makes the check precise. It must remain a
  read across a governed boundary — the clinical safety engine must never query
  the drug master's tables directly.
- Backward compatibility: fully additive. `medication_ref`/`substance_ref` are
  already nullable opaque strings; the engine already prefers a ref match when
  present, so no clinical code changes when the codes arrive.
- Security: allergen/medication codes are not PHI; the patient's allergy record
  is, and stays in Clinical Core. The cross-reference lookup carries codes only.
- Tests: `test/integration/allergies-safety.test.ts` covers the name-based
  behaviour (whole-word match, no short-substring false positive, refuted/
  inactive ignored, merged-lineage protection); ref-based matching gains tests
  when the code source exists.
- Decision (Agent 1): _pending_
- Re-review (Agent 2, CP-10/CP-11 session): status remains PROPOSED and pending.
  Verified the conservative name-based behaviour is still in force and covered by
  `allergies-safety.test.ts`; no drug-master table was duplicated and no Agent 4
  module is imported by Clinical Core. No change required until Agent 1 rules.

### CCR-006 — Patient record extension (lifecycle, identifiers, contacts, merge)
- Status: PROPOSED
- Requested by: Agent 2 (Clinical Platform)
- Date: 2026-09-16
- Affects: any workstream reading `patient` — Agent 3 (messaging recipients,
  automation conditions), Agent 4 (intelligence de-identification).
- Contract file(s): none edited. `patient` is extended by migration 0104 in
  Agent 2's own range; no existing column, constraint or index changes.
- Change:
  1. `patient` gains `status` (`active|inactive|deceased|merged`, default
     `active`), `deceased_date`, `merged_into_id`, `preferred_language`,
     `email`, `address`, `updated_by`. All nullable or defaulted.
  2. New tables `patient_identifier`, `patient_contact`, `patient_merge`
     (append-only).
  3. **`GET /patients/:id` response changes shape**: `birthDate` now serializes
     as `"1980-04-02"` instead of `"1980-04-02T00:00:00.000Z"`. See below.
- Reason: the patient record had no status, no contact detail, no external
  identifiers and no update path at all; duplicate resolution was impossible.
- **Consumer notes:**
  - `status` matters to anyone acting on a patient. `merged` means the record
    is superseded — messaging and automation should target `merged_into_id`.
    Clinical writes and check-in already refuse a `merged` or `deceased` record.
  - `preferred_language` is a BCP-47 tag owned here and intended for Agent 3's
    template `locale` selection, which currently defaults to `en`. Wiring it in
    is Agent 3's call; nothing changes until they do.
  - A merge LINKS, it does not rewrite: historical rows keep their original
    `patient_id`. Any longitudinal read over `patient_id` should resolve lineage
    (`resolvePatientLineage`) or it will under-report a merged patient's history.
    The clinical timeline already does.
- Backward compatibility: additive at the schema level. The one behavioural
  change is `birthDate`, which was a **bug**: input is validated as
  `YYYY-MM-DD` but output was a UTC timestamp, so any client in a timezone west
  of UTC rendered the wrong day for a date of birth. Fixed to match the
  documented input contract. Called out here because it is a visible response
  change, not silently.
- Tests: `test/integration/patient-lifecycle.test.ts` (28) covers status
  transitions, merge semantics and lineage, identifier uniqueness as a duplicate
  signal, contact primary-demotion, PHI containment in audit metadata, RBAC per
  role, and cross-tenant isolation. Full suite 398 green.
- Decision (Agent 1): _pending_

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
