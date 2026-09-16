# Workstream: Pharma / HCP / Drug / Intelligence (Agent 4)

## Mission
Own the pharma field product and the governed intelligence layer: Physician/HCP
master, drug/medication master, territory + medical-rep workflow, approved
content, and privacy-preserving aggregated signals (blueprint §6–9, §18–27).

## Branch
`agent-4/pharma-intelligence` (branch from the foundation branch).

## Files you own
- `modules/pharma/**`, `modules/hcp/**`, `modules/drug/**`, `modules/intelligence/**` (all new)
- `modules/governance/permissions.pharma.ts`
- `domain/events.pharma.ts`
- `http/features/pharma.feature.ts` + new pharma routes
- Migrations **0300–0399**
- Pharma tests, this file, `docs/agent-state/agent-4.md`

## Absolute governance boundaries (enforced + tested)
- **No patient-level identifiable data reaches pharma — ever (§45).** Pharma
  roles get zero clinical permissions; pharma code must not read patient/
  encounter/clinical tables. Add a security test proving a pharma principal
  cannot reach any patient row.
- **Intelligence firewall (§24–25):** the only path from clinical data to pharma
  is: classification → authorization → de-identification → aggregation →
  minimum-cohort threshold → policy validation → signal. Below threshold →
  return nothing. Pharma never queries the clinical DB directly; the governed
  read path is a CONTRACT with Agent 1 (file a CONTRACT_CHANGE_REQUEST for P005).
- **Provenance on every reference field (§8, §23):** `source`, `source_version`,
  `jurisdiction`, `last_verified`, and confidence where enriched. Do not copy
  proprietary datasets without a license.
- **AI pharma analyst never fabricates (§27):** answers cite source, period,
  scope, confidence.

## How to add things
Same pattern as other workstreams: your own `permissions.pharma.ts` /
`events.pharma.ts` / `pharma.feature.ts` / migrations 0300–0399. Grant pharma
permissions only to `PHARMA_REP` (and future pharma roles), never to clinical
roles. Never edit `server.ts` or the barrels.

## Cross-agent dependencies
- **P005 (intelligence)** is BLOCKED until Agent 1 approves a governed,
  aggregate-only read contract over the event/clinical store. Do not read
  clinical tables to unblock yourself.
- HCP QR (fast field identification) reuses Agent 1's QR primitive with a pharma
  permission — no PHI, same opaque-token contract.

## Next tasks
P001 HCP master → P002 drug master → P003 territory+rep → P004 content hub;
P005 intelligence firewall is BLOCKED on the Agent 1 read contract. See `TASKS.md`.
