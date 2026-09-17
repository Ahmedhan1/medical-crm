# MEDCORE BOX — Platform Foundation (Phase 0)

Scope: the **platform foundation** for a future one-click customer installation of
MEDCORE as a local-first "BOX". This records the target architecture and the
Phase-0 primitives that exist today. It does **not** build the installer, the
cloud service, or any billing — those are Final-phase (see
`PRODUCTIZATION-CONTRACT.md`).

## Target architecture

```
MEDCORE BOX (clinic hardware / on-prem server)
├── Frontend              (Final phase — not built yet)
├── Backend               server/  (Fastify + pg, this repo)
├── PostgreSQL            local instance; migrations 0001..0901 → clean schema
├── Configuration         config/env.ts — zod-validated, fail-fast
├── Backup                modules/backup + backup-cli — pg_dump + AES-256-GCM
├── Health/Diagnostics    /health, /health/detailed, /metrics
├── Update foundation     entitlement.updateChannel ('stable'|'beta') — contract only
└── Membership Client     modules/platform/entitlement — verify/grace/gate contract
```

## Principles (verified today)

- **Local-first.** All clinical workflows run against the local Postgres on the
  box. No request path depends on an external service.
- **Offline-capable for core clinical work.** Membership status never gates a
  `core:*` feature (see the feature-gate rule below); losing the Internet or the
  membership degrades commercial features only.
- **Deterministic.** Migrations apply from empty to a fixed schema; PDF rendering
  embeds fonts (no host-font dependence). Same inputs → same schema and documents.
- **Recoverable.** `backup → verify → restore` is tested end-to-end; a box can be
  rebuilt from a backup artifact. RPO/RTO assumptions live in
  `PRODUCTION-READINESS.md`.
- **Easy to operate.** One config surface (env), one migrate command, one backup
  CLI, one health endpoint an operator can read without support.

## Phase-0 primitives that exist now

| Primitive | Where | State |
| --- | --- | --- |
| Config validation (fail-fast) | `config/env.ts` | Done |
| Migrations empty→schema | `db/migrate.ts`, `db/reset-schema.ts` | Done |
| Backup / verify / restore | `modules/backup`, `backup-cli.ts` | Done |
| Health / readiness / metrics | `http/server.ts` | Done |
| Security headers | `http/server.ts` `SECURITY_HEADERS` | Done (Phase 0) |
| Request correlation id | `http/server.ts` | Done |
| Membership/entitlement contract | `modules/platform/entitlement` | Contract + pure logic (Phase 0) |

## Membership Client foundation (`modules/platform/entitlement`)

Pure boundary logic only — no cloud calls, no persistence wiring, no coupling to
clinical/AI/pharma behavior:

- **Installation identity** (`newInstallationIdentity`) — a stable per-box UUID +
  timestamp, no PHI, no secret.
- **Signed-entitlement verification** (`verifyEntitlementSignature`) — Ed25519 over
  a canonical byte form, using `node:crypto` (no new dependency). **Fail-closed:**
  malformed input, wrong key, or a tampered payload returns `valid: false` and
  never throws.
- **Offline grace** (`evaluateStatus`, `resolveEntitlement`) — `active` before
  expiry, `grace` within the configured grace window while offline, `expired`
  after, `unverified` with no/invalid signature. Fail-closed to `unverified`.
- **Anti-copy binding** (`bindsTo`) — a valid signature is honoured only for the
  matching `installationId` + `tenantId`, so a membership cannot be copied between
  clinics.
- **Feature gate** (`createFeatureGate`) — **the one hard safety rule:** `core:*`
  (clinical-core) features are *always* enabled regardless of membership status or
  connectivity. Commercial features are enabled only while `active`/`grace` and
  explicitly granted. `expired`/`unverified` disable commercial features only.

Nothing in the clinical/AI/pharma domains consults the gate yet. Wiring a specific
domain feature to a commercial key is a Final-phase change that must go through a
**CCR** so it is reviewed against the "core is never gated" rule (see CCR-014).

## Explicitly NOT built in Phase 0

- No frontend, no installer, no cloud control plane, no billing.
- No entitlement persistence (the `EntitlementStore` interface is the contract; a
  file/DB store is Final-phase). No Phase-0 DB migration was required.
- No license-key file — membership replaces license keys by design.
