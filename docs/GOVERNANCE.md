# MEDCORE — Governance, Permissions & Data Boundaries

Governance is an **architectural feature**, not a document. Authorization,
audit, tenancy and the pharma/clinical boundary are enforced in code and in the
schema, and covered by tests.

## Access-control model

- **RBAC** today: users hold roles; roles bundle fine-grained
  `resource:action` permissions. Decisions use only the request `Principal`
  (user id, clinic id, roles, permission set) resolved at login.
- **ABAC** where appropriate (roadmap): attribute rules such as location, record
  type, or consent purpose layered on top of RBAC.
- **Tenant isolation:** every query is scoped by `clinic_id`; cross-clinic
  access returns *not found* rather than confirming a resource exists.
- **Least privilege:** roles are granted the minimum needed; the single source
  of truth is `modules/governance/permissions.ts`, which seeds the database so
  code and data never drift.

## Permission catalog (current slice)

| Permission | Description |
| --- | --- |
| `patient:register` | Register a new patient |
| `patient:read` | View a patient record |
| `patient:search` | Search patients |
| `qr:issue` | Issue a patient QR identity token |
| `qr:resolve` | Resolve a QR token to a patient |
| `encounter:checkin` | Check a patient in (start an encounter) |
| `encounter:read` | View encounters |
| `queue:read` | View the reception/clinical queue |

## Permission matrix (role × permission)

| Permission \ Role | ADMIN | RECEPTION | NURSE | DOCTOR | PHARMA_REP |
| --- | :---: | :---: | :---: | :---: | :---: |
| patient:register | ✅ | ✅ | — | — | — |
| patient:read     | ✅ | ✅ | ✅ | ✅ | — |
| patient:search   | ✅ | ✅ | ✅ | ✅ | — |
| qr:issue         | ✅ | ✅ | — | — | — |
| qr:resolve       | ✅ | ✅ | ✅ | — | — |
| encounter:checkin| ✅ | ✅ | — | — | — |
| encounter:read   | ✅ | ✅ | ✅ | ✅ | — |
| queue:read       | ✅ | ✅ | ✅ | ✅ | — |

**PHARMA_REP holds no patient/clinical permissions by design.** This is the
enforcement point for the pharma/clinical boundary (blueprint §45) and is
covered by a dedicated security test: a pharma user is authenticated but is
forbidden (HTTP 403, audited) from reading or creating any patient data.

## Audit vs. events

Two distinct append-only stores:

- **Audit log** — governance/forensics: *who* attempted *what* on *which*
  record and the outcome (`success`/`denied`/`error`), plus method/route/ip.
  No PHI in metadata, so it is safe to export. Denied access attempts by an
  authenticated user are recorded centrally (durably, before the 403 returns).
- **Event store** — domain facts for automation and analytics
  (`PATIENT_CHECKED_IN`, …). Emitted in the same transaction as the state change.

Both tables reject UPDATE/DELETE at the database level (statement-level trigger),
making the trail tamper-evident. TRUNCATE is intentionally not blocked (a
privileged maintenance operation, not an application path).

## Authentication & secrets

- Passwords: scrypt with a per-user random salt and a deployment-wide **pepper**
  from the secret manager (never stored in the DB). Hashes are self-describing
  so cost parameters can evolve. Login is constant-work and returns a generic
  error to prevent user enumeration.
- Sessions: high-entropy opaque bearer tokens; only the SHA-256 hash is stored;
  tokens expire and are revocable (logout).
- QR tokens: same opaque-token model; payloads carry no PHI.
- Config: production refuses to boot with the placeholder `AUTH_PEPPER`.

## Intelligence firewall (design — blueprint §25)

No component gives pharma direct access to the clinical database. Any movement
from clinical systems toward pharma analytics must pass, in order:

```
classification → authorization → de-identification → aggregation
→ minimum-cohort threshold → policy validation → allowed signal
```

If the cohort threshold or any policy check fails, the pipeline **returns
nothing**. Signals carry source, timestamp, scope, jurisdiction and confidence.
Patient-level data is never the product sold to pharma; workflow, authorized
HCP engagement and aggregated intelligence are.

## Consent, retention, provenance (roadmap)

Consent/purpose registry, per-jurisdiction retention and deletion, data
classification, and provenance (`source` + `last_verified`) on every imported
master-data field. For Egypt, PDPL No. 151/2020 and its Executive Regulations
frame personal-data processing; health data is treated as requiring heightened
governance and country-specific legal review before any secondary or
cross-border use.
