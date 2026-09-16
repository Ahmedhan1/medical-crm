# Workstream: Pharma / HCP / Drug / Intelligence (Agent 4)

## Mission
Own the pharma field product and the governed intelligence layer: Physician/HCP
master, drug/medication master, territory + medical-rep workflow, approved
content, and privacy-preserving aggregated signals (blueprint §6–9, §18–27).

## Branch
`claude/jolly-carson-8t7ufe` (harness-assigned; the `agent-4/pharma-intelligence`
ownership rules in `AGENTS.md` §4 apply unchanged). Branched from the foundation
branch, which carries the working agreement and the shared contracts.

## Files owned
- `modules/pharma/**`, `modules/hcp/**`, `modules/drug/**`, `modules/intelligence/**`
- `modules/governance/permissions.pharma.ts`
- `domain/events.pharma.ts`
- `http/features/pharma.feature.ts` + `http/routes/{hcp,medication,rep,pharma-content,intelligence}.routes.ts`
- Migrations **0300–0399** (0300–0306 used)
- Pharma tests, this file, `docs/agent-state/agent-4.md`

---

## 1. Absolute governance boundaries (enforced *and* tested)

### No patient-level data reaches pharma — ever (§45)
This is enforced at four independent layers, each with its own test:

| Layer | Mechanism | Test |
| --- | --- | --- |
| Schema | No pharma table has a column or foreign key referencing `patient`/`encounter` | `pharma-firewall.test.ts` — migration scan + `information_schema` check |
| Code | No pharma module contains a query against a clinical table | `pharma-firewall.test.ts` — static scan over every pharma source file, with a self-check proving the detector is not vacuous |
| Permissions | `PHARMA_REP` holds zero clinical permissions; no clinical role holds a pharma permission | `pharma-firewall.test.ts` — asserted over `ROLE_DEFINITIONS`, plus live 403s in both directions |
| Input | Free text written in the field is screened for patient-identifier-shaped tokens before storage | `pharma-firewall.test.ts` — MRN, national-id and record-UUID cases |

The fourth layer exists because the first three cover machine paths only. A call
report is prose typed by a human, and prose is the one realistic way a patient
identifier could be carried across the boundary by hand. `modules/pharma/guards.ts`
rejects it with a 400 and never echoes the offending text back.

### The intelligence firewall (§24–25)
The only path from clinical data toward pharma is:

```
classification → authorization → de-identification → aggregation
→ minimum-cohort threshold → policy validation → allowed signal
```

`modules/intelligence/firewall.ts` implements every stage as a **pure function**
— no database, no principal, no I/O — so the rules are exhaustively unit-tested
(20 tests) and the only way to obtain a signal is `runFirewall`, which runs the
stages in order. Properties that hold by construction:

- A single `patient_identifiable` or `patient_pseudonymous` contribution **aborts
  the whole run**. It is not filtered out: its presence means an upstream source
  is mis-wired, so every result from that source is suspect. Classification is
  checked against the *data*, never against the caller's permissions — an ADMIN
  gets the same refusal as a representative.
- Below the threshold, the pipeline returns **nothing**, and says nothing about
  what was suppressed. "No cohort is large enough" must be indistinguishable from
  "there is nothing here", or absence becomes information about small cohorts.
- The minimum cohort is **5** (`ABSOLUTE_MIN_COHORT`), mirrored by a database
  CHECK. A policy may be stricter; nothing can be more permissive — not a policy
  row (CHECK `min_cohort_size >= 5`), not the API (validated), and not a direct
  INSERT (CHECK `cohort_size >= min_cohort_size`).
- De-identification hashes the subject key under a **per-run salt that is never
  persisted**, so signals from two runs cannot be linked back to a subject even
  by this system.

### The clinical source is deliberately not wired
`modules/intelligence/sources.ts` registers two sources. `pharma_field` is
implemented over pharma's own engagement data. `clinical_governed` is registered
with `available: false` and refuses every request with HTTP 501
`governed_read_contract_unavailable`, recording a denied run in the audit log.

Implementing it here would mean pharma code querying clinical tables — the exact
shortcut the architecture forbids. **CCR-004** (filed by this workstream as
CCR-001, renumbered at integration) is APPROVED as the contract shape, but Agent 1
deferred the provider build to Agent 1 + Agent 2, calling the current fail-closed
behaviour "the correct production posture". So the refusal stays, and it is
tested. Hardening the sink (Phase 28/29 below) before that pipe opens is
deliberate ordering.

### Disclosure control and query governance (Phase 28/29)
The minimum-cohort threshold decides *whether* a cohort may be published. It does
not, on its own, stop an analyst asking a **sequence** of individually-legal
questions and subtracting the answers. That gap was verified against the running
system before it was closed:

```
run over {territory A, B}  -> cohort 10
run over {territory B}     -> cohort  8
=> territory A had 2 — a below-threshold cohort, recovered by arithmetic
```

Five controls now close it, all policy-driven and CHECK-bounded so none can be
configured away:

| Control | What it stops | Where |
| --- | --- | --- |
| **Cohort banding** | Exact counts are what a differencing attack subtracts. The API returns `cohortBand` (`"5-9"`); the exact count stays in the table for the operator's audit and the 0304 CHECKs. | `disclosure.ts` |
| **Value rounding** | A one-subject delta between two narrowed queries. Published measurements round to the policy base (default 5), and a non-zero value never rounds to 0. | `disclosure.ts` |
| **Complementary suppression** | A lone suppressed cohort is recoverable from its published siblings, so the smallest survivor is withheld with it. | `disclosure.ts` |
| **Narrowing detection** | The chain itself. A request whose slice is strictly contained in slices this principal already ran is refused past `maxNarrowingDepth` (default 2). | `query-governance.ts` |
| **Query budget** | Volume. Differencing needs many queries; runs are bounded per principal per rolling window (default 30/24h). | `query-governance.ts` |

Both governance checks run **before the source is touched**: a refused request is
never computed, not computed and withheld. Refusals return HTTP 429
`intelligence_query_governance` naming the control, are audited, and are written
to the append-only `intelligence_query_log` — a principal probing the boundary
leaves a trail they cannot erase. A refused attempt deliberately does **not**
deepen the narrowing chain, so a principal cannot lock themselves out with
rejected probes, and `GET /intelligence/query-budget` reports a caller their own
position so they need not discover the limit by probing it.

The honest cost: with only two cohorts where one is below threshold,
complementary suppression means **nothing** is published. That is the intended
trade-off and is covered by a named test rather than hidden.

### HCP verification is a lifecycle, not a label (Phase 6)
```
unverified ──► pending_review ──► verified ──► expired ──► pending_review
     │               │    │           │
     └──► rejected ◄─┘    │           ├──► suppressed/suspended ──► pending_review
                          └──► suspended
```
`modules/hcp/verification.ts` holds the whole rule set as pure functions. Two
properties matter more than the graph:

- **Nothing reaches `verified` except through `pending_review`.** There is no
  edge from `unverified`, `rejected`, `suspended` or `expired` straight to
  verified — a unit test asserts this for *every* state, so a future edge cannot
  be added without failing.
- **Verification never survives a material change.** `MATERIAL_ATTRIBUTES` names
  exactly what a reviewer attested to (identity, category, specialty,
  professional contact, jurisdiction, validity window). Annotations (`notes`,
  `preferredLanguage`) and re-citing a source for unchanged facts are explicitly
  *not* material — an earlier, blunter rule downgraded a record for any edit,
  which punished stewards for improving provenance.

**Expiry is derived, not swept.** A verification is granted for a bounded period
(default one year). `pharma_effective_verification(status, expires_at)` computes
the effective state in SQL, and every read and every filter goes through it — so
a lapsed record reads as `expired` the moment it lapses, even if no sweep has
run. `POST /hcps/verification/sweep` then persists the same answer and emits
`HCP_VERIFICATION_EXPIRED`; correctness never depends on the sweep having run.
Rejection and suspension require a recorded reason, enforced by a CHECK as well
as by the service.

### Attribute-level provenance (Phase 7)
`GET /hcps/:id/provenance` answers "where did *this* field come from" by
resolving the append-only revision history — the latest revision that touched
each attribute, with its source, version and actor. It is derived rather than
stored in a parallel per-attribute table, so there is exactly one account of what
changed and it cannot drift from the history itself. `source_date` (when the
source asserted a fact) is now distinct from `created_at` (when we recorded it)
and `last_verified_at` (when we last checked it).

### Provenance on every reference field (§8, §23)
`source`, `source_version`, `source_ref`, `jurisdiction`, `last_verified_at` and
`confidence` are required at the API boundary on HCPs, HCOs, specialties,
medications and products — not defaulted silently. Nothing is born `verified`;
promotion to `verified` is a separate, evidenced stewardship act, and editing a
verified record drops it back to `pending_review`.

### Nothing is invented
This workstream asserts no medical, regulatory or market facts of its own. It
stores what a named source says, with the source attached, and every published
signal carries the method by which it was derived. The confidence score is a
documented saturating function of cohort size, labelled in each signal's
provenance as *not* a statistical confidence interval.

---

## 2. What is implemented

### P001 — Physician / HCP master (migration 0300)
A master-data system, not a contact table:
`specialty` (self-referencing taxonomy), `hco` (hierarchical organizations),
`hcp`, `hcp_identifier`, `hcp_specialty`, `hcp_practice_location`,
`hcp_hco_affiliation` (department + role + validity window),
`hcp_professional_interest`, and append-only `hcp_revision`.

- **Versioning:** every change increments `record_version` and appends a full
  JSON snapshot with the changed field names, the source and the actor.
- **Identity resolution:** `POST /hcps/:id/merge` marks a duplicate `merged` with
  a pointer to the survivor. The record is never deleted, so old references stay
  resolvable, and the merged record becomes read-only.
- **Identifiers:** an allow-list of *professional* systems only
  (`EG_MOH_LICENSE`, `EG_SYNDICATE`, `NPI`, `GMC`, `ORCID`, `INTERNAL`).
  Personal government identifiers are rejected with a 400 — an HCP record is a
  professional identity, not a civil one. Extending the list is a governance
  decision, not a code convenience.

### Physician 360
`GET /hcps/:id` returns the master record and its provenance, specialties,
identifiers, affiliations, practice locations, territories and targeting,
interests, visits, call reports, open objections, scientific requests,
follow-ups, content engagement, the representatives involved, and the master-data
history. It is scoped twice — by clinic and by territory — and audited. Every
response carries an explicit `dataBoundary` statement.

### P002 — Drug / medication master (migration 0301)
Three deliberately separate levels: `medication` (the concept/molecule, with ATC),
`medication_ingredient` (composition and strength), `medication_product` (the
marketed, packaged, registered item). Regulatory identity — authority, identifier,
status, approval and withdrawal dates — lives on the **product in a
jurisdiction**, because the same generic can be approved in one country and
withdrawn in another.

`providers.ts` is the import architecture: a provider must be registered with an
explicit `licenseBasis` before data attributed to it can be written, and a
provider that does not cover the jurisdiction is rejected. `medication_import_run`
records every bulk load with its provider, version, source reference, licence
basis and counts, so data can be traced, refreshed or removed if a licence
lapses. **MEDCORE ships no third-party drug dataset**; the registry describes how
an operator may obtain data, not data that is bundled.

### P003 — Territory & medical-representative platform (migration 0302)
`territory` (hierarchical), `territory_assignment`, `hcp_territory` (targeting
with tier and call frequency), `visit`, `call_report` and its children
(`call_report_product`, `visit_objection`, `call_report_competitor`),
`scientific_request`, `follow_up_action`.

Territory is the second scope, on top of tenancy: a representative sees only HCPs
targeted in a territory they are currently assigned to, and a representative with
no assignment sees **nothing** rather than everything. Defining territories,
assigning reps and targeting HCPs all require `territory:manage`, which a
representative does not hold — so a rep cannot widen their own visibility.

`GET /visits/:id/briefing` assembles the pre-visit brief: who the HCP is, their
specialties and interests, the last three calls, open objections, open scientific
requests, open follow-ups, and the approved content that is usable *today* in
their jurisdiction.

### P004 — Approved content hub (migration 0303)
`approved_content` carries an accountable owner, a version, a jurisdiction, an
approval state with approver and timestamp, and a validity window with a review
date; `approved_content_revision` is the append-only decision history.

- Authoring (`content:write`) and approving (`content:approve`) are different
  permissions, and **the owner cannot approve their own content**.
- Approval requires an effective date — there is no open-ended material.
- Expiry gating happens **in SQL**, so no caller can forget it: a representative
  retrieving content sees only what is approved and in-window, and recording
  engagement with expired content is refused with a 409.
- A scientific answer that cites content must cite *usable* content.

### P006 — Pharma marketing (migration 0303)
`hcp_segment` stores **declarative** criteria (specialty, territory, tier,
interest, verification status) as data, so membership can be re-resolved and
explained to a reviewer rather than being an opaque hand-made list. There is no
clinical criterion and there cannot be one. `campaign` + `campaign_target`
materialise targets from a resolved segment; `content_engagement` records
distribution and engagement per HCP, visit, channel and campaign.

### P005 — Healthcare intelligence (migration 0304)
`intelligence_policy` (threshold, precision, jurisdiction, allowed signal types),
`intelligence_run` (what was evaluated, published and suppressed) and
`aggregated_signal` (the only artefact pharma may read).

Signal types derived from pharma's own field data today:
`hcp_feedback_theme`, `scientific_question_trend`, `product_interest`,
`competitor_mention`, `availability_signal`. The subject of every contribution is
an **HCP**, so the cohort threshold protects individual professionals from being
identified through a small aggregate.

Every stored signal carries its full governance envelope: source, source version,
generation timestamp, scope type/id/label, jurisdiction, aggregation level,
period, cohort size, the threshold in force, confidence, method, provenance, and
policy key/status. Reading signals (`intelligence:signal-read`) and producing
them (`intelligence:publish`) are separate permissions; a representative holds
only the first, and sees only signals scoped to their own territories.

---

## 3. API surface

| Method | Route | Permission |
| --- | --- | --- |
| POST/GET | `/hcos`, `/hcos/:id` | `hco:write` / `hco:read` |
| POST/GET | `/specialties` | `hcp:write` / `hcp:read` |
| POST | `/hcps` | `hcp:write` |
| GET | `/hcps` | `hcp:search` (territory-scoped) |
| GET | `/hcps/:id` | `hcp:read` — **HCP 360** |
| PATCH | `/hcps/:id` | `hcp:write` |
| GET | `/hcps/:id/history` | `hcp:read` |
| POST | `/hcps/:id/verification` | `hcp:verify` |
| POST | `/hcps/:id/merge` | `hcp:merge` |
| POST | `/hcps/:id/{identifiers,affiliations,locations,interests,specialties}` | `hcp:write` |
| GET | `/medications`, `/medications/:id`, `/medications/providers`, `/medications/imports` | `medication:read` |
| POST | `/medications`, `/medications/:id/products`, `/medications/:id/verification`, `/medications/import` | `medication:write` |
| POST/GET | `/territories` | `territory:manage` / `territory:read` |
| POST | `/territories/:id/assignments`, `/territories/:id/targets` | `territory:manage` |
| GET | `/rep/territory`, `/rep/today`, `/rep/follow-ups` | `territory:read` / `visit:read` |
| POST/GET | `/visits`, `/visits/:id/status` | `visit:plan` / `visit:read` |
| GET | `/visits/:id/briefing` | `visit:read` |
| POST/GET | `/visits/:id/call-report` | `callreport:write` / `callreport:read` |
| POST | `/follow-ups/:id/complete` | `callreport:write` |
| POST/GET | `/scientific-requests` | `scientificrequest:write` / `:read` |
| POST | `/scientific-requests/:id/answer` | `scientificrequest:fulfill` |
| POST/GET | `/pharma/content`, `/pharma/content/:id`, `/pharma/content/:id/history` | `content:write` / `content:read` |
| POST | `/pharma/content/:id/decision` | `content:approve` (`content:write` to submit for review) |
| POST | `/pharma/content/:id/engagements` | `content:read` |
| POST/GET | `/pharma/segments`, `/pharma/segments/:id/resolve` | `segment:manage` / `segment:read` |
| POST/GET | `/pharma/campaigns`, `/pharma/campaigns/:id/targets` | `campaign:manage` / `campaign:read` |
| GET | `/intelligence/sources`, `/intelligence/signals`, `/intelligence/policies` | `intelligence:signal-read` |
| PUT/POST/GET | `/intelligence/policies`, `/intelligence/runs` | `intelligence:publish` |
| GET | `/intelligence/query-budget` | `intelligence:publish` (own usage only) |

---

## 4. How to add things
Same pattern as the other workstreams: your own `permissions.pharma.ts` /
`events.pharma.ts` / `pharma.feature.ts` / migrations 0300–0399. Grant pharma
permissions only to `PHARMA_REP` (and future pharma roles), never to clinical
roles. Never edit `server.ts` or the barrels.

Two local conventions worth keeping:
- **Dates.** `pg` decodes a Postgres `date` into a `Date` at local midnight,
  which breaks string comparison and can shift a day across a timezone. Every
  mapper normalises `date` columns through `modules/pharma/dates.ts`, so a
  calendar date is a `YYYY-MM-DD` string above the repository layer.
- **Free text.** Anything a human types that will be stored goes through
  `assertFreeTextClean` first.

## 5. Cross-agent dependencies
- **CCR-004** (governed aggregate-only clinical read) — APPROVED as a contract;
  implementation DEFERRED to Agent 1 + Agent 2. `clinical_governed` refuses every
  request until they build it. Do not read clinical tables to unblock this.
- **CCR-005** (pharma role keys) — APPROVED and implemented at integration.
  `PHARMA_DATA_STEWARD`, `MEDICAL_AFFAIRS` and `PHARMA_MANAGER` now hold the
  elevated permissions; the ADMIN over-grant is fixed.
- **CCR-006** (signal response: `cohortSize` → `cohortBand`) — filed as a
  notification; the change is confined to this workstream's own endpoints.
- HCP QR (fast field identification) would reuse Agent 1's QR primitive with a
  pharma permission — no PHI, same opaque-token contract. Not yet built.

## 6. Tests
161 pharma tests, all green alongside the foundation's 30:

| File | Tests | Covers |
| --- | --- | --- |
| `test/unit/firewall.test.ts` | 20 | every firewall stage, thresholds, policy, envelope |
| `test/integration/hcp-master.test.ts` | 20 | provenance, verification, versioning, merge, identifiers, tenancy |
| `test/integration/drug-master.test.ts` | 17 | licensing discipline, jurisdiction, regulatory identity, imports |
| `test/integration/pharma-field.test.ts` | 20 | territory scope, visits, briefing, call reports, scientific requests |
| `test/integration/pharma-content.test.ts` | 21 | approval lifecycle, expiry gating, engagement, segments, campaigns |
| `test/integration/pharma-firewall.test.ts` | 67 | the four firewall layers, the blocked clinical source, end-to-end signals, threshold immutability |
| `test/unit/query-governance.test.ts` | 22 | narrowing detection, budget decisions, banding, rounding, complementary suppression |
| `test/unit/hcp-verification.test.ts` | 15 | the transition graph, material-change rule, expiry arithmetic |
| `test/integration/hcp-hardening.test.ts` | 19 | professional category, credentials, the full lifecycle, derived expiry, the sweep, attribute provenance |
| `test/integration/intelligence-redteam.test.ts` | 17 | differencing, narrowing chains, budget exhaustion, controls that cannot be configured away |

## 7. Territory scope and clinic-wide principals
Territory scope exists to stop a **field representative** browsing the whole HCP
master. It is therefore applied to field principals only:
`CLINIC_WIDE_PHARMA_PERMISSIONS` in `visibility.ts` names the three permissions
whose holders work across the clinic — `territory:manage` (owns the territory
model), `hcp:verify` (a data steward's job *is* the whole master) and
`scientificrequest:fulfill` (medical affairs serves every HCP and holds no
territory). `PHARMA_REP` holds none of them and stays scoped, which the
field-force and red-team suites assert directly.

This was a real defect found while testing Phase 5: scoping keyed only on
`territory:manage`, so a `PHARMA_DATA_STEWARD` — who has no territory — was
locked out of the master they exist to curate.

## 8. Next tasks
- **Phase 19 — adverse-event safety handoff.** Specified in **CCR-007** and
  awaiting cross-workstream approval. Agent 4 must not build the destination; the
  proposal defines only what the pharma side hands over. Negative tests in
  `intelligence-redteam.test.ts` pin the current, deliberate absence so a covert
  clinical workflow cannot appear without failing a test.
- **Phase 3/6 — HCO locations, departments and HCO 360.** A department is still a
  text field on an affiliation; there is no HCO 360.
- **Phase 8/11 — medical-representative profile and manager hierarchy**, then
  field-visit modality and field-note quarantine (the latter is coupled to
  CCR-007: quarantine replaces today's reject-and-discard).
- **Phase 63 — intelligence lifecycle** (draft → review → published → expired →
  archived); signals are currently published on creation and never expire.
- `clinical_governed` stays fail-closed: CCR-004 is APPROVED as a contract but
  its implementation is **deferred and owned by Agent 1 + Agent 2**, not by this
  workstream.
- HCP QR identity for fast field identification (reuses the QR primitive).
- Regional/country roll-up signals above territory precision, and period-over-period
  trend signals derived from stored aggregates (no new source needed).
