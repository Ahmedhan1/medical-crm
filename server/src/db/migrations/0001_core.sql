-- ============================================================================
-- MEDCORE 0001_core
-- Foundation schema for the V1 Clinic Core vertical slice.
--
-- Domains covered: Organization, Identity + RBAC (Governance), Patient,
-- front-desk Workflow (encounter/queue), QR identity, Event store, Audit log.
--
-- Design notes:
--   * Every tenant-scoped row carries clinic_id so authorization can enforce
--     data scope (no cross-clinic leakage).
--   * Timestamps are timestamptz; the app is timezone-aware for global use.
--   * FHIR-aligned concepts: `encounter` mirrors FHIR Encounter status flow.
--   * `event` and `audit_log` are append-only (enforced by trigger below).
-- ============================================================================

-- gen_random_uuid() is built into Postgres 13+ core (pgcrypto not required).

-- Reusable trigger function: block UPDATE/DELETE to make a table append-only
-- and therefore tamper-evident (blueprint §34, §12).
CREATE OR REPLACE FUNCTION medcore_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only; % is not permitted',
    TG_TABLE_NAME, TG_OP;
END;
$$;

-- ---------------------------------------------------------------------------
-- ORGANIZATION
-- ---------------------------------------------------------------------------
CREATE TABLE organization (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  country     text NOT NULL DEFAULT 'EG',           -- ISO-3166 alpha-2
  timezone    text NOT NULL DEFAULT 'Africa/Cairo',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clinic (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  name             text NOT NULL,
  branch_code      text,                             -- optional multi-branch label
  timezone         text NOT NULL DEFAULT 'Africa/Cairo',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_clinic_org ON clinic(organization_id);

-- ---------------------------------------------------------------------------
-- IDENTITY + RBAC (Governance engine)
-- ---------------------------------------------------------------------------
CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  username       text NOT NULL,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,                      -- scrypt: salt:params:hash
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, username)
);

CREATE TABLE role (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,                 -- e.g. 'RECEPTION', 'DOCTOR'
  description  text NOT NULL
);

CREATE TABLE permission (
  key          text PRIMARY KEY,                     -- e.g. 'patient:register'
  description  text NOT NULL
);

CREATE TABLE role_permission (
  role_id         uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_key  text NOT NULL REFERENCES permission(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_role (
  user_id  uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_id  uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Opaque session tokens are stored hashed; the raw token never touches the DB.
CREATE TABLE session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,                 -- sha256 of the bearer token
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX idx_session_user ON session(user_id);

-- ---------------------------------------------------------------------------
-- PATIENT (Identity engine)
-- ---------------------------------------------------------------------------
-- Global monotonic source for medical record numbers. Uniqueness within a
-- clinic is guaranteed because the sequence never repeats; MRNs are formatted
-- app-side (e.g. 'MRN-000042'). Concurrency-safe without row locking.
CREATE SEQUENCE patient_mrn_seq START 1;

CREATE TABLE patient (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  -- Human-friendly per-clinic medical record number.
  mrn           text NOT NULL,
  full_name     text NOT NULL,
  sex           text NOT NULL CHECK (sex IN ('male', 'female', 'other', 'unknown')),
  birth_date    date,
  phone         text,                                -- E.164 where available
  national_id   text,                                -- optional gov identifier
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, mrn)
);
CREATE INDEX idx_patient_clinic ON patient(clinic_id);
-- Trigram-free simple search support (name/phone) scoped by clinic.
CREATE INDEX idx_patient_name ON patient(clinic_id, lower(full_name));
-- Soft duplicate guard: same clinic + same phone flagged at app layer, but a
-- hard unique on national_id when present prevents true duplicates.
CREATE UNIQUE INDEX uq_patient_national_id
  ON patient(clinic_id, national_id) WHERE national_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- WORKFLOW: encounter (visit) + queue state (Workflow engine)
-- FHIR Encounter-aligned status machine.
-- ---------------------------------------------------------------------------
CREATE TABLE encounter (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id   uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  status       text NOT NULL DEFAULT 'checked_in'
                 CHECK (status IN ('checked_in','intake','ready','in_progress','completed','cancelled')),
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  checked_in_by uuid REFERENCES app_user(id)
);
CREATE INDEX idx_encounter_queue ON encounter(clinic_id, status, checked_in_at);
CREATE INDEX idx_encounter_patient ON encounter(patient_id);
-- A patient may only have one active (non-terminal) encounter at a time.
CREATE UNIQUE INDEX uq_encounter_active_patient
  ON encounter(patient_id)
  WHERE status IN ('checked_in','intake','ready','in_progress');

-- ---------------------------------------------------------------------------
-- QR IDENTITY (§10, §43): opaque token → patient. No PHI ever in the payload.
-- ---------------------------------------------------------------------------
CREATE TABLE qr_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id   uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,                 -- sha256 of the opaque token
  kind         text NOT NULL DEFAULT 'patient' CHECK (kind IN ('patient','visit')),
  created_by   uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX idx_qr_patient ON qr_token(patient_id);

-- ---------------------------------------------------------------------------
-- EVENT STORE (Event engine) — append-only structured events drive automation
-- and analytics downstream. §2.
-- ---------------------------------------------------------------------------
CREATE TABLE event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id    uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  type         text NOT NULL,                        -- e.g. 'PATIENT_CHECKED_IN'
  subject_type text NOT NULL,                        -- e.g. 'patient','encounter'
  subject_id   uuid NOT NULL,
  actor_id     uuid REFERENCES app_user(id),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_clinic_time ON event(clinic_id, occurred_at);
CREATE INDEX idx_event_type ON event(clinic_id, type);
CREATE INDEX idx_event_subject ON event(subject_type, subject_id);

-- Statement-level so it blocks even a DELETE that matches zero rows.
-- TRUNCATE is intentionally NOT guarded (privileged maintenance only).
CREATE TRIGGER trg_event_append_only
  BEFORE UPDATE OR DELETE ON event
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();

-- ---------------------------------------------------------------------------
-- AUDIT LOG (§34) — high-value actions, append-only / tamper-evident.
-- Distinct from `event`: audit records WHO did WHAT to WHICH record for
-- governance/forensics; events are domain facts for automation/analytics.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id    uuid REFERENCES clinic(id) ON DELETE RESTRICT,
  actor_id     uuid REFERENCES app_user(id),
  action       text NOT NULL,                        -- e.g. 'patient.register'
  target_type  text,                                 -- e.g. 'patient'
  target_id    text,
  outcome      text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','denied','error')),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- never store PHI here
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_clinic_time ON audit_log(clinic_id, created_at);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at);

CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
