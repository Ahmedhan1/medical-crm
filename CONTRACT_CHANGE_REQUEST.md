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

### CCR-010 — Adverse Event Handoff Contract (pharma field → governed safety workflow)
- Status: PROPOSED — **design only; no cross-domain workflow implemented**
- Requested by: Agent 4
- Date: 2026-09-16
- Affects: Agent 4 (field intake), Agent 2 (clinical domain), Agent 1 (platform,
  contracts, governance), future pharmacovigilance/regulatory integration
- Contract file(s): none yet. Proposed: `modules/governance/safety-handoff.ts`
  (Agent 1 owned) as the port; `modules/pharma/safety/**` (Agent 4 owned) as the
  field-side intake only.

#### Why a contract rather than a feature
A medical representative is a commercial actor who will, occasionally, be told
something that *sounds like* an adverse event. Today there is no route for it:
`visit_objection.objection_type = 'safety'` is a **commercial objection theme**
(a reason an HCP resists a product), not a safety report, and the PHI guard
rejects any free text carrying an identifier — so the statement is simply lost.

Both failure modes are bad. Losing it fails the regulatory obligation; routing it
into the clinical record would make the pharma layer a hidden clinical system,
which `AGENTS.md` §1.10 and blueprint §45 forbid. The boundary therefore has to
be a contract between workstreams, not a feature inside one of them.

**Agent 4 must not build the destination.** This CCR defines only what the pharma
side hands over and under what guarantees.

#### 1. Source
Exactly three field-side origins, all already existing Agent 4 surfaces:
- `call_report.summary` / `next_step` (free text typed by a representative)
- `visit_objection.objection_text`
- `scientific_request.question`

No other origin. In particular, nothing is ever sourced from a clinical table,
and the pharma side never reads one (enforced by the existing static scan in
`pharma-firewall.test.ts`).

#### 2. Classification
A neutral, non-clinical classification assigned at intake:

```
ORDINARY_FIELD_NOTE | POTENTIAL_PHI | POTENTIAL_SAFETY_SIGNAL | BOTH
```

Binding rules:
- The pharma layer may only ever record **`POTENTIAL_SAFETY_SIGNAL`**. It must
  never record "adverse event", "confirmed", a causality assessment, a seriousness
  grade, or a MedDRA-style coded term. Those are outputs of an authorized safety
  system, not of a commercial one.
- Classification is **not** clinical confirmation and must be labelled as such in
  every payload and UI contract.
- **AI must never be the sole authority.** A model may propose a classification;
  the stored classification must carry `classifier` ∈ `{rule, human, ai_suggested}`
  and an `ai_suggested` value must be confirmed by a human holding the safety
  permission before it is handed off. Agent 3 owns any model; Agent 4 owns the
  confirmation state.

#### 3. Minimal data (the payload)
Data minimisation is the core of this contract. The handoff carries **only**:

| Field | Notes |
| --- | --- |
| `handoffId` | idempotency key, generated pharma-side |
| `clinicId` | tenant |
| `classification` | `POTENTIAL_SAFETY_SIGNAL` (or `BOTH`) |
| `classifier` | `rule` / `human` / `ai_suggested` + confirming user |
| `reportedAt` | when the representative recorded it |
| `sourceKind` | `call_report` / `visit_objection` / `scientific_request` |
| `sourceId` | the pharma record id (a pointer, not its content) |
| `hcpId` | the reporting **professional**, never a patient |
| `medicationId` | optional, from the drug master |
| `jurisdiction` | drives which regulator applies |
| `narrativeRef` | a **reference** to quarantined text, not the text |

Explicitly **NOT** carried: the raw narrative, patient name, age, sex, date of
birth, initials, identifiers, dates of treatment, or any free text at all. The
destination system fetches the narrative, if it is authorized to, through its own
governed read against the quarantine store — the pharma layer never pushes it.

#### 4. Destination
An authorized safety/medical-affairs workflow **outside** Agent 4. Implemented by
Agent 1 as a port with one method:

```ts
interface SafetyHandoffPort {
  readonly available: boolean;
  submit(payload: SafetyHandoffPayload): Promise<{ accepted: true; reference: string }>;
}
```

Until Agent 1 provides an implementation, the registered port is
`available: false` and refuses every call — the same fail-closed posture Agent 1
endorsed for `clinical_governed` (CCR-004). A future external pharmacovigilance
system sits behind this port; the domain never couples to a vendor.

#### 5. Authorization
- Raising a potential signal: any principal who may write the source record
  (`callreport:write` / `scientificrequest:write`) — a representative must be able
  to report, or reporting will not happen.
- Confirming a classification and releasing a handoff: a **new** permission
  `safety:handoff` granted to `MEDICAL_AFFAIRS` only. Not `PHARMA_REP`, not
  `PHARMA_MANAGER`, not `PHARMA_DATA_STEWARD`, and not by granting `ADMIN`.
- Reading quarantined narrative: `safety:read-quarantine`, `MEDICAL_AFFAIRS` only.
- No pharma role gains any clinical permission as a result of this contract.

#### 6. Audit
Every step writes an append-only record: classification assigned, classification
changed, human confirmation, handoff attempted, handoff accepted/refused,
quarantine read. Audit metadata carries ids and vocabulary only — **never the
narrative**, consistent with the existing `audit_log` rule.

#### 7. Status
```
DETECTED → PENDING_REVIEW → CONFIRMED_FOR_HANDOFF → HANDED_OFF → ACKNOWLEDGED
                          ↘ DISMISSED (with reason + reviewer)
```
`DISMISSED` never deletes anything; it records a reviewed decision.

#### 8. Escalation
An item in `PENDING_REVIEW` past its jurisdiction SLA escalates to a named
medical-affairs queue and raises an event. The SLA is policy data per
jurisdiction (regulators differ), never a hard-coded constant. Escalation must
not be silent: an un-actioned potential safety signal is itself a finding.

#### 9. Retention
- Quarantined narrative: retained per jurisdiction policy, minimum until the
  handoff is acknowledged, then subject to the platform retention engine.
- Handoff metadata and audit: retained for the regulatory period; append-only.
- Deletion is a governed platform operation, never an application path, and never
  removes the audit trail of the decision.

#### 10. PHI restrictions
- The narrative is **quarantined, never published**: it must not enter call-report
  search, HCP 360, briefings, exports, campaign data, or any intelligence source.
- No quarantined content may become a `CohortContribution`. If a future source
  wants safety-derived signals, it goes through the CCR-004 clinical path, not
  this one.
- Quarantine is storage under restricted read, not a clinical record: it carries
  no patient entity, no diagnosis field, and no foreign key to any clinical table.

#### 11. Failure behavior — fail closed, but never lose the report
| Failure | Behaviour |
| --- | --- |
| Port unavailable (today's state) | Intake still records and quarantines; handoff stays `CONFIRMED_FOR_HANDOFF`; a refusal is audited. Nothing is silently dropped. |
| Destination rejects | Status returns to `PENDING_REVIEW`, escalation timer continues, alert raised. |
| Classification uncertain | Treat as `POTENTIAL_SAFETY_SIGNAL` and quarantine. The safe default is to over-report into a governed queue, never to under-report. |
| PHI detected | Quarantine, never reject-and-discard. **This is a change from today**, where the guard returns 400 and the representative's text is lost — losing a possible safety report is worse than storing it under restricted read. |
| Duplicate submission | Idempotent on `handoffId`. |

#### 12. What Agent 4 will build once approved, and what it will not
Will: field-side intake, classification record, quarantine store, status machine,
the `safety:handoff` permission, events, audit, and negative tests.
Will **not**: the destination workflow, causality or seriousness assessment,
regulatory submission, any clinical write, or any AI that classifies autonomously.

- Backward compatibility: fully additive. Nothing changes until approved; the
  existing PHI guard keeps its current reject behaviour until the quarantine store
  exists, so there is no window in which text is accepted but unprotected.
- Tests (once approved): a representative cannot release a handoff; quarantined
  narrative never appears in 360/briefing/export/intelligence; the port refuses
  while unavailable and the report is still retained; AI-suggested classification
  cannot hand off without human confirmation; no clinical table is referenced.
- Decision (Agent 1 / Agent 2): _pending_

- **Decision (Agent 1 / Integration I-4):** APPROVED as a CONTRACT/DESIGN only;
  renumbered from Agent 4's CCR-007 to **CCR-010** (collided with the existing
  drug↔allergen CCR-007). Per directive §3 the PHI-quarantine / adverse-event
  handoff behaviour is **NOT implemented** this session — it stays PROPOSED and
  fail-closed (the port is `available:false` and refuses every call, mirroring
  CCR-004). The design is sound (data-minimised, no clinical coupling, MEDICAL_
  AFFAIRS-gated, append-only audit). Implementation is deferred to a dedicated,
  independently-audited phase owned by Agent 1 + Agent 4.


### CCR-011 — Recurring expiry sweeps driven by the shared automation scheduler
- Status: PROPOSED — **design only; not implemented (no genuine gap today)**
- Requested by: Agent 1 (Integration Owner), final integration audit I-7
- Date: 2026-09-17
- Affects: Agent 4 (pharma/intelligence expiry sweeps), Agent 3 (automation/
  scheduler architecture), Agent 1 (platform, deployment/worker wiring)
- Contract file(s): none yet. The sweep functions already exist and are owned by
  Agent 4 (`sweepSignalExpiry`, `sweepHcoVerifications`, `sweepExpiredVerifications`);
  the scheduler is owned by Agent 3 (`modules/automation/scheduler*`).

#### Why this is a contract, not a bug
The final audit re-examined the known open question: *"Pharma expiry sweeps exist
but scheduling may require Agent 3 scheduler integration."* Investigation shows
there is **no correctness or disclosure gap**, so nothing is implemented this gate:
- **Expiry is DERIVED at read, not swept.** Every read path computes effective
  status through STABLE SQL functions — `pharma_effective_verification(status,
  expires_at)` (HCP/HCO, migration 0306/0307) and `pharma_effective_signal_status(
  lifecycle_status, expires_at)` (signals, 0311). A lapsed record therefore **reads
  as expired the instant its clock passes**, whether or not any sweep has run. No
  stale "verified" or "published" state is ever disclosed. This is fail-safe by
  construction.
- **The sweeps are bookkeeping, not a gate.** `sweepSignalExpiry` /
  `sweepHcoVerifications` / `sweepExpiredVerifications` materialise the stored
  status and write the transition into the append-only decision trail
  (`aggregated_signal_event`, etc.). They make the *audit trail* complete; they do
  not make the *disclosure* safe (that is already guaranteed above).
- **No workaround was built inside Pharma.** Each sweep is reachable only through an
  admin-gated HTTP endpoint (`intelligence:publish` / the relevant steward
  permission). This mirrors the platform's own scheduler, whose `runDueActions`
  entry point is documented as *"called on an interval by a worker, or on demand"*
  via an admin-gated route. Pharma follows the identical operator/worker-driven
  model — it did not embed a timer, a cron, or a cross-domain call.

#### The (optional, future) contract
IF a deployment later wants the decision-trail bookkeeping to happen automatically
rather than by an operator/worker call, it MUST go through the existing shared
automation architecture, preserving ownership:
- Agent 3 exposes a recurring/interval registration in the automation scheduler
  (the `trigger_type='schedule'` + `schedule_cron` rule shape already modelled in
  migration 0200 is the natural home). Agent 3 owns the scheduler; Agent 4 does not
  reach into it.
- Each sweep is registered as an **idempotent scheduled action** whose handler
  calls the Agent 4 sweep service function behind its existing permission. Sweeps
  are already idempotent (a re-run is a no-op once statuses are materialised), so
  at-least-once scheduling is safe.
- No new cross-workstream import: pharma does not import automation and automation
  does not import pharma; the wiring is an action-registry entry owned by the
  platform/automation side, exactly like every other scheduled action.

#### Decision (Agent 1 / Integration I-7)
PROPOSED / **deferred as an operational enhancement**. Not required for v1
correctness or security (expiry is derived and fail-safe). Recorded here so the
future path is the governed one — a scheduled action through Agent 3's engine —
rather than a timer smuggled into the pharma layer. No code, no migration, no new
dependency this gate.


### CCR-009 — Intelligence signal response: exact cohort size replaced by a band
- Status: **ACKNOWLEDGED / APPROVED** (renumbered from Agent 4's CCR-006 at integration — collided with Agent 2's patient-extension CCR-006)
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
- **Decision (Agent 1 / Integration I-3A):** APPROVED. This strengthens the
  intelligence firewall's cohort protection (differencing/narrowing defence,
  directive §6) and is confined to Agent 4's own API surface with no external
  consumer — no cross-workstream impact. Integrated and covered by
  `intelligence-redteam.test.ts` (no `cohortSize` in any response; exact value
  still stored for audit + the 0304 threshold CHECKs). Status → DONE.

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
  - **Reaffirmed at Integration I-3A:** Agent 4's new query-governance/disclosure
    work (0305, P28/P29) operates over pharma's OWN field data — it does NOT wire
    the clinical source. Verified: no pharma/intelligence module references a
    clinical table (static scan) and `clinical_governed` still returns 501. CCR-004
    remains fail-closed.

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
- **Decision (Agent 1 / Integration I-3A):** APPROVED as a platform
  responsibility; implementation **DEFERRED** to a platform file-storage phase
  (roadmap Phase 3 / §7 shared services). The proposed tenant-scoped
  `putObject/getObject` shape is accepted, with Clinical Core remaining the sole
  authorization authority (the storage service is never the auth point). Current
  conservative behavior stands: metadata-only + externally-produced `storage_key`.
  **Backup-scope caveat (recorded in PRODUCTION-READINESS):** document *bytes*
  live outside Postgres, so the DB backup does not yet cover them — the file
  store must ship with its own backup coverage before documents are used for
  primary storage in production.
- **Backup-gap audit (Agent 1 / Integration I-5):** verified — **no document
  bytes exist anywhere today.** `document_reference` (0108) stores metadata only;
  `storage_key` is an opaque, externally-produced pointer and no platform
  file-store has been implemented. There is therefore nothing for the backup
  engine to miss right now, and implementing blob backup would be speculative
  (no store to snapshot) — so it is **DEFERRED** (per the batch rule "implement
  only if it can be done safely"). **Clean integration path when the file-store
  lands:** (1) the store writes tenant-partitioned, encrypted-at-rest blobs under
  a single configured root; (2) each blob is content-addressed by its
  `checksum_sha256` (already a column) so backup and verify are integrity-checked;
  (3) `createBackup` gains a step that snapshots that root **atomically with**
  (immediately after) the pg_dump, recording the blob-set checksum in
  `backup_run`; (4) `verifyBackup`/`restoreBackup` extend to the blob set; (5) the
  DB dump is the source of truth for which `storage_key`s must exist, so restore
  can detect missing/orphaned blobs. This keeps the storage service out of the
  auth path and adds no cross-workstream coupling. Tracked for the file-storage
  phase; no code this batch.

### CCR review — Clinical Expansion Batch (Procedures/CarePlans/FHIR/Referral SLA/Follow-up)
- Reviewed CCR-001 (medication-master ref), CCR-004 (governed aggregate read,
  fail-closed), CCR-007 (drug↔allergen coding). **No new CCR required and none
  bypassed.** The FHIR MedicationRequest/AllergyIntolerance/Condition/Procedure
  mappers pass any coded reference (medicationRef, substanceRef, diagnosis/
  procedure code+system) through VERBATIM and emit text-only when no code
  exists — they invent no drug/allergen codes and never read the Drug Master.
  CCR-004's fail-closed pharma/intelligence read path is untouched (this batch
  adds no clinical→pharma export). CCR-001/007 remain PROPOSED/deferred.

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
- **Decision (Agent 1 / Integration I-3A):** APPROVED (contract shape);
  implementation **DEFERRED** per directive §4 — preserve the conservative
  current behaviour. The name-heuristic safety check remains authoritative today;
  a `ref` match is treated as definitive only when both refs are present (already
  the case). The coded cross-reference is NOT wired now because it needs a
  governed read of the drug master (allergen/ingredient codes only, never a
  direct table query, mirroring the CCR-004 firewall discipline). No clinical
  code changes when codes arrive (fully additive). Safety is not weakened in the
  meantime.
- **Reaffirmed at Integration I-4 (this session):** stays PROPOSED/deferred, do
  NOT implement the PHI-quarantine behaviour yet (per directive §3). Agent 2's
  CP-10/CP-11 re-review confirmed the conservative name-based check is still in
  force (`allergies-safety.test.ts`), no drug-master table is duplicated, and no
  Agent 4 module is imported by Clinical Core.

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
- **Decision (Agent 1 / Integration I-3A):** APPROVED and INTEGRATED (0104,
  Agent 2 range; no shared file changed). Additive columns are nullable/defaulted
  so downstream readers (Agent 3 recipients/conditions, Agent 4 de-identification)
  keep working. The one behavioural change — `birthDate` now serializes date-only
  (`"1980-04-02"`) instead of a full ISO timestamp — is accepted: it is more
  correct for a date column and has no shipped consumer. Status → DONE.

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
