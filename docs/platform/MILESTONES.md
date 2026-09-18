# MEDCORE — Integration Milestones

The durable milestone marker is the **commit SHA** on `integration/medcore-v1`
(the source of truth). A git tag is also created locally, but tag pushes are
blocked by this environment's git proxy, so the commit SHA below is authoritative.

| Milestone | Commit | Local tag | Summary |
| --- | --- | --- | --- |
| **I-4 consolidated baseline** | `7672e03` | `baseline-i4` | All 4 workstreams; 25 migrations → 91 tables; 698 tests / 53 files green; integrated backup→restore verified; security audits clean. |
| I-3A integration gate | `3f7b7a2` | — | Agent 2 CP-1..CP-9 + Patient 360; Agent 3 E2/E3; Agent 4 P28/P29. |
| Platform Phase 3 (Arabic PDF) | `5ac3504` | — | Optional Chromium+Amiri(OFL) RTL renderer. |
| Platform Phase 2 (Backup/Restore) | `97f1680` | — | pg_dump + AES-256-GCM + tested restore. |

## I-4 baseline (current source of truth)
- Branch: `integration/medcore-v1` @ `7672e03` (pushed, local == remote).
- Migrations: 0001 / 0100–0110 / 0200–0203 / 0300–0306 / 0900–0901 (25) → 91 tables.
- Gate: typecheck + build clean; full suite 698/53 green; fresh-DB migrate clean;
  integrated backup→restore verified.
- Governance: pharma↔clinical firewall, AI review-first + E4 action guard,
  CCR-004 and CCR-010 fail-closed / not implemented.
