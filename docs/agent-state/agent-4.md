# Agent 4 — Pharma / HCP / HCO / Drug / Medical Affairs / Intelligence — State

## Current Status — CROSS-DOMAIN AUDIT PASS DONE
Branch `claude/jolly-carson-8t7ufe`. Finishes the Pharma surface, red-teams it
from a valid `PHARMA_REP` account, and audits the Clinical and AI boundaries
from the Pharma side without touching Agent-2 or Agent-3 code.

**Suite: 1188 tests green, 0 skipped** (1120 at `2a2b5bb`, 68 added). Typecheck,
build and a from-empty migration run are clean.

### Pharma findings fixed

| # | Area | Finding |
| --- | --- | --- |
| 1 | Drug Master | The THIRD governed master was never brought up to the bar 0306/0307 set for the other two: `verifyMedication` accepted any status, so `unverified → verified` in one step was legal; verification was gated by `medication:write`, so anyone who could RECORD a product could also ATTEST it; there was no `rejected`/`suspended` and no expiry, so a record attested in 2019 still read `verified`. Fixed by `0315` + `medication:verify` + the shared lifecycle module + a sweep. |
| 2 | PHI in logs and events | `guards.ts` screened what a REPRESENTATIVE types and nothing a STEWARD types. `evidenceSource`, verification `note`, merge `reason`, escalation `reason` and a signal's rejection/withdrawal reason were all unscreened — and every one lands in an append-only revision trail, the audit log, or (HCO and signal paths) a payload on the SHARED event bus. Append-only means a pasted MRN could not be edited out afterwards. Now screened on every governance path. |
| 3 | Documentation | The state file still used pre-integration CCR numbers (`CCR-006`/`CCR-007`) that the register reconciled to `CCR-009`/`CCR-010`. Corrected. |

### Security review — no escalation found
38 adversarial tests from a valid `PHARMA_REP` account across tenancy,
territory, the manager hierarchy, master-data stewardship, content, medical
affairs, intelligence, export, audit integrity and unauthenticated access. All
refused. Two of those tests were VACUOUS as first written — an `UPDATE` against
an empty table succeeds trivially — and now seed a real policy row before
attacking it. The cohort floor held: `CHECK (min_cohort_size >= 5)` has been in
`0304` since the start, and the API bound refuses a lowering for a publisher
too, not only for a rep.

### Cross-domain audit
Twelve static, repo-wide assertions now run in Agent 4's own suite, so the
boundary is a property the build enforces rather than a reading someone took
once. Findings for Agents 2 and 3 are filed as **CCR-011** and **CCR-012**; no
Agent-2 or Agent-3 file was modified.

## Previous status — governance audit pass
Branch `claude/jolly-carson-8t7ufe`. A deep completion-and-governance audit of
the whole Pharma surface, on top of the verified `0307`–`0312` work at
`aa337a5`. Nothing already delivered was reimplemented; migrations `0307`–`0312`
are byte-identical to `aa337a5`.

Ten findings, all pre-existing, all fixed. Two additive migrations, `0313` and
`0314`. **Suite: 1110 tests green, 0 skipped** (1047 at `aa337a5`, 63 added
here). Typecheck, build and a from-empty migration run are clean.

### What the audit found

| # | Area | Finding | Kind |
| --- | --- | --- | --- |
| 1 | HCO sites / departments | 0308 gave both the full master-data column set — provenance, the eight-state verification vocabulary, `verified_by`, `verification_expires_at`, `operating_status` — and the CHECK constraints for it, then made them **write-once**. No update, no verification decision, no operating-status change, no history. The schema promised governance no endpoint delivered. | capability |
| 2 | Specialty taxonomy | **Tenancy leak.** `createSpecialty` never validated `parentId`, and `specialty.parent_id` references `specialty(id)` with no clinic in the constraint — so a specialty in one tenant could be given a parent from another. Every other parent link here (HCO, territory) checks the tenant; this one did not. | security |
| 3 | HCP merge | Merging an HCO required a recorded reason; merging an HCP — equally destructive to identity resolution — required none. The same act held to two bars. | governance |
| 4 | HCP credentials | `valid_from` / `valid_to` were stored and never interpreted, so a board certification that lapsed in 2019 was returned looking exactly like one renewed last month — citable by a rep, countable by a report. | correctness |
| 5 | Institutional visits | `preVisitBriefing` and `getCallReport` applied territory scope **only when the visit had an HCP**. An institutional visit (0309) has none, so the guard was skipped entirely and any `visit:read` holder in the clinic could open another rep's institutional briefing and call report. | security |
| 6 | Medical affairs | The reason requirement looked only at the destination state, so `rejected` demanded a rationale while `open → closed` demanded none. **Closing a question nobody had answered was an unexplained refusal that walked past the rule.** | governance |
| 7 | Signal review | `reviewed_by` / `reviewed_at` existed on `aggregated_signal` from 0311 and **no code path ever wrote them** — the service read each value and wrote it straight back. Dead columns that looked like an answer. | correctness |
| 8 | Signal withdrawal | Every non-withdraw transition NULLed the withdrawal fields, so re-submitting a withdrawn claim **destroyed the record of why a live claim had been pulled** — at exactly the moment that reason matters most. | governance |
| 9 | Signal expiry / re-run | The sweep bulk-updated lapsed signals and audited a count; a re-run silently returned a published signal to `draft`. Both are lifecycle transitions and neither was attributable afterwards. | governance |
| 10 | Signal decision history | No first-class trail comparable to `visit_event` / `scientific_request_event`. The row held a snapshot of the latest decision, not a history. | capability |

### Verified and deliberately left alone

- **Lifecycle state IS the authorization source** for signals, not `published_at`
  — that column is now stored and returned and gates nothing. Pinned by a test
  that forges the pre-0311 shape (a publication timestamp on an unreviewed
  claim) and asserts it stays invisible to consumers and to exports.
- **No HCO directory report.** Nothing in the export registry or any caller
  needs one; adding it would be speculative.
- **The assignee is not forced to be the answerer** in medical affairs. A
  colleague covering an absent reviewer is legitimate, and the trail records who
  actually answered.
- Firewall, `ABSOLUTE_MIN_COHORT = 5`, banding, rounding, complementary
  suppression, query budgets, narrowing detection, CCR-004 fail-closed: untouched
  and re-verified.

### New in this pass

| Migration | Contents |
| --- | --- |
| `0313_hco_site_governance` | `record_version` on `hco_location` / `hco_department`; append-only `hco_location_revision` and `hco_department_revision`; expiry-sweep partial indexes |
| `0314_signal_decision_trail` | append-only `aggregated_signal_event` — generation, submission, approval, rejection, publication, withdrawal, expiry, supersession |

Both additive: every column added with a default, no column changes type or
nullability, no data rewritten.

New endpoints: `PATCH`, `POST :id/verification` and `GET :id/history` on
`/hco-locations` and `/hco-departments`; `GET /intelligence/signals/:id/history`.
Changed: `POST /hcps/:id/merge` now requires `reason`; the HCO sweep reports
organisations, sites and departments separately; credentials carry a derived
`validity`.

Two design points worth keeping:
- **`aggregated_signal_event.actor_id` is nullable, and that is load-bearing.**
  An expiry is the system observing a clock, not a decision by whoever happened
  to run the sweep; attributing it to them would be a lie of the kind the trail
  exists to stop. A run is operated by a person, so generation and supersession
  *are* attributed.
- **`assertVisitReadable` is deliberately wider than `assertVisitOwnership`.** A
  call report is about the account — a colleague in the same territory is
  entitled to it and can already see it through HCP 360. How a rep spent their
  day is personnel information, so the status trail keeps the narrower rule.

## Previous status — completion pass (0307–0311)
Branch `claude/jolly-carson-8t7ufe`, merged onto the trusted baseline
`integration/medcore-v1` (`659b285`).

The five reserved WIP migrations `0307`–`0311` are now **complete end-to-end**:
schema, repository, service, routes, RBAC, tenant/territory isolation,
validation, audit, events, tests and integration. The three `a4/*` WIP branches
are superseded and should be considered dead — their material was verified, not
trusted, and several parts were changed or extended before being used.

| Reserved migration | Was | Now |
| --- | --- | --- |
| `0307` HCO master | schema only, never applied | complete |
| `0308` HCO locations / departments / 360 | schema only | complete |
| `0309` Medical rep / field force | schema only | complete, plus four holes closed |
| `0310` Medical affairs | schema only | complete, plus separation of duties made real |
| `0311` Intelligence signal lifecycle | schema only | complete; the pipeline no longer publishes itself |

## Phase 1 — audit findings of the completion pass (what was wrong then)

Traced against the code at `659b285`, not against any earlier summary.

| # | Area | Finding | Status |
| --- | --- | --- | --- |
| 1 | HCO master | Real master data with far less governance than `hcp`: no identifiers, no ownership or operating status, no revision history, five-state verification vocabulary, no merge path. Three endpoints in total (`POST`/`GET`/`GET :id`). | fixed (0307) |
| 2 | HCO sites / departments | Did not exist. A "department" was free text on an affiliation, so `Cardiology`, `cardiology` and `Dept. of Cardiology` were three departments and none could be verified or counted. | fixed (0308) |
| 3 | HCO 360 | Did not exist. | fixed (0308) |
| 4 | Duplicate `Hco` type | Defined in `hcp.types.ts` **and** in the WIP `hco.types.ts`. | fixed — one definition, re-exported |
| 5 | Field force | No representative profile and no reporting hierarchy. The only way to supervise another rep was `territory:manage`, which reaches the whole clinic: a district manager saw nobody or everybody. | fixed (0309) |
| 6 | Visit status | Enforced only "completed is terminal". A cancelled call could be un-cancelled; a no-access needed no reason; nothing recorded how a visit reached its state. | fixed (0309) |
| 7 | Institutional calls | `visit.hcp_id` was `NOT NULL`, so a call on a hospital procurement office was unrepresentable. | fixed (0309) |
| 8 | Visit modality | Missing. A virtual detail and a face-to-face detail were indistinguishable. | fixed (0309) |
| 9 | `listVisits` scoping | **Pre-existing defect.** A territory-scoped principal was filtered by ownership AND territory. Ownership is the stronger scope, so the territory clause could only subtract — and did, hiding a rep's own institutional call whenever the organisation had no sited location. | fixed |
| 10 | Medical affairs | No assignment, no medical classification, no service level, no escalation, no event trail, and a rejection needed no reason. | fixed (0310) |
| 11 | Separation of duties (medical affairs) | Rested on an accident: MEDICAL_AFFAIRS had no permission to raise a request, so nobody could answer their own question because nobody could ask one. An ADMIN could. | fixed — now an identity rule, and the grant that exposed it was added |
| 12 | Signal publication | A firewall run published its own output on computation. The arithmetic was reviewed; the claim never was. | fixed (0311) |
| 13 | Signal retraction / expiry | Neither existed. A signal later known to be wrong stayed on display for ever. | fixed (0311) |
| 14 | Re-running the pipeline | An upsert silently replaced the value of an already-published signal, keeping its publication. | fixed — a re-computed signal returns to `draft` |
| 15 | Export eligibility | `intelligence_signals` filtered on `published_at IS NOT NULL`, the honest proxy available at the time. | fixed — filters the EFFECTIVE lifecycle status |

Deliberately **not** changed: the firewall, `ABSOLUTE_MIN_COHORT = 5`, banding,
rounding, complementary suppression, narrowing detection, query budgets,
`clinical_governed` fail-closed (CCR-004), CCR-007 (Agent 2's) and CCR-010 (adverse events, design only).
No adverse-event pathway was built.

## Design decisions worth knowing

- **One lifecycle module per concept, reused rather than copied.** The HCO master
  reuses `hcp/verification.ts` and the SQL function
  `pharma_effective_verification`, so the two masters cannot drift about what
  "expired" means, and the HCO verification API uses the same field names as the
  HCP one.
- **Derived state beats swept state.** Verification expiry, SLA breach and signal
  expiry are all computed on read (in SQL where a filter needs them), so
  correctness never depends on a background job having run. The sweeps only make
  the stored value agree with what callers already see.
- **`territory:manage` stays clinic-wide, deliberately.** It owns the territory
  model itself and is held by PHARMA_MANAGER, never by a representative. Field
  supervision no longer needs it: the reporting hierarchy gives a district
  manager their own subtree. This trade-off is recorded rather than implicit.
- **Refusals are attributed.** Rejected/suspended master data, cancelled and
  no-access visits, rejected scientific requests, and rejected or withdrawn
  signals all require a recorded reason, enforced by CHECK constraints as well as
  by the services.

## Database changes
Reserved range **0300–0399**; `0300`–`0315` used.

| Migration | Contents |
| --- | --- |
| `0300`–`0306` | (unchanged — HCP master, drug master, field, content, intelligence, query governance, HCP hardening) |
| `0307_hco_master` | ownership, operating status, merge target, source/effective dates, eight-state verification, evidenced-refusal CHECK, `hco_identifier`, append-only `hco_revision` |
| `0308_hco_locations` | `hco_location`, `hco_department`, governed department link on `hcp_hco_affiliation` (legacy text kept, never backfilled) |
| `0309_field_force` | `field_rep_profile`, `visit.modality`, nullable visit/report subject with `*_has_subject` CHECKs, append-only `visit_event` |
| `0310_medical_affairs` | assignment, inquiry category, priority, SLA, source channel, escalation with an evidence CHECK, append-only `scientific_request_event` |
| `0311_intelligence_lifecycle` | `aggregated_signal` lifecycle columns, no-self-approval CHECK, evidenced refusal/withdrawal CHECKs, `pharma_effective_signal_status()` |
| `0312_pharma_export_log` | append-only export receipts |
| `0313_hco_site_governance` | `record_version` and append-only revision tables for `hco_location` / `hco_department`; expiry-sweep partial indexes |
| `0314_signal_decision_trail` | append-only `aggregated_signal_event` |
| `0315_drug_master_governance` | eight-state verification, `verified_by`, expiry and evidenced-refusal CHECK on `medication` / `medication_product` |

`0311` deliberately RETRACTS pre-existing signals to `draft`. Grandfathering
unreviewed claims as published truth is the finding the migration exists to
close; `generated_at` still records when each was computed.

## API changes

New: fourteen `/hcos*` endpoints (master, verification, sweep, merge,
identifiers, locations, departments, history, 360); `/field-force/profiles`
(PUT/GET/GET :id); `GET /visits/:id/history`; `GET /scientific-requests/:id`,
`/queue`, `POST .../triage`, `POST .../escalate`;
`GET /intelligence/signals/:id`, `POST /intelligence/signals/:id/decision`,
`POST /intelligence/signals/expiry-sweep`.

Changed:
- `POST /visits` takes `hcpId`, `hcoId` or both, and a `modality`.
- `GET /visits` filters on `hcoId` and `modality`.
- `GET /intelligence/signals` returns only `published` to a consumer and accepts
  `lifecycleStatus` from a governance principal; a consumer asking for anything
  else is **refused**, not silently narrowed.
- `POST /hcps/:id/affiliations` accepts `hcoDepartmentId`.

## Permissions
Three changes, each with a reason:
- **`hco:verify`, `hco:write`-adjacent `hco:merge`** — new, granted to
  PHARMA_DATA_STEWARD only. Attesting that a record is true is a different act
  from recording what someone told you.
- **`scientificrequest:write` granted to MEDICAL_AFFAIRS** — 0310 gives a request
  a `source_channel`; a medical-information line, an email or a congress question
  arrives with no representative to raise it, so those channels were unreachable.
  Separation of duties does not weaken: it never should have depended on
  withholding a permission and is now carried by `assertAnswerable`.

No new permission was invented for the field force (`territory:read` /
`territory:manage`) or for the signal lifecycle (`intelligence:publish`), because
neither adds a decision an existing permission does not already carry.

## Events
New in `events.pharma.ts`: `HCO_UPDATED`, `HCO_VERIFICATION_CHANGED`,
`HCO_MERGED`, `HCO_LOCATION_ADDED`, `HCO_DEPARTMENT_ADDED`,
`FIELD_REP_PROFILE_CHANGED`, `SCIENTIFIC_REQUEST_ASSIGNED`,
`SCIENTIFIC_REQUEST_ESCALATED`, `INTELLIGENCE_SIGNAL_LIFECYCLE_CHANGED`.
Every payload carries shape and identifiers only — never a signal's value, never
free text, never anything patient-identifiable.

## Tests
**199 new** in this pass, on top of the suites already in the baseline.

| File | Tests | Covers |
| --- | --- | --- |
| `test/integration/hco-master.test.ts` | 48 | identity, provenance, authorization, the verification lifecycle and its derived expiry, updates and material change, merge (including chain refusal), identifiers |
| `test/integration/hco-360.test.ts` | 12 | composition, governed department resolution, territory scope as a second dimension, the clinical firewall |
| `test/integration/pharma-fieldforce.test.ts` | 33 | profiles, hierarchy (subtree not clinic, cycles, a cycle planted past the service), modality, institutional calls, the visit status trail |
| `test/integration/pharma-medaffairs.test.ts` | 34 | triage, service levels, escalation, separation of duties, the request trail, the queue, tenancy |
| `test/integration/intelligence-lifecycle.test.ts` | 25 | drafts, the review path, self-approval, retraction, derived expiry, re-runs, export eligibility |
| `test/unit/visit-lifecycle.test.ts` | 11 | the transition graph, terminal states, evidenced outcomes, modality/status vocabularies not overlapping |
| `test/unit/request-lifecycle.test.ts` | 18 | the graph, separation of duties, SLA arithmetic, escalation preconditions |
| `test/unit/signal-lifecycle.test.ts` | 18 | nothing publishes itself, self-approval, derived expiry, what a consumer may read |

The firewall and red-team suites were **updated, not weakened**: they now drive
their drafts through review by a second principal, because a run no longer
publishes its own output.

## Known issues / limitations
- **A single-manager clinic cannot publish a signal.** No self-approval means two
  distinct `intelligence:publish` holders are required. This is the intended
  governance cost, the same one the content lifecycle already pays.
- **Escalation requires an actual SLA breach.** A critical question cannot be
  escalated while still in window. Escalating early would empty the signal, but
  it does mean urgency has to be expressed by priority at triage, not by escalation.
- **The legacy `hcp_hco_affiliation.department` text is not backfilled.** Guessing
  which structured department a free-text string meant is the data invention this
  platform refuses. Reads prefer the governed name when the link exists.
- **Territory scope on the HCO master itself is clinic-wide.** An organisation is
  not targeted the way a professional is; the people-bearing sections of HCO 360
  are scoped instead, and the response says which happened.
- Everything recorded in the previous state file about disclosure control still
  holds: per-principal (not clinic-wide) narrowing detection, a count-based rather
  than differentially-private budget, deterministic rounding.

## Contract changes
No new CCRs in this pass. CCR-004 remains APPROVED-as-contract with the
implementation owned by Agents 1 + 2 and `clinical_governed` still fail-closed;
CCR-010 (adverse events) remains DESIGN/PROPOSED with no workflow built.

## Remaining gaps and risks

Real, and none of them fixable inside this workstream today:

0. **Two cross-domain contracts are open.** `CCR-011`: pharma events sit on the
   shared bus and `automation_rule.event_type` is unconstrained free text, so a
   rule can bind to one. Harmless today only because no automation action can
   mutate pharma state and pharma payloads carry no patient id or free text —
   both Agent-4 disciplines, not Agent-3 guarantees. `CCR-012`: `DraftKind`
   includes `'call_report'`, a pharma artifact, with no promotion contract on
   the pharma side.

1. **No sweep scheduler.** Three expiry sweeps exist (HCP, HCO+components,
   signals) and all three must be invoked by a caller. Reads derive expiry so
   nothing is *wrong* without them, but the stored columns drift until someone
   runs them. Wiring them to a scheduler crosses into Agent 3's automation
   domain and needs a CCR.
2. **Narrowing detection is still per-principal.** Two colluding analysts can
   difference across their separate histories. A clinic-wide budget would let
   one analyst exhaust another's quota — a trade-off worth making deliberately,
   not by default.
3. **The query budget is a fixed count, not a privacy budget.** A differential-
   privacy accountant is the principled version; the abstraction is shaped to
   accept one without an API change.
4. **A single-manager clinic cannot publish a signal**, because no self-approval
   needs two distinct `intelligence:publish` holders. Intended governance cost,
   the same one the content lifecycle pays.
5. **Escalation requires an actual SLA breach**, so a critical question cannot be
   escalated while still in window. Urgency has to be expressed at triage.
6. **The legacy `hcp_hco_affiliation.department` text is still not backfilled**,
   deliberately — guessing which structured department a free-text string meant
   is the data invention this platform refuses.
7. **CCR-010 (adverse events) remains blocked** on Agents 1 + 2. No
   adverse-event pathway exists and none was built.
8. **CCR-004 remains fail-closed.** `clinical_governed` throws; its
   implementation is owned by Agents 1 + 2, not here.
