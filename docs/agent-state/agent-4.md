# Agent 4 — Pharma / HCP / Drug / Intelligence — State

## Current Status
Working on `claude/jolly-carson-8t7ufe`, merged up to `integration/medcore-v1`
(`97f1680`, platform P2 backup engine). This increment adds **Phases 5–7 — HCP
master hardening, the verification lifecycle and attribute provenance** — and
files **CCR-007**, the adverse-event handoff contract (design only).

Suite: **464 tests green** (421 at the merged integration head). Typecheck, build
and a from-empty migration run are clean.

## Completed
- **P001–P006** (merged at integration `6df7385`): HCP master, Physician 360,
  drug master, territory + medical-rep platform, approved-content hub, pharma
  marketing, and the seven-stage intelligence firewall.
- **Phase 44 — role hardening** — delivered by Agent 1 under CCR-005, not by this
  workstream. `PHARMA_DATA_STEWARD`, `MEDICAL_AFFAIRS` and `PHARMA_MANAGER` now
  hold the elevated pharma permissions; the ADMIN over-grant is closed.
- **Phase 28 — disclosure control** *(this increment)*: cohort banding, value
  rounding, complementary suppression.
- **Phase 29 — query governance** *(this increment)*: per-principal query budget,
  narrowing-chain detection, append-only query log, budget transparency endpoint.
- **Phase 58 — PHI/disclosure red team**: 21 attack tests (4 added this
  increment pinning the deliberate absence of any safety/clinical workflow).
- **Phases 5–7 — HCP master hardening** *(this increment)*: professional
  category, credentials, record validity window, `source_date`, the full
  verification lifecycle with derived expiry and a sweep, and attribute-level
  provenance resolved from the revision history.
- **CCR-007 — adverse-event handoff contract** *(this increment)*: filed as a
  proposal. No cross-domain workflow implemented, by directive.

## The gap this increment closed
Before this work the pipeline enforced a per-query minimum cohort but nothing
about *sequences* of queries. Verified against the running system with a throwaway
probe before any code was written:

- published signals carried **exact cohort sizes**, so `{A,B}=10` minus `{B}=8`
  recovers a below-threshold cohort of 2 in A;
- **unlimited repeated narrowing runs** were accepted — no budget, no rate limit,
  no detection, no record that a principal was narrowing a prior query.

Severity was moderate today (cohort subjects are HCPs, whose data pharma already
holds) but this is the approved landing zone for clinical aggregates under
CCR-004. Hardening the sink before that pipe opens was the point.

## Database Changes
Reserved range **0300–0399**; 0300–0306 used.

| Migration | Contents |
| --- | --- |
| `0300`–`0304` | (unchanged, see integration history) |
| `0305_query_governance` | `intelligence_query_log` (append-only); governance columns on `intelligence_policy`; `cohort_band` + `value_rounding_base` on `aggregated_signal` |
| `0306_hcp_master_hardening` | `hcp_credential`; `professional_category`, `source_date`, `effective_from/to`, `verification_expires_at`, `verification_note` on `hcp`; widened verification vocabulary; `pharma_effective_verification()` |

Constraints carrying governance rather than integrity:
- `intelligence_policy.max_queries_per_window` bounded `1..1000`;
  `query_window_hours` `1..720`; `max_narrowing_depth` `0..10`;
  `value_rounding_base` `1..100`.
- `complementary_suppression` is `CHECK (complementary_suppression)` — true only.
  An operator may make disclosure control stricter, never switch it off.
- `intelligence_query_log` rejects UPDATE/DELETE, so a principal cannot erase
  their own narrowing history to reset the budget.

## API Changes
- **New:** `GET /intelligence/query-budget` (`intelligence:publish`) — the
  caller's own budget position, so the limit need not be discovered by probing.
- **Changed (CCR-006):** published signals return `cohortBand` + `valueRoundingBase`
  instead of `cohortSize`, and `value` is rounded. The exact count stays in the
  database for the operator's audit and the 0304 CHECKs.
- **New refusal:** HTTP 429 `intelligence_query_governance` with
  `details.control` = `denied_budget` | `denied_narrowing`. 429 rather than 403
  because the principal holds the permission — the same request may succeed once
  the window rolls forward.
- `PUT /intelligence/policies` accepts `maxQueriesPerWindow`, `queryWindowHours`,
  `maxNarrowingDepth`, `valueRoundingBase`, each bounded to mirror the CHECKs.

## Permissions
No new permissions. `queryBudget` reuses `intelligence:publish` and reports only
the caller's own usage, never another principal's.

## Events
One new type in `events.pharma.ts`: `INTELLIGENCE_QUERY_DENIED`.

## Intelligence Changes
Two new modules, both pure so the rules are exhaustively testable:
- `intelligence/disclosure.ts` — banding, rounding, complementary suppression.
  Runs after the threshold stage and can only remove or blur; it never admits a
  cohort the firewall rejected.
- `intelligence/query-governance.ts` — slice containment, narrowing depth, budget
  and narrowing decisions.

Both governance checks run **before the source is fetched**: a refused request is
never computed. A refused attempt does not deepen the narrowing chain, so a
principal cannot lock themselves out with rejected probes.

## Tests
**464 green** (421 at the merged integration head + 43 new this increment).

| File | Tests | Covers |
| --- | --- | --- |
| `test/unit/hcp-verification.test.ts` | 11 | transition graph (no state reaches `verified` directly), material-change rule, expiry arithmetic |
| `test/integration/hcp-hardening.test.ts` | 23 | professional category, credentials, full lifecycle, derived expiry, sweep idempotency, attribute provenance, DB refusals |
| `test/integration/hcp-master.test.ts` | 23 (+3) | updated to the governed lifecycle; adds material vs non-material edit and reason-required cases |
| `test/integration/intelligence-redteam.test.ts` | 21 (+4) | adds safety negatives pinning the deliberate absence of any adverse-event or clinical path |
| `test/unit/query-governance.test.ts` | 22 | narrowing containment, depth, budget/narrowing decisions, banding, rounding, complementary suppression |
| `test/integration/pharma-firewall.test.ts` | 69 | the four firewall layers, banded contract, threshold immutability |

## Breaking change in this increment
`POST /hcps` now **requires** `professionalCategory`. Defaulting it to
`physician` would invent a fact about a real professional, which the workstream's
own "nothing is invented" rule forbids. The only consumers were this
workstream's own tests, which were updated to state the category explicitly.
Recorded here rather than filed as a CCR because no other workstream calls the
HCP API; if that changes, the next such change needs one.

## Defect found and fixed while testing
Territory scoping keyed only on `territory:manage`, so a `PHARMA_DATA_STEWARD`
— who legitimately has no territory — was locked out of the HCP master they
exist to curate, and `MEDICAL_AFFAIRS` would have been locked out of scientific
requests. `visibility.ts` now names an explicit
`CLINIC_WIDE_PHARMA_PERMISSIONS` set (`territory:manage`, `hcp:verify`,
`scientificrequest:fulfill`). `PHARMA_REP` holds none of them and remains
territory-scoped, asserted by the field-force and red-team suites.

## Known Issues / Limitations
- **Complementary suppression costs utility.** With only two cohorts where one is
  below threshold, nothing is published. Intended, and covered by a named test
  rather than hidden.
- **Narrowing detection is per-principal.** Two colluding principals can still
  difference across their separate histories. Closing that needs a clinic-wide
  budget, which would let one analyst exhaust another's quota — a trade-off worth
  making deliberately, not by default. Deferred and recorded here.
- **The budget is a fixed count, not a true privacy budget.** A differential-privacy
  accountant (ε per query, composed over the window) is the principled version;
  the abstraction is shaped to accept one without an API change.
- **Rounding is deterministic**, so repeated identical queries return the same
  rounded value. That is fine against differencing but would not survive an
  averaging attack over many *distinct* slices; the narrowing and budget controls
  are what bound that today.
- `clinical_governed` remains fail-closed. CCR-004 is APPROVED as a contract but
  its implementation is **owned by Agent 1 + Agent 2**, not this workstream.

## Contract Changes
- **CCR-004** — APPROVED (contract); implementation deferred to Agent 1 + Agent 2.
- **CCR-005** — APPROVED and implemented at integration.
- **CCR-006** — notification that `cohortSize` was replaced by `cohortBand` on
  this workstream's own endpoints, with the security rationale. Filed rather than
  waived, because the rule should not be set aside by the agent making the change.
- **CCR-007** *(new)* — Adverse Event Handoff Contract. Defines source,
  classification, minimal payload, destination port, authorization, audit,
  status, escalation, retention, PHI restrictions and failure behaviour. **Design
  only**: Agent 4 builds the field-side intake once approved and never the
  destination. Notably it proposes replacing today's reject-and-discard PHI guard
  with quarantine — losing a possible safety report is worse than storing it
  under restricted read.

## Next Tasks
Following the directive's recommended order, with the audit's findings:
1. **Phase 3 — HCO locations and departments** as first-class entities (a
   department is still a text field on an affiliation), then **Phase 6 — HCO 360**.
2. **Phases 10–11 — medical-representative profile and manager hierarchy.**
   Authorization must follow the hierarchy; a manager must not reach every
   territory by default.
3. **Phase 12/13 — field-visit modality and field-note quarantine.** Quarantine
   is coupled to CCR-007: it replaces today's reject-and-discard, so it should
   land with (or after) that approval.
4. **Phase 63 — intelligence lifecycle** (draft → review → published → expired →
   archived). Signals publish on creation today and never expire.
5. **Phase 19 — adverse-event handoff**, only once CCR-007 is approved by
   Agent 1 + Agent 2. Not to be built unilaterally.

## Last Commit
See `git log` on `claude/jolly-carson-8t7ufe`; this increment is the
`pharma(P5-P7)` commit on top of the merge of `integration/medcore-v1` (`97f1680`).
