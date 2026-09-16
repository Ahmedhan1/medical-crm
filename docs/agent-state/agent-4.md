# Agent 4 — Pharma / HCP / Drug / Intelligence — State

## Current Status
Working on `claude/jolly-carson-8t7ufe`, **rebased onto `integration/medcore-v1`**
(`cabae55`). The earlier P001–P006 work is merged; this increment adds
**Phase 28/29 — statistical disclosure control and query governance**.

Suite: **413 tests green** (was 370 at the integration head). Typecheck, build
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
- **Phase 58 — PHI/disclosure red team** *(this increment)*: 17 attack tests.

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
Reserved range **0300–0399**; 0300–0305 used.

| Migration | Contents |
| --- | --- |
| `0300`–`0304` | (unchanged, see integration history) |
| `0305_query_governance` | `intelligence_query_log` (append-only); governance columns on `intelligence_policy`; `cohort_band` + `value_rounding_base` on `aggregated_signal` |

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
**413 green** (370 at the integration head + 43 new).

| File | Tests | Covers |
| --- | --- | --- |
| `test/unit/query-governance.test.ts` | 22 | narrowing containment, depth, budget/narrowing decisions, banding, rounding, complementary suppression |
| `test/integration/intelligence-redteam.test.ts` | 17 | differencing, narrowing chains, budget exhaustion, append-only refusal log, controls that cannot be configured away |
| `test/integration/pharma-firewall.test.ts` | 67 (+4) | updated to the banded contract; adds the "publishes nothing when suppression would expose a cohort" case |

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
- **CCR-006** *(new)* — notification that `cohortSize` was replaced by
  `cohortBand` on this workstream's own endpoints, with the security rationale.
  Filed rather than waived, because the rule should not be set aside by the agent
  making the change.

## Next Tasks
Ranked by value from the current audit, not by roadmap order:
1. **Phase 19 — adverse-event safety handoff.** Nothing exists. A rep who hears
   about a suspected adverse event has no governed route for it. Largest
   remaining regulatory gap in this workstream.
2. **Phase 6 — HCO 360**, plus first-class HCO locations and departments (a
   department is currently a text field on an affiliation).
3. **Phases 1–2 hardening** — HCP professional category and credentials;
   verification states `rejected` / `suspended` / `expired` with an expiry engine.
4. **Phase 63 — intelligence lifecycle** (draft → review → published → expired →
   archived). Signals publish on creation today and never expire.

## Last Commit
See `git log` on `claude/jolly-carson-8t7ufe`; this increment is the
`platform(P28/P29)` commit on top of `cabae55`.
