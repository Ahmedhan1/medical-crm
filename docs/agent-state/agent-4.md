# Agent 4 — Pharma / HCP / Drug / Intelligence — State

## Current Status
**P001–P004 and P006 DONE. P005 DONE except its clinical input, which is blocked
on CCR-001 by design.** Branch `claude/jolly-carson-8t7ufe`, based on the Agent 1
foundation branch. Typecheck, build and the full test suite are green; migrations
apply cleanly from an empty schema.

## Completed
- **P001 — Physician/HCP master.** Provenance-aware HCP + HCO master data with a
  specialty taxonomy, identifiers, practice locations, affiliations (department +
  role + validity window), professional interests, verification workflow,
  `record_version` + append-only revision history, and identity-resolution merge.
- **Physician 360.** `GET /hcps/:id` — profile, provenance, specialties,
  identifiers, affiliations, locations, territories, interests, visits, call
  reports, open objections, scientific requests, follow-ups, content engagement,
  representatives and master-data history. Clinic- and territory-scoped, audited,
  and free of patient data by construction.
- **P002 — Drug/medication master.** Concept → ingredients → marketed product,
  with regulatory identity per jurisdiction, a licence-aware provider registry,
  traceable import runs and an append-only revision trail.
- **P003 — Territory + medical-rep platform.** Territories, assignments, HCP
  targeting with tier and call frequency, visit planning, today's calls,
  pre-visit briefing, call reports with products/objections/competitor mentions,
  scientific requests and follow-up actions.
- **P004 — Approved content hub.** Owner, version, jurisdiction, approval
  lifecycle with a separate approver, validity window, SQL-enforced expiry
  gating, engagement recording, append-only decision history.
- **P005 — Intelligence firewall + aggregated signals.** All seven stages
  implemented, tested and enforced; live over pharma's own field data. The
  clinical input is registered and refuses every request pending CCR-001.
- **P006 — Pharma marketing.** Declarative HCP segmentation, campaigns and
  campaign targeting, content distribution and engagement.

## In Progress
- None. Next steps are gated on Agent 1's decisions on CCR-001 and CCR-002.

## Database Changes
Reserved range **0300–0399**; 0300–0304 used. All forward-only, all applied
cleanly from an empty schema.

| Migration | Tables |
| --- | --- |
| `0300_hcp_master` | `specialty`, `hco`, `hcp`, `hcp_identifier`, `hcp_specialty`, `hcp_practice_location`, `hcp_hco_affiliation`, `hcp_professional_interest`, `hcp_revision` (append-only) |
| `0301_drug_master` | `manufacturer`, `medication`, `medication_ingredient`, `medication_product`, `medication_revision` (append-only), `medication_import_run` |
| `0302_pharma_field` | `territory`, `territory_assignment`, `hcp_territory`, `visit`, `call_report`, `call_report_product`, `visit_objection`, `call_report_competitor`, `scientific_request`, `follow_up_action`; adds `hcp_practice_location.territory_id` |
| `0303_pharma_content` | `approved_content`, `approved_content_revision` (append-only), `hcp_segment`, `hcp_segment_member`, `campaign`, `campaign_target`, `content_engagement`; adds `scientific_request.answer_content_id` |
| `0304_intelligence` | `intelligence_policy`, `intelligence_run`, `aggregated_signal` |

Constraints that carry governance rather than just integrity:
- `intelligence_policy.min_cohort_size >= 5` and `requires_deidentification` is
  CHECKed true — the threshold cannot be weakened from the database.
- `aggregated_signal`: `cohort_size >= min_cohort_size`, `min_cohort_size >= 5`,
  `deidentified` true, `policy_status = 'passed'` — even a bug in the pipeline
  cannot persist a re-identifiable cohort.
- `hcp`/`hco`/`medication`/`medication_product`: a `verified` record must carry
  `last_verified_at`.
- `approved_content`: `approved` requires an approver, a timestamp and an
  effective date.
- No pharma table has any column or foreign key referencing `patient`/`encounter`.

## API Changes
26 new endpoints under `http/features/pharma.feature.ts`, registered from five
route modules (`hcp`, `medication`, `rep`, `pharma-content`, `intelligence`).
`server.ts` and the barrels were not touched. The full table is in
`docs/workstreams/pharma-intelligence.md` §3.

## Permissions
26 new permissions in `permissions.pharma.ts`. `PHARMA_REP` receives 16 (HCP
read/search/write, HCO read, medication read, territory read, visit read/plan,
call report read/write, scientific request read/write, content read, segment
read, campaign read, intelligence signal read).

Deliberately **not** granted to `PHARMA_REP` (ADMIN-only until CCR-002):
`hcp:verify`, `hcp:merge`, `hco:write`, `medication:write`, `territory:manage`,
`scientificrequest:fulfill`, `content:write`, `content:approve`,
`segment:manage`, `campaign:manage`, `intelligence:publish`.

No pharma permission is granted to any clinical role, and `PHARMA_REP` holds no
clinical permission — both asserted in tests.

## Events
33 new types in `events.pharma.ts`: HCP/HCO master-data lifecycle
(created/updated/verified/merged/affiliation changed), medication master
(created/updated/product created/import completed), field force (territory
created/assigned, HCP targeted, visit planned/completed/cancelled, call report
submitted, scientific request created/answered, follow-up created/completed),
content (created/approved/withdrawn/engaged), marketing (segment created, member
assigned, campaign created, target added) and intelligence (run completed, signal
published, cohort suppressed). Payloads carry identifiers and shape only.

## HCP Changes
New master-data domain (see Database Changes). Key decisions:
- `hcp_identifier` accepts **professional/licensure identifiers only**; personal
  government identifiers are rejected at the service layer.
- Nothing is born verified; editing a verified record returns it to
  `pending_review`.
- Merge marks a duplicate `merged` with a pointer and makes it read-only; it is
  never deleted, so old references stay resolvable.
- Territory targeting is the visibility rule for representatives.

## Drug-master Changes
New domain (see Database Changes). Regulatory facts belong to a product in a
jurisdiction, not to the molecule. A registered provider with a declared licence
basis is required before data attributed to it can be written; imports are
recorded with counts and licence basis. No third-party dataset is bundled.

## Pharma Changes
Field platform, approved-content hub and marketing foundations (see Completed).
Authoring and approving content are separate permissions and the owner cannot
approve their own material; expiry gating is enforced in SQL.

## Intelligence Changes
Seven-stage firewall in `modules/intelligence/firewall.ts`, implemented as pure
functions so every rule is unit-testable and no caller can skip a stage.
Source registry in `sources.ts` with `pharma_field` implemented and
`clinical_governed` registered-but-refusing (HTTP 501, audited as a denied run)
pending CCR-001. Five signal types over pharma's own field data. Every signal
carries source, version, timestamp, scope, jurisdiction, confidence, aggregation
level, cohort size, threshold, method, provenance and policy status.

## Tests
**191 tests pass** (30 pre-existing foundation tests + 161 new), `npm run
typecheck` and `npm run build` clean, migrations apply from an empty schema.

| File | Tests |
| --- | --- |
| `test/unit/firewall.test.ts` | 20 |
| `test/integration/hcp-master.test.ts` | 20 |
| `test/integration/drug-master.test.ts` | 17 |
| `test/integration/pharma-field.test.ts` | 20 |
| `test/integration/pharma-content.test.ts` | 21 |
| `test/integration/pharma-firewall.test.ts` | 63 |

Boundary coverage specifically required by the brief:
- Pharma authorization boundaries — a doctor is refused by all ten pharma read
  endpoints; a representative is refused stewardship, approval, publication,
  territory management and out-of-territory access.
- Patient-data isolation — a pharma principal cannot reach any patient row, and
  no pharma response body contains a patient name, MRN or id.
- Intelligence firewall behaviour — patient-class input aborts a run;
  below-threshold cohorts publish nothing; the threshold cannot be weakened from
  the API or the database; published signals carry no subject identifier.

## Dependencies Added
None. No new npm package; the workstream uses the existing Fastify/pg/zod stack.

## Contract Changes
- **CCR-001 — Governed aggregate-only read path over clinical data.** PROPOSED.
  Blocks the clinical input to P005. Specifies the `CohortContribution` port
  Agent 1 (or Agent 2 under review) implements so the pipeline can obtain
  clinical-derived cohorts without pharma seeing a clinical row.
- **CCR-002 — Additional pharma role keys** (`PHARMA_DATA_STEWARD`,
  `MEDICAL_AFFAIRS`, `PHARMA_MANAGER`). PROPOSED. Purely additive; today the
  separated duties resolve to `ADMIN`.

No shared/contract file was edited. `TASKS.md` was touched only in the Agent 4
section (task statuses), as §Task Board allows.

## Known Issues / Blockers
- **P005's clinical input is blocked on CCR-001.** By design — pharma code must
  not read clinical tables to unblock itself. The pipeline is complete and live
  over pharma's own field data in the meantime.
- **Stewardship permissions resolve to `ADMIN`** until CCR-002 is decided. This
  over-grants (a clinic administrator should not be approving promotional
  material), though it never under-protects: `PHARMA_REP` holds none of them.
- **Master data is tenant-scoped** (`clinic_id` on every table, per `AGENTS.md`
  §6). For a multi-clinic deployment sharing one HCP/drug master, a future
  "global master + per-tenant projection" design would avoid duplicate records
  across tenants. Deliberately deferred — it is a contract-level decision.
- **Segment membership is additive on re-resolve**: an HCP who no longer matches
  a segment's criteria is not removed automatically. Membership rows record their
  basis (`rule`/`manual`) so a future reconciliation can distinguish the two.
- `pg` decodes `date` columns as `Date` objects; every pharma mapper normalises
  through `modules/pharma/dates.ts`. Foundation mappers (e.g. `patient.birth_date`)
  still return a `Date`, which serialises with a spurious time component — noted
  for Agent 1, not changed here (not my file).

## Next Tasks
1. Swap the `clinical_governed` stub for Agent 1's provider once CCR-001 is approved.
2. Grant pharma permissions to the new role keys once CCR-002 is approved.
3. HCP QR identity for fast field identification (reuses Agent 1's QR primitive,
   pharma permission, no PHI).
4. Region/country roll-up signals above territory precision, and
   period-over-period trend signals derived from stored aggregates.

## Last Commit
`8b22c0f` — P003/P004/P005/P006: rep platform, content hub, intelligence
firewall, tests and docs. Preceded by `57f4325` (P001/P002 schema and master
data). Branch `claude/jolly-carson-8t7ufe` is pushed and up to date.
