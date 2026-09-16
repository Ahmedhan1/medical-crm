-- ============================================================================
-- MEDCORE 0100_clinical_intake_vitals  (Agent 2 — Clinical Core, task C001)
--
-- Structured intake (chief complaint + history) and vitals capture against an
-- encounter. These are the first *clinical* rows in the system, so they follow
-- the established conventions exactly:
--   * clinic_id on every row (tenant scope enforced in queries, never implied)
--   * timestamptz timestamps
--   * hard physiological bounds as CHECK constraints so an out-of-range value
--     can never be persisted even if a future caller bypasses the service layer
-- ============================================================================

-- ---------------------------------------------------------------------------
-- INTAKE — one revisable record per encounter (nurse/doctor collected).
-- Revisions are journaled to the event store + audit log, so the current row is
-- mutable while the history stays tamper-evident.
-- ---------------------------------------------------------------------------
CREATE TABLE intake (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  encounter_id             uuid NOT NULL REFERENCES encounter(id) ON DELETE CASCADE,
  patient_id               uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,

  chief_complaint          text NOT NULL,
  history_present_illness  text,
  past_medical_history     text,
  medication_history       text,
  allergies                text,
  family_history           text,
  social_history           text,
  notes                    text,

  -- Provenance of the record. 'staff' is direct human entry; 'ai_assisted'
  -- marks an AI draft that a human REVIEWED AND CONFIRMED (blueprint §12 —
  -- AI never writes clinical data directly). `source_ref` is an opaque
  -- reference owned by the producing workstream: deliberately NOT a foreign
  -- key, so the clinical schema carries no coupling to another agent's tables.
  source                   text NOT NULL DEFAULT 'staff'
                             CHECK (source IN ('staff','ai_assisted')),
  source_ref               text,
  -- Who confirmed an ai_assisted record; always a human.
  confirmed_by             uuid REFERENCES app_user(id),

  recorded_by              uuid NOT NULL REFERENCES app_user(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- An AI-sourced record is only valid once a human has confirmed it.
  CONSTRAINT ck_intake_ai_confirmed
    CHECK (source <> 'ai_assisted' OR confirmed_by IS NOT NULL)
);
-- One intake record per encounter; re-submitting updates it in place.
CREATE UNIQUE INDEX uq_intake_encounter ON intake(encounter_id);
CREATE INDEX idx_intake_patient ON intake(clinic_id, patient_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- VITAL — append-style observation set (FHIR Observation-aligned). Multiple
-- sets per encounter are clinically normal (triage, re-check, post-treatment),
-- so this is a row-per-measurement-set table rather than 1:1 with the encounter.
-- ---------------------------------------------------------------------------
CREATE TABLE vital (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  encounter_id        uuid NOT NULL REFERENCES encounter(id) ON DELETE CASCADE,
  patient_id          uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,

  systolic_bp         integer  CHECK (systolic_bp       BETWEEN 40 AND 300),
  diastolic_bp        integer  CHECK (diastolic_bp      BETWEEN 20 AND 200),
  heart_rate          integer  CHECK (heart_rate        BETWEEN 20 AND 300),
  respiratory_rate    integer  CHECK (respiratory_rate  BETWEEN 4  AND 80),
  temperature_c       numeric(4,1) CHECK (temperature_c BETWEEN 25 AND 45),
  spo2                integer  CHECK (spo2              BETWEEN 50 AND 100),
  weight_kg           numeric(5,2) CHECK (weight_kg     BETWEEN 0.2 AND 500),
  height_cm           numeric(5,1) CHECK (height_cm     BETWEEN 20 AND 260),
  blood_glucose_mgdl  integer  CHECK (blood_glucose_mgdl BETWEEN 10 AND 1000),
  pain_score          integer  CHECK (pain_score        BETWEEN 0  AND 10),
  notes               text,

  -- Derived, never client-supplied, so it cannot disagree with its inputs.
  bmi numeric(5,2) GENERATED ALWAYS AS (
    CASE
      WHEN weight_kg IS NOT NULL AND height_cm IS NOT NULL AND height_cm > 0
      THEN round(weight_kg / ((height_cm / 100) * (height_cm / 100)), 2)
      ELSE NULL
    END
  ) STORED,

  recorded_by  uuid NOT NULL REFERENCES app_user(id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),

  -- A vitals row with no measurement is meaningless; reject it in the schema.
  CONSTRAINT ck_vital_not_empty CHECK (
    num_nonnulls(systolic_bp, diastolic_bp, heart_rate, respiratory_rate,
                 temperature_c, spo2, weight_kg, height_cm,
                 blood_glucose_mgdl, pain_score) > 0
  ),
  -- Blood pressure is a pair: either both components or neither, and systolic
  -- must exceed diastolic.
  CONSTRAINT ck_vital_bp_pair CHECK (
    (systolic_bp IS NULL) = (diastolic_bp IS NULL)
  ),
  CONSTRAINT ck_vital_bp_order CHECK (
    systolic_bp IS NULL OR systolic_bp > diastolic_bp
  )
);
CREATE INDEX idx_vital_encounter ON vital(encounter_id, recorded_at DESC);
CREATE INDEX idx_vital_patient ON vital(clinic_id, patient_id, recorded_at DESC);
