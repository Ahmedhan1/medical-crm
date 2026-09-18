# MEDCORE CI — Required Checks

CI is defined in `.github/workflows/ci.yml` (job `verify`), run on every push and
PR inside the Playwright container (Chromium present for the PDF regression) with a
Postgres 16 service. Every step below must pass before a branch is mergeable; wire
them as **required status checks** in the repository's branch-protection settings.

| # | Step | What it gates |
| --- | --- | --- |
| 1 | `npm ci` | reproducible install from the lockfile |
| 2 | `npm run typecheck` | `tsc` strict typecheck (no `any`, `noUncheckedIndexedAccess`) |
| 3 | `npm run build` | production build compiles |
| 4 | Migrations from EMPTY | `reset-schema.ts` (pg, no `psql`) → `migrate.ts` applies 0001..0901 cleanly |
| 5 | `npm test` (full suite) | everything below, in one run |
| 6 | `npm audit --omit=dev` | informational only (dependency **allowlist** is enforced by `governance.test.ts`, not by upstream advisories) |

## What the full suite (step 5) enforces

These are ordinary tests in the suite, so they gate mechanically — a regression
fails CI, not review:

- **Governance / architecture** (`governance.test.ts`) — tenant scoping, dependency
  allowlist, migration ranges + uniqueness, append-only invariants, platform
  indexes.
- **Security / isolation** — PHI-in-logs (`phi-logging.test.ts`), request-id and
  **security headers** (`request-id.test.ts`, `security-headers.test.ts`), RBAC and
  cross-clinic isolation, auth lockout/rate-limit.
- **Boundaries** — Pharma Firewall (`pharma-firewall.test.ts`),
  intelligence red-team, AI Action Guard / gateway, cohort privacy.
- **Recovery** — `backup.test.ts` (backup → fresh DB → restore).
- **PDF regression** — `pdf-arabic.test.ts` (real Chromium in the CI image).
- **Membership foundation** — `entitlement.test.ts` (signature fail-closed, offline
  grace, feature gate keeps clinical core enabled).

## Acceptance bar

- **Zero failures and zero skipped tests.** A skipped test hides a gap; the gate
  treats skips as failures by policy.
- Typecheck and build clean.
- Migrations apply from an empty database in one pass.

## Not yet automated (documented limitations)

- Arabic/RTL PDF **visual** glyph sign-off is a human check — automation verifies
  ink/round-trip/no-`?`, not shaping. Not claimed as passed until a human signs off.
- Load/performance testing and an automated DR drill are not in CI yet.
