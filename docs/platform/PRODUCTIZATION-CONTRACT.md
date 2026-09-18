# MEDCORE Productization Contract (Phase 0)

Clean internal boundaries for the Final phase (Cloud Control Plane, Customer
Package, Membership Client). **Contracts only** — Phase 0 builds no cloud service
and no installer. Membership **replaces** traditional license keys; there is no
license-key file anywhere in the design.

## Cloud Control Plane (Final phase — not built now)

The plane is the system of record for commerce. Entities (contract shape):

| Entity | Purpose |
| --- | --- |
| customer account | who purchased |
| clinic / tenant | maps to a MEDCORE `clinic_id` (tenant) |
| membership | the active commercial relationship (replaces a license) |
| plan | tier of membership (`clinic-basic`, `clinic-pro`, …) |
| entitlement | signed grant: plan + feature keys, bound to an installation+tenant |
| installation | one deployed BOX (`installationId`) |
| device | optional finer identity under an installation |
| subscription status | active / past-due / cancelled |
| update channel | `stable` / `beta` |

The plane's only job toward a BOX is to **issue a signed entitlement** (Ed25519)
and to answer periodic re-verification. It never receives clinical data.

## BOX side (Phase 0 contract, `modules/platform/entitlement`)

| Concern | Contract | Phase-0 status |
| --- | --- | --- |
| installation identity | `InstallationIdentity` + `newInstallationIdentity()` | implemented (pure) |
| tenant binding | `Entitlement.tenantId` + `bindsTo()` | implemented (pure) |
| entitlement cache | `EntitlementStore` interface | interface only |
| signed verification | `verifyEntitlementSignature()` (Ed25519, fail-closed) | implemented (pure) |
| online verification | plane call refreshes the cached `SignedEntitlement` | Final phase |
| offline grace | `evaluateStatus()` / `resolveEntitlement()` | implemented (pure) |
| feature gating | `FeatureGate` / `createFeatureGate()` | implemented (pure), unwired |

## Activation & verification flow (target)

```
register → purchase membership → install MEDCORE BOX → first-run activation
   → BOX sends installationId; plane returns a SIGNED ENTITLEMENT
   → BOX verifies signature (Ed25519) and binds it to installationId+tenantId
   → signed entitlement cached locally (survives offline)
   → MEDCORE operates locally against the box's Postgres
   → periodic online re-verification refreshes the cache
   → if the Internet is unavailable: offline GRACE window keeps commercial
     features on; past grace they turn off — clinical core stays on throughout
```

**Hard invariant:** clinical data and clinical workflows never depend on
continuous Internet connectivity, on the plane, or on membership status. Only
`commercial:*` features are gated; `core:*` features are always on (enforced by
`feature-gate.ts` and its tests).

## Customer Package (Final phase — not built now)

Target flow, to be built on the Phase-0 primitives:

```
double-click installer → prerequisites check → install BOX → initialize database
   → run migrations (db/migrate.ts) → write validated config (config/env.ts)
   → create local admin → start backend → start frontend → open browser
   → first-run wizard → membership activation (entitlement flow above)
```

Reusable Phase-0 primitives the installer will call: `db/migrate.ts` (schema),
`db/reset-schema.ts` (pg-only reset, no `psql`), `config/env.ts` (fail-fast
config), `modules/backup` (recovery), `/health/detailed` (readiness gate before
opening the browser), and the entitlement module (activation).

## Boundaries / rules

- The plane never stores or receives PHI. Entitlements carry ids, a plan, feature
  keys and dates only.
- Verification is **fail-closed**: no cached entitlement, a bad signature, or a
  wrong installation/tenant → `unverified` (commercial off, clinical on).
- Wiring the feature gate to any real clinical/AI/pharma feature is a cross-domain
  change and requires a **CCR** (CCR-014) reviewed against the "core is never
  gated" safety rule. Nothing is wired in Phase 0.
