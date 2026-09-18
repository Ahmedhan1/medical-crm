# MEDCORE — Multi-Agent Working Agreement

This repository is built in parallel by four Claude agents. This file is the
**binding contract** for how they work together without conflict. Every agent
MUST read this file and its own workstream file before writing any code.

> Orchestrator: **Agent 1 (Lead Architect)**. Integration/QA is performed by
> Agent 1 after Agents 2–4 complete their tasks.

---

## 1. Mandatory rules (non-negotiable)

1. **GitHub is the source of truth.** Pull before you start; push when a task
   is complete and green.
2. **Each agent works only on its own branch.** Never commit to, rebase, or
   force-push another agent's branch.
3. **Never edit files owned by another workstream** (see §4) unless there is a
   documented reason approved via `CONTRACT_CHANGE_REQUEST.md`.
4. **Any change to an API or database contract that affects another agent must
   be filed in `CONTRACT_CHANGE_REQUEST.md`** and approved by Agent 1 before it
   is merged.
5. **Never delete existing functionality** without a clear, documented reason.
6. **Never disable, skip, or weaken tests to hide failures.** A red test is a
   bug to fix, not to silence.
7. **Every feature ships with appropriate tests** (unit + integration; security
   tests for anything touching authz or data boundaries).
8. **Priority order when trade-offs collide:**
   `Security > Reliability > Correctness > Simplicity > Speed`.
9. **Never put PHI in QR codes or logs.** QR payloads are opaque tokens; audit
   `metadata` and application logs must never contain patient-identifiable data.
10. **Pharma never receives patient-level identifiable data.** Only HCP
    engagement data and aggregated, de-identified, threshold-gated signals.
11. **AI never diagnoses or prescribes autonomously.** All clinically
    consequential AI output is a draft requiring human confirmation before it
    becomes authoritative data; AI never silently mutates a clinical record.
12. **Authorization is never bypassed for convenience.** Every service call
    takes a `Principal`, asserts a permission, and scopes queries by `clinic_id`.
13. **Every agent reads `AGENTS.md` + its workstream file before starting.**

---

## 2. Branches

| Agent | Role | Branch |
| --- | --- | --- |
| Agent 1 | Foundation / Orchestration / Contracts / QA | `claude/serene-mendel-u5rxdv` (current) |
| Agent 2 | Clinical Core | `agent-2/clinical-core` |
| Agent 3 | AI / Automation / WhatsApp | `agent-3/ai-automation` |
| Agent 4 | Pharma / HCP / Drug / Intelligence | `agent-4/pharma-intelligence` |

Each agent branches **from the latest foundation branch** (Agent 1's), which
carries this agreement and the shared contracts. Confirm the exact branch name
with the operator if the harness assigns a different one; the ownership rules
still apply.

Integration happens by merging agent branches into the foundation branch via PR,
reviewed by Agent 1. Resolve conflicts in your own files; a conflict in a shared
contract file means the contract process (§5) was skipped — stop and escalate.

---

## 3. Golden rules for parallel-safe code

The foundation is structured so agents almost never touch the same file:

- **Permissions:** add yours in `permissions.<workstream>.ts`. The barrel
  `permissions.ts` merges them (Agent 1 owned). ADMIN auto-gets everything.
- **Events:** add yours in `events.<workstream>.ts`. The barrel `events.ts`
  merges them.
- **HTTP routes:** register inside your `http/features/<workstream>.feature.ts`.
  `server.ts` registers the four aggregators and never changes.
- **Migrations:** use your reserved number range (§6). Never renumber another
  agent's migration; never edit an already-applied migration (the runner
  rejects a changed checksum — add a new migration instead).
- **Test reset:** `resetDb()` discovers tables dynamically — no shared list to
  edit when you add a table.

If you find yourself needing to edit a shared/contract file (§4), that is a
signal to file a contract change, not to just edit it.

---

## 4. File & module ownership

Paths are under `server/src/` unless noted. **Shared contract files** may be
changed only by Agent 1 via the contract process (§5).

### Agent 1 — Foundation (also owns all shared contracts)
- `config/**`, `db/pool.ts`, `db/migrate.ts`, `db/migrations/0001_*` (range 0001–0099)
- `domain/errors.ts`, `domain/events.ts` (barrel)
- `modules/auth/**`, `modules/identity/users.repo.ts`
- `modules/governance/roles.ts`, `permissions.ts` (barrel), `rbac.ts`, `audit.ts`
- `modules/qr/**` (QR primitive — shared library; consumers own their routes/perms)
- `http/server.ts`, `http/plugins/**`, `http/routes/auth.routes.ts`,
  `http/features/foundation.feature.ts`
- `index.ts`, `seed.ts`, `test/helpers/**`
- Root: `package.json`, `tsconfig*.json`, `vitest.config.ts`, all orchestration docs, `docs/`

### Agent 2 — Clinical Core
- `modules/identity/patients.repo.ts`, `patients.service.ts`
- `modules/clinical/**` (new), `modules/workflow/**`
- `modules/governance/permissions.clinical.ts`, `domain/events.clinical.ts`
- `http/routes/patients.routes.ts`, `http/routes/workflow.routes.ts` + new clinical routes
- `http/features/clinical.feature.ts`
- Migrations 0100–0199, clinical tests, `docs/workstreams/clinical-core.md`, `docs/agent-state/agent-2.md`

### Agent 3 — AI / Automation / WhatsApp
- `modules/automation/**`, `modules/ai/**`, `modules/messaging/**` (all new)
- `modules/governance/permissions.automation.ts`, `domain/events.automation.ts`
- `http/features/automation.feature.ts` + new automation routes
- Migrations 0200–0299, automation tests, `docs/workstreams/ai-automation.md`, `docs/agent-state/agent-3.md`

### Agent 4 — Pharma / HCP / Drug / Intelligence
- `modules/pharma/**`, `modules/hcp/**`, `modules/drug/**`, `modules/intelligence/**` (all new)
- `modules/governance/permissions.pharma.ts`, `domain/events.pharma.ts`
- `http/features/pharma.feature.ts` + new pharma routes
- Migrations 0300–0399, pharma tests, `docs/workstreams/pharma-intelligence.md`, `docs/agent-state/agent-4.md`

### Shared contract files (Agent 1 only, via §5)
`roles.ts`, `permissions.ts`, `events.ts`, `errors.ts`, `rbac.ts`, `audit.ts`,
`pool.ts`, `config/env.ts`, `http/server.ts`, `http/plugins/auth.ts`, the QR
payload contract, the API response envelope, and the DB conventions
(`clinic_id` scoping, append-only audit/event, `timestamptz`).

---

## 5. Contract-change process

A "contract change" is anything that alters shared behavior another agent relies
on: a shared-file edit, a new `RoleKey`, a change to an existing endpoint's
request/response, a change to a shared table, or a new cross-workstream event
contract.

1. Add an entry to `CONTRACT_CHANGE_REQUEST.md` using the template there.
2. Set status `PROPOSED` and describe impact + affected agents.
3. Agent 1 reviews; on approval marks it `APPROVED` and implements (or authorizes
   the requester to implement) the shared-file part.
4. Only then do dependent workstreams code against the new contract.

Adding a *new* permission and granting it to an *existing* role in your own
`permissions.<workstream>.ts` is **not** a contract change — do it directly.
Adding a new `RoleKey` **is** a contract change.

---

## 6. Migration number ranges

| Range | Owner |
| --- | --- |
| `0001`–`0099` | Agent 1 (foundation) |
| `0100`–`0199` | Agent 2 (clinical) |
| `0200`–`0299` | Agent 3 (automation) |
| `0300`–`0399` | Agent 4 (pharma) |

Files are `NNNN_description.sql`. Forward-only, applied in a transaction,
checksum-guarded. Every new table carries `clinic_id` (tenant scope) and
`timestamptz` timestamps; anything sensitive is audited; audit/event stay
append-only.

---

## 7. Definition of Done (per task, blueprint §52)

A task is complete only when all of these exist and pass:
backend + schema/migration + validation + authorization + error handling +
audit (where sensitive) + tests (incl. the dangerous cases) + docs, and:

```
cd server
npm run typecheck   # clean
npm test            # all green (needs a reachable Postgres)
npm run build       # clean
```

Then update your `docs/agent-state/agent-N.md`, commit, and push your branch.
Do not report a task done without actually running the three commands above.

---

## 8. Local environment

Postgres must be reachable at `TEST_DATABASE_URL` (default
`postgres://postgres:postgres@localhost:5432/medcore_test`). On a fresh
container: start the cluster, ensure `medcore` and `medcore_test` exist, then
`npm install && npm run seed`. See `README.md` for details.
