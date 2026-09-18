-- ============================================================================
-- MEDCORE 0313_hco_site_governance  (Agent 4 — Pharma / HCO)
--
-- SITES AND DEPARTMENTS BECOME GOVERNED RECORDS, NOT WRITE-ONCE ROWS.
--
-- 0308 gave `hco_location` and `hco_department` the full master-data column
-- set — provenance, the eight-state verification vocabulary, `verified_by`,
-- `last_verified_at`, `verification_expires_at`, `verification_note`,
-- `confidence`, `operating_status` — and the CHECK constraints that go with it
-- (`*_verified_has_evidence`, `*_refusal_has_reason`).
--
-- None of it was reachable. The service could INSERT a site or a department and
-- nothing else: no update, no verification decision, no operating-status
-- change, no history. In practice that meant
--
--   * a site that moved address, or closed, could never be corrected;
--   * a department could never leave `unverified`, so the verification
--     vocabulary on it was decoration;
--   * `operating_status` could never leave `active`;
--   * and an edit, had one existed, would have left no trace at all —
--     unlike `hcp` (0300) and `hco` (0307), both of which have append-only
--     revision tables.
--
-- The schema promised governance no endpoint delivered. This migration adds the
-- two things needed to keep that promise: a record version on each entity, and
-- an append-only revision table for each, mirroring `hco_revision` field for
-- field (including the `verification_expired` change type, so an automatic
-- lapse stays distinguishable from a human decision).
--
-- TWO TABLES RATHER THAN ONE: a shared `hco_component_revision` with a
-- discriminator would need a component id with no foreign key, because one
-- column cannot reference two tables. History is evidence; evidence that can
-- point at a row which no longer exists is worth less than the duplication
-- costs. Each revision table therefore has a real FK to the entity it records.
--
-- ADDITIVE AND SAFE: every column is added with a default, no existing column
-- changes type or nullability, and no data is rewritten. Existing sites and
-- departments simply begin their history at version 1 with no prior revisions,
-- which is the truth — nothing has ever changed them.
--
-- GOVERNANCE BOUNDARY (§45): nothing here references a clinical table. A site
-- is a place a representative calls at; it is not a care setting we hold
-- records about.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- RECORD VERSIONS
--
-- Defaulted to 1 rather than 0: an existing row IS its first version, and
-- numbering it 0 would make "version 1" mean different things either side of
-- this migration.
-- ---------------------------------------------------------------------------
ALTER TABLE hco_location
  ADD COLUMN record_version integer NOT NULL DEFAULT 1;

ALTER TABLE hco_department
  ADD COLUMN record_version integer NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- APPEND-ONLY HISTORY
-- ---------------------------------------------------------------------------
CREATE TABLE hco_location_revision (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id       uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hco_location_id uuid NOT NULL REFERENCES hco_location(id) ON DELETE CASCADE,
  record_version  integer NOT NULL,
  change_type     text NOT NULL
                    CHECK (change_type IN (
                      'create', 'update', 'verify', 'status_change',
                      'verification_expired')),
  changed_fields  text[] NOT NULL DEFAULT '{}',
  snapshot        jsonb NOT NULL,
  source          text NOT NULL,
  changed_by      uuid REFERENCES app_user(id),
  changed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hco_location_id, record_version)
);
CREATE INDEX idx_hco_location_revision
  ON hco_location_revision (hco_location_id, record_version);

CREATE TRIGGER trg_hco_location_revision_append_only
  BEFORE UPDATE OR DELETE ON hco_location_revision
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();

CREATE TABLE hco_department_revision (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id           uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hco_department_id   uuid NOT NULL REFERENCES hco_department(id) ON DELETE CASCADE,
  record_version      integer NOT NULL,
  change_type         text NOT NULL
                        CHECK (change_type IN (
                          'create', 'update', 'verify', 'status_change',
                          'verification_expired')),
  changed_fields      text[] NOT NULL DEFAULT '{}',
  snapshot            jsonb NOT NULL,
  source              text NOT NULL,
  changed_by          uuid REFERENCES app_user(id),
  changed_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hco_department_id, record_version)
);
CREATE INDEX idx_hco_department_revision
  ON hco_department_revision (hco_department_id, record_version);

CREATE TRIGGER trg_hco_department_revision_append_only
  BEFORE UPDATE OR DELETE ON hco_department_revision
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();

-- ---------------------------------------------------------------------------
-- EXPIRY SWEEP SUPPORT
--
-- `pharma_effective_verification` is STABLE (it reads now()), so it cannot sit
-- in an index predicate. These partial indexes are over the stored columns, the
-- same shape as `idx_hco_verification_expiry` from 0307.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_hco_location_verification_expiry
  ON hco_location (clinic_id, verification_expires_at)
  WHERE verification_status = 'verified' AND verification_expires_at IS NOT NULL;

CREATE INDEX idx_hco_department_verification_expiry
  ON hco_department (clinic_id, verification_expires_at)
  WHERE verification_status = 'verified' AND verification_expires_at IS NOT NULL;
