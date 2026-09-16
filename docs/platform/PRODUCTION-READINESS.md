# MEDCORE — Production Readiness Matrix

Living matrix (directive §40). A component is **Ready** only with tested
evidence. "Partial" = implemented + tested but incomplete for full production.
"Planned" = designed, not built. Nothing is marked Ready without evidence.

| Area | Status | Evidence | Risk | Owner |
| --- | --- | --- | --- | --- |
| Database schema | Ready | 12→14 migrations apply from empty; 70 tables; append-only triggers, CHECK constraints | Low | A1 |
| Migrations (integrity) | Ready | checksum-guarded runner; governance test enforces naming/ranges | Low | A1 |
| **Backup** | Ready | `createBackup` (pg_dump custom + checksum + optional AES-256-GCM); round-trip + CLI tested | Low | A1 |
| **Restore** | Ready | tested restore into a fresh DB — migrations, tables, a clinical row, RBAC, triggers, indexes all survive; CLI restore + live-restore refusal | Low | A1 |
| Backup security | Ready | creds via PG* env (never argv); no download/restore HTTP endpoint; artifacts gitignored; PHI-free ledger; audited | Low | A1 |
| Authentication | Partial | scrypt+pepper hashing, opaque hashed sessions, logout revocation, enumeration-resistant login | No rate-limiting / lockout yet (Priority 3) | A1 |
| Authorization (RBAC) | Ready | per-permission catalog; ADMIN=all; pharma SoD roles; negative-authz tests | Low | A1 |
| Tenant isolation | Ready | every domain table `clinic_id`; governance test; cross-clinic 404 tests | Low | A1 |
| PHI logging | Partial | global query-string redaction + header redaction + serializer test | pg error `detail` leakage not yet centrally redacted (Priority 3/§10) | A1 |
| PDF / Arabic | **Not Ready** | base-14/WinAnsi renders Arabic as `????` | HIGH for Egypt patient docs (Priority 2) | A1 |
| Observability | Partial | `/health` (liveness) + `/health/detailed` (DB latency, migration count, uptime) | metrics/provider health pending (§16) | A1 |
| Error contract | Partial | consistent `{error:{code,message,details}}`; internals never leaked | no `request_id` yet (§11) | A1 |
| Configuration | Ready | zod-validated fail-fast config incl. backup; prod refuses placeholder pepper | Low | A1 |
| Frontend | Planned | none exists | n/a until Priority 5 | A1 |
| Design system | Planned | none (no client yet) | n/a until Priority 6 | A1 |
| FHIR | Planned | naming-aligned only | Priority 7 | A1 |
| CI | Planned | governance/security gates run locally only | drift risk until wired (Priority 9) | A1 |
| Performance | Partial | high-value indexes added; no load testing | Priority 10 | A1 |
| Deployment / BOX | Planned | single-host run works; no packaging | Priority 11 | A1 |
| Upgrade | Partial | forward-only migrate-on-boot; backup-before-upgrade now possible | rollback flow not automated (Priority 12) | A1 |
| Disaster recovery | Partial | verified restore exists; full DR drill not scripted | Priority 12 | A1 |

## RPO / RTO (operational targets — configurable, not guarantees)

These are **targets to be measured per deployment**, not guarantees. MEDCORE
provides the mechanism (scheduled backups + verified restore); the clinic sets
and validates the numbers on its own hardware.

- **RPO (Recovery Point Objective):** bounded by backup frequency. Default
  guidance: at least daily scheduled backups → RPO ≤ 24h; a clinic wanting a
  tighter RPO increases frequency (e.g. hourly). The retention policy
  (`BACKUP_RETAIN_DAILY/WEEKLY/MONTHLY`, default 7/4/3) governs history depth.
- **RTO (Recovery Time Objective):** dominated by `pg_restore` time for the DB
  size on the target hardware. On the test dataset a full restore completes in
  ~1–2s; a real clinic must measure against its own data volume and record the
  number here. Restore is a single operator command (`npm run backup -- restore
  <id> --target <url>`).

## Release gates (directive §41) — current status

| Gate | Status |
| --- | --- |
| clean migration / build / full tests | PASS (see phase report) |
| tenant isolation / RBAC / PHI-leak tests | PASS |
| backup test / restore test | PASS (this phase) |
| Arabic PDF test | **FAIL** (Priority 2, next) |
| auth security test (rate-limit/lockout) | not yet (Priority 3) |
| prod config validation / health-readiness / error redaction | PARTIAL |
| deployment / upgrade / rollback tests | not yet (Priority 11/12) |
