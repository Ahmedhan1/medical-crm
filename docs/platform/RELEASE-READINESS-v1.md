# MEDCORE v1 — Release Readiness Report

## Final integration gate (2026-09-18)
All three completed domain deliverables are on `integration/medcore-v1`:
- **Agent 2** (`0259f51` / `agent2/clinical-final-hardening`): the four P1 clinical
  fixes (0114 append-only vitals/observations, encounter-cancel→appointment sync,
  Patient 360 `recentVitals`, merged-patient treatment-episode guard) are all
  present and verified; the final audit commit added no new code.
- **Agent 3** (`b5e49e9`, cherry-picked as `28c6bec`): GOWA WhatsApp provider
  (config-driven, no-op when unconfigured), `0206_whatsapp_connection` (clinic-
  scoped, no credentials/QR/message bodies), WhatsApp status/pair/reconnect/
  disconnect routes, consent-gated delivery, and the AI / Automation / Messaging
  frontend domains (EN+AR). No new runtime dependency.
- **Agent 4** (`be1c8f5`): pharma/HCP/intelligence 0307–0315 already integrated;
  the new commits are docs-only.

**Gate:** backend 1344 tests / 92 files (0 failed / 0 skipped); web 46 unit / 14
files; web E2E 7 passed / 1 correctly skipped (auth needs a live backend);
typecheck + build clean (server + web); 41 migrations apply empty → 108 tables
(order 0001 / 0100–0114 / 0200–0206 / 0300–0315 / 0900–0901); backup → verify →
restore round-trips 108 tables (incl. `whatsapp_connection`). Security/PHI/cross-
domain audits clean; cohort floor = 5, CCR-004 fail-closed, Action Guard, Pharma
Firewall, tenant/territory isolation intact. **GOWA is NOT live-validated** — real
pairing is a deployment validation step, not a code gate.



Owner: Agent 1 (Chief Integration & Release). Every item marked **Complete** is
verified by code and tests in this repository; nothing is marked Complete on
intent alone.

## Release identity
- Branch: `integration/medcore-v1`
- Release commit: see the final SHA in the closure report / `git log` (this doc is
  committed in the same release commit).
- Prior trusted baseline consolidated: `1efbe6f` → this release adds the verified
  Agent 2/3/4 closure work below.

## Architecture status
- Backend: Node 22 + TypeScript (strict) + Fastify 5 + PostgreSQL 16 (`server/`).
  Local-first, no ORM, 5 runtime deps (fastify, pg, qrcode, zod, playwright-core).
- Frontend: React + Vite + TypeScript SPA (`web/`) — app shell, design system,
  API/auth/RBAC/i18n(EN/AR + structural RTL), nav/route registry for domains.
  Clinical domain (Agent 2) wired via the registry (CCR-015).
- Migrations: 40 files, ranges reserved per workstream (0001 platform, 0100s
  clinical, 0200s AI, 0300s pharma, 0900s platform), apply empty → 107 tables.

## Implemented capabilities (verified)
- **Platform:** scrypt+pepper auth, opaque hashed sessions, per-account lockout +
  per-IP login rate limit, RBAC catalog, tenant `clinic_id` isolation, central
  pg-error redaction, append-only `audit_log`/`event`, `/health`,
  `/health/detailed`, `/metrics`, request-id correlation, security headers,
  backup/verify/restore + CLI, membership/entitlement contract (fail-closed,
  clinical-core never gated), CI (backend + web jobs).
- **Clinical:** patient lifecycle + merge, appointments/scheduling, encounters,
  observations/vitals (append-only), allergy safety, prescriptions, treatment
  episodes, procedures, care plans, referrals + SLA, follow-up detection,
  timeline, Patient 360, document references, internal FHIR mappers. Clinical
  frontend: patients, Patient 360, queue, register/check-in (RBAC-gated).
- **AI/Automation:** provider abstraction, E3 AI Gateway (classify → tenant
  policy → provider, PHI-local fail-closed), E4 Action Guard (identity → tool →
  risk → classification → policy → confirmation → execute), human-only confirm
  permission, structured-output validation, eval harness, observability,
  read-only tools, receptionist (clinical-first escalation — hardened this
  release), automation engine + scheduler + retry/dead-letter/dedupe/idempotency,
  consent/opt-out, quiet hours/frequency caps, messaging/WhatsApp policy.
- **Pharma:** HCP + HCO masters, locations/departments + site governance, HCO 360,
  territories, field force/visits/call reports, medical affairs request lifecycle,
  drug master + product verification, content governance, intelligence signal
  lifecycle + decision trail, governed reporting/export incl. HCO directory report
  (this release). Pharma Firewall, cohort floor = 5, banding/suppression/rounding,
  query budgets, anti-differencing, provenance/verification.

## Security status — PASS
Static + behavioral checks clean: no PHI in logs/events/QR (query strings and
pg error detail stripped; event payloads shape-only), no cross-tenant access, no
cross-role escalation, no AI bypass of Gateway/Action Guard, **zero Pharma access
to clinical or patient-level data** (firewall test suite + static scan), no export
or territory bypass (per-report permission + `PHARMA_EXPORT` + territory scope),
append-only audit intact, idempotent delivery/scheduling. Security headers on every
response. One flaky quality-gate assertion (a pharma free-text guard that
coincidentally matched internal UUIDs) was made deterministic without weakening its
intent.

## Clinical safety status — PASS
DOCTOR clinical authority preserved; no autonomous diagnosis/prescribing/clinical
mutation; immutable completed clinical facts; prescribing-safety checks; merged-
patient guards. Receptionist under-escalation bug fixed (clinical stems now match
as word prefixes so "diagnose/prescription/…" escalate to clinical staff;
over-escalation is the fail-safe direction), with adversarial tests.

## AI governance status — PASS
AI Gateway is the sole governed provider path; Action Guard enforces a single
execution boundary with human confirmation; AI holds no human RBAC permission
(validated invariant); local/cloud classification policy enforced; automation
simulation cannot mutate or send; structured outputs validated PHI-safe.

## Pharma governance status — PASS
Pharma Firewall (no clinical reads/writes), cohort minimum = 5, banding/
suppression/rounding, query budgets, narrowing/anti-differencing protection,
territory authorization, export authorization + read permission, HCP/HCO/product
provenance + verification with merged-record protection. CCR-004/007/010 boundaries
preserved fail-closed.

## Migration / schema status — PASS
40 migrations apply from empty in order, no duplicate numbers, no destructive
rewrite of applied migrations, → 107 tables. Every tenant table carries
`clinic_id`; append-only triggers on audit/event/decision-trail/export tables;
platform indexes present. Existing-data upgrade path tested.

## Backup / restore status — PASS
`backup → verify (checksum + archive) → restore` into a fresh DB round-trips all
107 tables. pg_dump custom format + optional AES-256-GCM; creds via PG* env; no
HTTP restore; CLI-only with live-restore refusal.

## Known limitations (SAFE V1 — documented)
- In-memory auth throttle is single-box (multi-instance needs a shared store).
- Document *bytes* are metadata-only; blob backup deferred (CCR-008).
- Arabic/RTL PDF passes automated ink/round-trip/no-`?` checks; **human visual
  glyph sign-off is NOT yet performed** — not claimed.
- Patient search sends the search term as a query param (needed to search); it is
  stripped from server logs (CCR-002) but appears in local browser history on the
  BOX. A GET→POST hardening is a small future item (Agent 2 backend contract).
- Frontend covers the platform shell + clinical domain; AI and Pharma domain UX
  are Agents 3/4 (backend complete; UX pending).

## Deferred post-v1 work
- Cloud Control Plane, installer/Customer Package, billing, entitlement
  persistence + feature-gate wiring (CCR-014).
- Recurring expiry-sweep scheduling via the automation engine (CCR-011).
- Pharma-event automation binding registry (CCR-013); AI draft → call_report
  promotion contract (CCR-012).
- Global search, tenant branding wiring, accounting/finance domain.
- Load/performance testing at scale; automated DR drill.

## CCR status
001 approved(design)/deferred resolver · 002 done · 003 approved/auto-promotion
deferred · 004 approved/**fail-closed 501** · 005 done · 006 proposed · 007
proposed (drug↔allergen, unresolved boundary preserved) · 008 proposed (doc bytes)
· 009 approved · 010 proposed (adverse-event, fail-closed) · 011 proposed (expiry
scheduling) · 012 proposed (DraftKind promotion) · 013 proposed (pharma-event
automation binding) · 014 proposed (feature-gating) · 015 **approved/done**
(clinical frontend wiring). None silently closed; all cross-domain contracts
remain fail-closed.

## Release decision
See the final closure report for the exact SHA and the gate results (full suite
0 failures / 0 skipped, typecheck, build, fresh migration, backup/restore, and the
security/governance audits). Blockers: 0.
