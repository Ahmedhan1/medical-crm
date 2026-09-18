# MEDCORE

**A local-first healthcare operating platform** — clinical workflow, HCP
engagement, automation, and privacy-preserving healthcare intelligence,
deployed on-premises where the data is created.

MEDCORE is built around a small set of reusable platform engines (Identity,
Workflow, Event, Automation, AI, Intelligence, Governance) rather than a pile
of disconnected features. The clinic product is the high-frequency wedge; the
pharma field product is the high-value buyer; a governed intelligence layer
sits between them so pharma never touches patient identity.

> Positioning note (per product rules §55): the underlying categories —
> practice management, HCP master data, pharma CRM, drug knowledge — already
> exist in the market (Veeva, IQVIA, RxNorm/DailyMed/openFDA, Vezeeta). MEDCORE's
> differentiation is the **combination and deployment**: local-first,
> QR/WhatsApp/AI-native clinic workflow bridged to pharma field intelligence
> through a hard governance boundary. No "first in the world" claims.

---

## Repository status

This repository started empty. It now contains the **V1 Clinic Core vertical
slice** — a production-grade, fully tested end-to-end path through the core
engines — plus the architecture documents that scope the wider platform.

- **Built and tested now:** local server, users + RBAC, authentication/sessions,
  patient identity, secure QR identity, front-desk check-in + queue, append-only
  audit log and event store, database migrations. See
  [`docs/IMPLEMENTATION-STATUS.md`](docs/IMPLEMENTATION-STATUS.md).
- **Designed, not yet built:** everything past the slice, phased in
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (§ Roadmap).

### Documentation

| Doc | Contents |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Repository audit, gap analysis, target architecture, module map, engine designs (local server, AI, WhatsApp, QR, pharma/rep, physician & drug master, intelligence firewall), roadmap, testing & recovery strategy |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | Domain/entity map and the implemented schema |
| [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md) | Permission matrix, data-governance model, pharma boundary, intelligence firewall |
| [`docs/IMPLEMENTATION-STATUS.md`](docs/IMPLEMENTATION-STATUS.md) | What the slice implements vs. the acceptance criteria |

---

## Quickstart (local development)

Prerequisites: Node.js ≥ 20 and PostgreSQL ≥ 14.

```bash
# 1. Create databases (once)
createdb medcore

# 2. Configure
cd server
cp .env.example .env            # set a strong AUTH_PEPPER for real deployments

# 3. Install, migrate, seed a demo clinic
npm install
npm run seed                    # runs migrations + seeds RBAC + demo clinic

# 4. Run
npm run dev                     # http://localhost:4000
```

The seed prints a demo clinic id and three logins
(`admin`, `reception`, `doctor`). Example:

```bash
# login
curl -s localhost:4000/auth/login -H 'content-type: application/json' \
  -d '{"clinicId":"<CLINIC_ID>","username":"reception","password":"reception12345"}'

# register a patient (use the returned token)
curl -s localhost:4000/patients -H "authorization: Bearer <TOKEN>" \
  -H 'content-type: application/json' \
  -d '{"fullName":"Sara Ahmed","sex":"female","phone":"+201000000001"}'
```

### Tests

```bash
cd server
npm test          # unit + integration (requires a reachable Postgres for TEST_DATABASE_URL)
npm run typecheck
```

The suite covers the dangerous cases explicitly (§53): unauthorized access,
pharma-user patient access attempts, cross-clinic isolation, duplicate patient
creation, duplicate active encounters, and audit-log tamper resistance.

## Project layout

```
docs/                      Architecture & governance documents
server/
  src/
    config/                Validated configuration (fail-fast)
    db/                    Pool, transaction helper, SQL migrations + runner
    domain/                Typed errors, event catalog
    modules/
      identity/            Users, patients (Identity engine)
      auth/                Password hashing, tokens, sessions
      governance/          Permissions, RBAC, audit (Governance engine)
      qr/                  Secure QR identity (Identity/Workflow)
      workflow/            Check-in + queue (Workflow engine)
    http/                  Fastify server, routes, auth plugin
  test/                    Unit + integration tests
```
