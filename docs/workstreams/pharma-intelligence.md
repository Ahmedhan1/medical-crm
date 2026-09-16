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
- Migrations **0300–0399** (0300–0304 used)
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
shortcut the architecture forbids. It is blocked on **CCR-001**, which specifies
the aggregate-only read contract for Agent 1 to implement. The refusal is the
feature, and it is tested.

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
- **CCR-001** (governed aggregate-only clinical read) — PROPOSED. Until Agent 1
  approves and implements it, `clinical_governed` refuses every request. Do not
  read clinical tables to unblock this.
- **CCR-002** (pharma role keys) — PROPOSED. Stewardship/approval/publication
  permissions currently resolve to `ADMIN` only.
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
| `test/integration/pharma-firewall.test.ts` | 63 | the four firewall layers, the blocked clinical source, end-to-end signals, threshold immutability |

## 7. Next tasks
- Swap the `clinical_governed` stub for Agent 1's provider once CCR-001 is approved.
- Grant pharma permissions to the new role keys once CCR-002 is approved.
- HCP QR identity for fast field identification (reuses the QR primitive).
- Regional/country roll-up signals above territory precision, and period-over-period
  trend signals derived from stored aggregates (no new source needed).
