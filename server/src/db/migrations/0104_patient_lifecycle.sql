-- ============================================================================
-- MEDCORE 0104_patient_lifecycle  (Agent 2 — Clinical Platform, Phase 1)
--
-- Patient lifecycle: status, demographics that were missing, external
-- identifiers, emergency contacts, and a duplicate-merge ledger.
--
-- Additive only. Every column added to `patient` is nullable or defaulted and
-- no existing column or constraint changes, so every current consumer
-- (messaging recipients, intelligence de-identification, clinical reads) keeps
-- working untouched. Filed as CCR-006 because `patient` is read across
-- workstreams.
--
-- MERGE DESIGN — a merge is a LINK, not a rewrite.
-- Duplicate resolution does NOT repoint historical clinical rows at the
-- surviving patient. Several clinical tables (`clinical_note`,
-- `treatment_response`, `prescription_item`) are append-only at the database
-- level, so rewriting their patient_id is impossible by construction — and that
-- is the correct clinical behaviour, not an obstacle: a note was written about
-- the record the clinician was looking at, and history must keep saying so.
-- Instead the loser is marked `merged` and points at the survivor, and reads
-- resolve the lineage. Nothing is rewritten, so nothing can be lost.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PATIENT — lifecycle status and the demographics the record was missing.
-- ---------------------------------------------------------------------------
ALTER TABLE patient
  ADD COLUMN status              text NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active','inactive','deceased','merged')),
  ADD COLUMN deceased_date       date,
  -- Set only when status = 'merged'; points at the surviving record.
  ADD COLUMN merged_into_id      uuid REFERENCES patient(id) ON DELETE RESTRICT,
  -- BCP-47-style language tag, e.g. 'en', 'ar', 'ar-EG'. Drives which message
  -- template locale and which report language a patient should receive; the
  -- messaging workstream consumes it, this workstream owns it.
  ADD COLUMN preferred_language  text,
  ADD COLUMN email               text,
  ADD COLUMN address             text,
  ADD COLUMN updated_by          uuid REFERENCES app_user(id);

-- A merged record must name its survivor, and only a merged record may.
ALTER TABLE patient ADD CONSTRAINT ck_patient_merged
  CHECK ((status = 'merged') = (merged_into_id IS NOT NULL));
-- A record cannot be its own survivor.
ALTER TABLE patient ADD CONSTRAINT ck_patient_not_self_merged
  CHECK (merged_into_id IS NULL OR merged_into_id <> id);
-- A date of death belongs only to a deceased record. The converse is NOT
-- required: a death may be known without a reliable date.
ALTER TABLE patient ADD CONSTRAINT ck_patient_deceased
  CHECK (deceased_date IS NULL OR status = 'deceased');
-- Keep the language tag well-formed so downstream locale lookup is total.
ALTER TABLE patient ADD CONSTRAINT ck_patient_language
  CHECK (preferred_language IS NULL
         OR preferred_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$');

CREATE INDEX idx_patient_status ON patient(clinic_id, status);
CREATE INDEX idx_patient_merged_into ON patient(merged_into_id)
  WHERE merged_into_id IS NOT NULL;
-- Supports duplicate detection by date of birth within a clinic.
CREATE INDEX idx_patient_birth_date ON patient(clinic_id, birth_date)
  WHERE birth_date IS NOT NULL;

-- ---------------------------------------------------------------------------
-- PATIENT_IDENTIFIER — external identifiers (passport, insurance member no,
-- national health number, …).
--
-- `system` is free text on purpose. Identifier schemes are jurisdictional, and
-- hard-coding an enum here would make MEDCORE Egypt-only. The pair
-- (system, value) is unique per clinic, so two records cannot both claim the
-- same passport — which is exactly the signal duplicate detection needs.
-- ---------------------------------------------------------------------------
CREATE TABLE patient_identifier (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id   uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  system       text NOT NULL CHECK (length(btrim(system)) BETWEEN 1 AND 64),
  value        text NOT NULL CHECK (length(btrim(value)) BETWEEN 1 AND 128),
  issued_on    date,
  expires_on   date,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_patient_identifier_dates
    CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE UNIQUE INDEX uq_patient_identifier_value
  ON patient_identifier(clinic_id, system, value);
CREATE INDEX idx_patient_identifier_patient ON patient_identifier(clinic_id, patient_id);

-- ---------------------------------------------------------------------------
-- PATIENT_CONTACT — emergency contact / next of kin / guardian.
-- ---------------------------------------------------------------------------
CREATE TABLE patient_contact (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id    uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('emergency','next_of_kin','guardian')),
  full_name     text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 200),
  relationship  text,
  phone         text,
  email         text,
  is_primary    boolean NOT NULL DEFAULT false,
  created_by    uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A contact with no way to reach them is not a contact.
  CONSTRAINT ck_patient_contact_reachable
    CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
-- At most one primary contact of each kind per patient.
CREATE UNIQUE INDEX uq_patient_contact_primary
  ON patient_contact(patient_id, kind) WHERE is_primary;
CREATE INDEX idx_patient_contact_patient ON patient_contact(clinic_id, patient_id);

-- ---------------------------------------------------------------------------
-- PATIENT_MERGE — append-only ledger of duplicate resolutions.
-- A merge is a clinical-safety event: who decided two records were one person,
-- when, and why. It is never edited or deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE patient_merge (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  source_patient_id  uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  target_patient_id  uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  reason             text NOT NULL,
  performed_by       uuid NOT NULL REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_patient_merge_distinct CHECK (source_patient_id <> target_patient_id)
);
-- A record can be merged away exactly once.
CREATE UNIQUE INDEX uq_patient_merge_source ON patient_merge(source_patient_id);
CREATE INDEX idx_patient_merge_target ON patient_merge(clinic_id, target_patient_id);

CREATE TRIGGER trg_patient_merge_append_only
  BEFORE UPDATE OR DELETE ON patient_merge
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
