# MEDCORE — Architecture

This document is the engineering counterpart to the product blueprint. It
records the repository audit, the gap analysis, the target architecture and
its engines, and the phased roadmap. It is deliberately grounded: it names what
exists in the market, what we build, and what must still be validated.

---

## 1. Repository audit (current state)

The repository was **greenfield** at the start of this work: a single
`README.md` and one "Initial commit", no framework, no schema, no code, no
tests. There was therefore no existing production code to preserve, no
technical debt to pay down, and no broken components to triage — the audit's
main finding is that section 51 of the blueprint ("if an existing project is
provided") does not apply. We build from zero, which lets us adopt the target
architecture directly instead of migrating toward it.

Environment available: Node.js 22, PostgreSQL 16, Python 3.11, Docker.

## 2. Gap analysis

Measured against the blueprint, everything is a gap; the useful output is
**priority and dependency order**, not a list of what's missing. The engines
that everything else depends on are Identity, Governance (RBAC + audit) and the
Event store. Nothing clinical, automated, or analytical can be built safely
before those exist, because each later feature must attach to an identity, be
authorized, and be auditable.

Consequently the first increment is not "a feature" but the **foundation plus
the thinnest real workflow that exercises it** — front-desk patient
identification and check-in. That slice forces us to build the foundation
correctly (authz, tenancy, audit, events, migrations, tests) against a concrete
use case rather than in the abstract.

## 3. Design principles (from the blueprint, made concrete)

1. **Reusable engines, not feature spaghetti.** Code is organized by engine
   (`modules/identity`, `modules/governance`, `modules/workflow`, …), and each
   HTTP route is a thin adapter over a service.
2. **Local-first.** The server, database, auth and core workflow run on a
   single on-premises box over the LAN. Internet is optional (WhatsApp, backup,
   data refresh, intelligence sync) and enters only through adapters.
3. **Authorization is never bypassed.** Every service call takes a `Principal`,
   asserts a permission, and scopes queries to the caller's clinic. Routes never
   hold authorization logic that a service lacks.
4. **Everything important is an event and is audited.** State changes emit
   structured events (automation/analytics) and, when sensitive, write an
   append-only audit record (governance/forensics). The two are distinct.
5. **No magic strings, no hard-coded country/provider logic.** Permissions,
   roles, event types and config are typed constants or validated config.
6. **AI is review-first.** No AI output becomes authoritative clinical data
   without human confirmation (enforced at the data-flow level when AI lands).
7. **Fail fast and closed.** Invalid config refuses to boot; unknown errors
   return a generic 500 and never leak internals; cross-tenant reads return
   "not found" rather than confirming existence.

## 4. Target architecture

```
                       Browser clients (LAN)
        Reception   ·   Nurse   ·   Doctor   ·   Admin   ·   Rep/Pharma
                               │  HTTPS/LAN
                     ┌─────────┴──────────┐
                     │   Fastify API       │  ← auth plugin, error envelope
                     ├─────────────────────┤
                     │   Engines (services)│
                     │  Identity · Workflow│
                     │  Event · Automation │
                     │  AI · Intelligence  │
                     │  Governance         │
                     ├─────────────────────┤
                     │   PostgreSQL (local)│  ← migrations, append-only audit/events
                     └─────────────────────┘
                     Optional outbound adapters (internet):
                     WhatsApp · Email/SMS · Drug/HCP data · Encrypted backup
```

### Engines

| Engine | Responsibility | Status |
| --- | --- | --- |
| **Identity** | Patients, users, (later) physicians/HCPs/HCOs/reps, orgs, clinics, devices | Users + patients built |
| **Workflow** | Appointment→check-in→intake→queue→encounter→…→closure state machines | Check-in + queue built |
| **Event** | Append-only structured events that drive automation & analytics | Built |
| **Automation** | event→condition→action, schedules, reminders (WhatsApp/tasks/recall) | Designed |
| **AI** | Transcription, extraction, summarization — always review-first | Designed |
| **Intelligence** | Authorized structured data → aggregated, de-identified signals | Designed |
| **Governance** | RBAC/ABAC, audit, consent, data policy, retention, provenance | RBAC + audit built |

### Module map (code)

```
config/env.ts             Validated, typed configuration (single source)
db/pool.ts                Pool + withTransaction (atomic state+audit+event)
db/migrate.ts             Forward-only, checksum-guarded SQL migration runner
db/migrations/*.sql       Schema
domain/errors.ts          Typed AppError hierarchy → HTTP status + stable code
domain/events.ts          Event catalog + transactional emitter
modules/identity/         users.repo, patients.repo, patients.service
modules/auth/             password (scrypt), tokens (opaque+hashed), auth.service
modules/governance/       permissions (catalog), rbac (Principal + asserts), audit
modules/qr/               qr.service (opaque token, no PHI, PNG render)
modules/workflow/         checkin.service (encounter + queue)
http/                     server (error envelope, health), routes, auth plugin
seed.ts                   RBAC sync + demo clinic
```

## 5. Sub-architectures (design for later phases)

These are specified now so the foundation does not have to be reworked to
accept them. None are implemented beyond what section 4 marks as built.

### 5.1 Local server / MEDCORE box
Single deployable unit (app + Postgres) targetable at a mini-PC / small server.
Migrations run on boot so a fresh clinic is self-provisioning. Roadmap adds:
backup engine (7 daily / 4 weekly / 3 monthly, verified restores), health
dashboard, controlled update flow (backup→validate→migrate→healthcheck→rollback
on failure), and an offline transaction queue with idempotent, conflict-aware
store-and-forward for the optional online adapters.

### 5.2 QR architecture (implemented)
QR payloads carry an **opaque, versioned token** (`MEDCORE1:<base64url>`) — never
PHI (§43). The server stores only the SHA-256 of the token; scanning resolves it
server-side under the `qr:resolve` permission and clinic scope. Tokens expire
and are revocable. Same mechanism extends to visit/staff/asset QR by `kind`.

### 5.3 AI architecture (designed)
A provider-abstract `AIProvider` interface (Local/OpenAI/Anthropic/…) so there
is no vendor lock-in. Every clinically consequential output is a **draft** with
cited source fields and requires human confirmation before it is written as
authoritative data; the AI never silently mutates a clinical record. AI calls
are logged (prompt context, model/version, output, reviewer, disposition).

### 5.4 WhatsApp / automation architecture (designed)
WhatsApp is an **automation channel, not the system of record**. The Automation
engine subscribes to events (e.g. `APPOINTMENT_CONFIRMED`, `NO_SHOW`,
`FOLLOW_UP_DUE`) and runs event→condition→action rules using approved templates,
consent/preference-aware. Providers are abstracted like AI providers.

### 5.5 Physician / HCP master (designed)
A provenance-aware canonical HCP identity (not internet-scraped truth):
canonical HCP id + local identifiers, specialty taxonomy, HCO affiliations and
hierarchy, verification state, source and `last_verified`, confidence for
enriched fields, identity-resolution/merge. Used across clinic, pharma, rep and
intelligence without uncontrolled copies.

### 5.6 Drug / medication master (designed)
Canonical medication concept → generic/brand/ingredient/strength/form/route/
manufacturer, with **jurisdiction, source, source version, regulatory
identifiers, status and `last_verified`** on every product. Import/provider
architecture (EDA/EDDB for Egypt, openFDA/DailyMed/RxNorm where licensing
permits) — never copying proprietary datasets without a license. Drug
*knowledge* (data layer) is kept separate from clinical *decision support*
(which needs far stronger validation and stays review-first).

### 5.7 Pharma / Rep OS + Intelligence firewall (designed)
Pharma and clinical data are **logically separated**. Pharma users get HCP
engagement workflow (territory, call plans, pre-visit brief, voice→call report,
approved content) and only aggregated, de-identified signals — never the
clinical database. The firewall pipeline is mandatory:

```
clinical data → classification → authorization → de-identification
             → aggregation → minimum-cohort threshold → policy check → signal
```

If a threshold is not met, the pipeline returns nothing. Sponsored-clinic
deployments (§45) never grant the sponsor clinical access; the clinic keeps its
data boundary and the doctor keeps the product even if the sponsor changes.

## 6. Roadmap

The build order matches the blueprint's phases; each phase is only "done" when
it meets the acceptance criteria in §7.

- **V1 — Clinic Core** *(in progress)*: local server, users, RBAC, patient, QR,
  reception/queue, intake, vitals, doctor workspace, encounter, treatment,
  prescription, timeline, reports, backup, audit.
  *Delivered so far:* server, users+RBAC, auth, patient identity, QR, check-in +
  queue, audit + events, migrations, tests.
  *Next:* intake + vitals, doctor workspace + "Save & Next", encounter clinical
  fields, timeline, PDF reports, backup/restore.
- **V1.5**: WhatsApp + automation engine, CRM/follow-up, no-show + revenue
  recovery, inventory, AI summaries, voice-to-note.
- **V2**: Physician/HCP master, Medical Rep OS, HCP 360, call reports, pharma
  content hub, territory, rep AI.
- **V3**: Aggregated intelligence, market/product signals, pharma dashboards,
  executive AI analyst.
- **V4**: Multi-country/branch, FHIR adapters, labs/pharmacy/hospital
  integrations, patient portal.

## 7. Acceptance criteria (definition of done)

A feature is complete only when UI + backend + schema + validation +
authorization + error handling + audit (where sensitive) + tests + empty/
loading/failure states + migration + docs all exist and it works on the LAN.
The current slice meets the backend/data/validation/authz/error/audit/tests/
migration/docs bar; UI is a V1 follow-up item (this increment is API-first).

## 8. Testing strategy

- **Unit:** password hashing, token opacity, RBAC decisions (no DB).
- **Integration (against real Postgres):** auth, patient registration + dedup,
  search/get, QR issue/resolve, check-in + queue.
- **Security/governance:** the dangerous cases — unauthenticated access,
  pharma-user patient access, least-privilege (doctor cannot register),
  cross-clinic isolation, duplicate patient, duplicate active encounter,
  append-only audit/event tamper resistance.
- Test data is reset per test; the schema is migrated fresh per run so
  migrations are exercised continuously.

## 9. Deployment & recovery strategy (target)

Single box, Postgres local, migrations on boot. Roadmap: automatic verified
backups with rotation and restore drills, a controlled update flow with
automatic rollback on failed migration, and a health dashboard so an
administrator can see system health without calling support. Secrets
(`AUTH_PEPPER`, provider keys) live in a secret manager, never in the database;
production refuses to boot with placeholder secrets.
