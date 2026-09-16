-- ============================================================================
-- MEDCORE 0106_observation_engine  (Agent 2 — Clinical Platform, Phase 3)
--
-- Extensible structured observations (FHIR Observation-shaped) plus a
-- configurable definition catalog. This is the specialty-neutral core the
-- brief asks for: a dermatology PASI score, a cardiology ejection fraction and
-- a physiotherapy range-of-motion angle are all rows here, not new code.
--
-- RELATIONSHIP TO `vital` (migration 0100) — NOT a duplicate system.
-- `vital` stays the fast path for the universal vital set (fixed columns, hard
-- physiological CHECKs, a generated BMI, already consumed by reports, the
-- timeline and the workspace). `observation` is the OPEN extension: anything a
-- clinic wants to capture that is not one of those universal vitals. The two
-- are deliberately separate — rewriting stable, tested, widely-read vitals into
-- a generic EAV table would be a regression, not an improvement. Definitions
-- carry the reference ranges as DATA, which is the one thing vitals hard-codes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- OBSERVATION_DEFINITION — the catalog of observable things, per clinic.
--
-- Config, not code (Phase 18). value_type picks which value column an
-- observation populates. min/max are physiological bounds for VALIDATION;
-- reference_low/high are the NORMAL range for FLAGGING — a value can be valid
-- but abnormal, which is a clinical signal, not an input error.
-- ---------------------------------------------------------------------------
CREATE TABLE observation_definition (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  key              text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  category         text NOT NULL DEFAULT 'clinical'
                     CHECK (category IN ('vital','clinical','functional','scale','lab','other')),
  value_type       text NOT NULL
                     CHECK (value_type IN ('quantity','integer','boolean','text','coded')),
  unit             text,                         -- required for quantity/integer at the app layer
  min_value        numeric,
  max_value        numeric,
  reference_low    numeric,
  reference_high   numeric,
  -- Allowed codes when value_type = 'coded' (e.g. ['mild','moderate','severe']).
  allowed_codes    jsonb,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (clinic_id, key),
  -- Bounds and ranges must be ordered when both ends are present.
  CONSTRAINT ck_obsdef_bounds CHECK (min_value IS NULL OR max_value IS NULL OR max_value >= min_value),
  CONSTRAINT ck_obsdef_reference CHECK (reference_low IS NULL OR reference_high IS NULL OR reference_high >= reference_low),
  -- A numeric range only makes sense for a numeric value type.
  CONSTRAINT ck_obsdef_numeric_only CHECK (
    value_type IN ('quantity','integer')
    OR (min_value IS NULL AND max_value IS NULL AND reference_low IS NULL AND reference_high IS NULL)
  ),
  -- Coded definitions carry their allowed codes; nothing else does.
  CONSTRAINT ck_obsdef_coded CHECK ((value_type = 'coded') = (allowed_codes IS NOT NULL))
);
CREATE INDEX idx_obsdef_clinic ON observation_definition(clinic_id, is_active, category);

-- ---------------------------------------------------------------------------
-- OBSERVATION — a recorded value against a definition. Append-style: a re-check
-- is a new row, never an overwrite, so the observation history is intact (the
-- same rule as `vital`). Exactly one value column is populated, matching the
-- definition's value_type, enforced below.
-- ---------------------------------------------------------------------------
CREATE TABLE observation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  definition_id    uuid NOT NULL REFERENCES observation_definition(id) ON DELETE RESTRICT,
  patient_id       uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  -- Observations usually hang off a visit, but not always (a remote reading, a
  -- historical import), so the encounter link is optional.
  encounter_id     uuid REFERENCES encounter(id) ON DELETE SET NULL,

  value_number     numeric,
  value_text       text,
  value_boolean    boolean,
  value_code       text,
  -- Unit is snapshotted from the definition at record time, so a later change
  -- to the definition cannot silently reinterpret a stored measurement.
  unit             text,
  -- Whether the value fell outside the definition's reference range at record
  -- time. Stored, not recomputed, so it reflects the range then in force.
  is_abnormal      boolean,

  performed_at     timestamptz NOT NULL DEFAULT now(),
  source           text NOT NULL DEFAULT 'staff'
                     CHECK (source IN ('staff','device','ai_assisted')),
  -- An AI-sourced observation is a confirmed draft; the confirming human is set.
  confirmed_by     uuid REFERENCES app_user(id),
  notes            text,
  recorded_by      uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),

  -- Exactly one value is present.
  CONSTRAINT ck_observation_one_value CHECK (
    num_nonnulls(value_number, value_text, value_boolean, value_code) = 1
  ),
  -- AI output never becomes authoritative clinical data without a human (§12).
  CONSTRAINT ck_observation_ai_confirmed CHECK (source <> 'ai_assisted' OR confirmed_by IS NOT NULL)
);
CREATE INDEX idx_observation_patient ON observation(clinic_id, patient_id, performed_at DESC);
CREATE INDEX idx_observation_encounter ON observation(encounter_id, performed_at DESC)
  WHERE encounter_id IS NOT NULL;
CREATE INDEX idx_observation_definition ON observation(clinic_id, definition_id, performed_at DESC);
