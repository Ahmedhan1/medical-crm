# Agent 4 — Pharma / HCP / HCO / Drug / Medical Affairs / Intelligence — State

## Current Status — COMPLETION PASS DONE
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

**Suite: 1047 tests green** (848 at the baseline, 199 added here). Typecheck,
build and a from-empty migration run are clean.

## Phase 1 — audit findings (what was actually wrong)

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
`clinical_governed` fail-closed (CCR-004), CCR-007 (design only) and CCR-010.
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
Reserved range **0300–0399**; `0300`–`0312` used.

| Migration | Contents |
| --- | --- |
| `0300`–`0306` | (unchanged — HCP master, drug master, field, content, intelligence, query governance, HCP hardening) |
| `0307_hco_master` | ownership, operating status, merge target, source/effective dates, eight-state verification, evidenced-refusal CHECK, `hco_identifier`, append-only `hco_revision` |
| `0308_hco_locations` | `hco_location`, `hco_department`, governed department link on `hcp_hco_affiliation` (legacy text kept, never backfilled) |
| `0309_field_force` | `field_rep_profile`, `visit.modality`, nullable visit/report subject with `*_has_subject` CHECKs, append-only `visit_event` |
| `0310_medical_affairs` | assignment, inquiry category, priority, SLA, source channel, escalation with an evidence CHECK, append-only `scientific_request_event` |
| `0311_intelligence_lifecycle` | `aggregated_signal` lifecycle columns, no-self-approval CHECK, evidenced refusal/withdrawal CHECKs, `pharma_effective_signal_status()` |
| `0312_pharma_export_log` | append-only export receipts |

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
CCR-007 remains DESIGN/PROPOSED with no adverse-event workflow built; CCR-010 is
untouched.

## Next tasks
1. HCO verification/expiry for **sites and departments** — the columns and the
   derived function are in place, but only the organisation has a decision
   endpoint today.
2. An HCO directory report, once someone actually needs one. Not added
   speculatively.
3. Signal lifecycle history as a first-class trail. Today the decisions are in
   `audit_log` and `event`; a dedicated table would match `visit_event` and
   `scientific_request_event`.
4. CCR-007 remains blocked on approval by Agents 1 + 2.
