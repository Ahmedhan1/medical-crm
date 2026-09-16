# MEDCORE — Data Model

The database is organized by **domain**, not as an improvised set of tables.
This document lists the target domains (blueprint §5) and details the schema
actually implemented in the V1 Clinic Core slice. FHIR concepts guide the
clinical model (Encounter status flow; later Observation, MedicationRequest,
Condition) but FHIR is a boundary/interoperability format, never the UI or the
internal storage shape.

## Target domains (map)

- **Organization:** organization, clinic, branch, department, room, device
- **Identity:** user, role, permission, staff, physician, HCP, HCO, representative
- **Patient:** patient, identifier, contact, emergency contact, allergy, medical/
  family/surgical/medication history
- **Clinical:** encounter, complaint, observation, vital, examination, assessment,
  diagnosis, treatment plan, procedure, clinical note, follow-up
- **Medication:** medication, ingredient, product, brand, generic, strength, form,
  route, manufacturer, package, order, availability, price reference
- **CRM:** lead, appointment, contact, follow-up task, communication, campaign, recall
- **Pharma:** HCP/HCO profile, affiliation, territory, representative, assignment,
  visit, call report, scientific request, approved content, product discussion, feedback
- **Inventory:** item, batch, expiry, supplier, purchase, stock movement, reorder rule
- **Analytics:** event, metric, aggregated signal, insight, report, report run
- **Governance:** consent, access log, audit log, data policy, export request,
  classification, provenance

## Implemented schema (migration `0001_core.sql`)

Every tenant-scoped row carries `clinic_id` so authorization can enforce data
scope. Timestamps are `timestamptz`. `event` and `audit_log` are append-only,
enforced by a statement-level trigger (`medcore_append_only`) that raises on
UPDATE/DELETE — tamper-evidence at the database level.

### Organization
- `organization(id, name, country, timezone, created_at)`
- `clinic(id, organization_id→organization, name, branch_code, timezone, created_at)`

### Identity + RBAC (Governance)
- `app_user(id, clinic_id→clinic, username, display_name, password_hash, is_active, …)`
  — unique `(clinic_id, username)`; password stored as self-describing scrypt hash.
- `role(id, key unique, description)`
- `permission(key pk, description)`
- `role_permission(role_id→role, permission_key→permission)` — join
- `user_role(user_id→app_user, role_id→role)` — join
- `session(id, user_id→app_user, token_hash unique, created_at, expires_at, revoked_at)`
  — only the SHA-256 of the bearer token is stored.

### Patient (Identity)
- `patient(id, clinic_id→clinic, mrn, full_name, sex, birth_date, phone,
  national_id, created_by→app_user, …)`
  - unique `(clinic_id, mrn)`; MRN drawn from `patient_mrn_seq` (collision-free).
  - partial unique `(clinic_id, national_id)` where national_id is present — hard
    duplicate guard. Name+phone is a soft duplicate guard enforced in the service.
  - index on `(clinic_id, lower(full_name))` for scoped search.

### Workflow: encounter (FHIR Encounter-aligned)
- `encounter(id, clinic_id, patient_id→patient, status, checked_in_at, updated_at,
  checked_in_by→app_user)`
  - `status ∈ {checked_in, intake, ready, in_progress, completed, cancelled}`
  - **partial unique** on `patient_id` where status is non-terminal — a patient
    can hold only one active encounter at a time (translated to HTTP 409).
  - queue index on `(clinic_id, status, checked_in_at)`.

### QR identity (§10, §43)
- `qr_token(id, clinic_id, patient_id→patient, token_hash unique, kind, created_by,
  created_at, expires_at, revoked_at)` — `kind ∈ {patient, visit}`; only the token
  hash is stored; payloads never contain PHI.

### Event store (Event engine) — append-only
- `event(id bigint identity, clinic_id, type, subject_type, subject_id, actor_id,
  payload jsonb, occurred_at)` — indexes on time, type, and subject. Emitted inside
  the same transaction as the state change that produced it.

### Audit log (§34) — append-only / tamper-evident
- `audit_log(id bigint identity, clinic_id, actor_id, action, target_type, target_id,
  outcome, metadata jsonb, ip, created_at)` — `outcome ∈ {success, denied, error}`.
  Never stores PHI in `metadata`; safe to export to administrators/regulators.

### Event catalog (current)
`PATIENT_REGISTERED`, `PATIENT_CHECKED_IN`, `ENCOUNTER_STATUS_CHANGED`,
`QR_ISSUED`, `QR_RESOLVED` — a typed union in `domain/events.ts`, extended as
modules land.

## Migrations

Forward-only `.sql` files named `NNNN_description.sql`, applied in order inside
a transaction, recorded in `schema_migrations` with a SHA-256 checksum. An
already-applied migration cannot be edited silently — the runner refuses a
changed checksum and requires a new migration instead.
