-- ============================================================================
-- MEDCORE 0101_clinical_encounter  (Agent 2 — Clinical Core, task C002)
--
-- The doctor workspace: the consultation record hanging off an encounter —
-- complaint, examination, assessment, diagnoses, treatment plan and the
-- clinical note journal.
--
-- These live in their own tables rather than as columns on `encounter`. The
-- `encounter` table is foundation-owned shared workflow state (migration 0001);
-- extending it would be a contract change affecting every workstream, while a
-- 1:1 clinical table is owned entirely by Clinical Core and keeps the
-- operational/clinical separation visible in the schema itself.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ENCOUNTER_CLINICAL — the doctor's working record for one consultation (1:1).
-- Created when a doctor takes the patient; mutable while the visit is open.
-- ---------------------------------------------------------------------------
CREATE TABLE encounter_clinical (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id            uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  encounter_id         uuid NOT NULL REFERENCES encounter(id) ON DELETE CASCADE,
  patient_id           uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,

  -- The doctor-confirmed complaint, distinct from the nurse-collected
  -- `intake.chief_complaint`: the clinician may restate it.
  complaint            text,
  examination          text,

  -- Who is conducting the consultation. Set when the encounter is claimed and
  -- used by "Save & Next" (C003) so two doctors never share one patient.
  attending_doctor_id  uuid REFERENCES app_user(id),
  started_at           timestamptz,
  completed_at         timestamptz,

  updated_by           uuid REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_encounter_clinical_encounter ON encounter_clinical(encounter_id);
CREATE INDEX idx_encounter_clinical_patient
  ON encounter_clinical(clinic_id, patient_id, created_at DESC);
CREATE INDEX idx_encounter_clinical_doctor
  ON encounter_clinical(clinic_id, attending_doctor_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- ASSESSMENT — the clinician's impression for the encounter (1:1).
-- ---------------------------------------------------------------------------
CREATE TABLE assessment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  encounter_id  uuid NOT NULL REFERENCES encounter(id) ON DELETE CASCADE,
  patient_id    uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  summary       text NOT NULL,
  severity      text CHECK (severity IN ('mild','moderate','severe','critical')),
  recorded_by   uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_assessment_encounter ON assessment(encounter_id);
CREATE INDEX idx_assessment_patient ON assessment(clinic_id, patient_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- DIAGNOSIS — many per encounter. Coding is optional and deliberately not
-- constrained to a vocabulary here: the canonical terminology master is another
-- workstream's concern, so this table records the code SYSTEM alongside the
-- code and holds no foreign key across workstream boundaries.
-- ---------------------------------------------------------------------------
CREATE TABLE diagnosis (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  encounter_id  uuid NOT NULL REFERENCES encounter(id) ON DELETE CASCADE,
  patient_id    uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,

  description   text NOT NULL,
  code_system   text CHECK (code_system IN ('ICD-10','ICD-11','SNOMED-CT','local')),
  code          text,
  category      text NOT NULL DEFAULT 'primary'
                  CHECK (category IN ('primary','secondary','differential')),
  certainty     text NOT NULL DEFAULT 'confirmed'
                  CHECK (certainty IN ('suspected','probable','confirmed')),
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','resolved','ruled_out')),
  onset_date    date,

  recorded_by   uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A code without its system is unresolvable, so reject the pair half-filled.
  CONSTRAINT ck_diagnosis_code_pair CHECK ((code IS NULL) = (code_system IS NULL))
);
-- At most one primary diagnosis per encounter.
CREATE UNIQUE INDEX uq_diagnosis_primary
  ON diagnosis(encounter_id) WHERE category = 'primary';
CREATE INDEX idx_diagnosis_encounter ON diagnosis(encounter_id, created_at);
CREATE INDEX idx_diagnosis_patient ON diagnosis(clinic_id, patient_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- TREATMENT_PLAN — what the clinician decided to do about it (1:1).
-- ---------------------------------------------------------------------------
CREATE TABLE treatment_plan (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  encounter_id        uuid NOT NULL REFERENCES encounter(id) ON DELETE CASCADE,
  patient_id          uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  summary             text NOT NULL,
  instructions        text,
  -- Clinical intent for a follow-up; the scheduled follow-up itself is a
  -- separate record so intent and scheduling never drift into one field.
  follow_up_in_days   integer CHECK (follow_up_in_days BETWEEN 1 AND 3650),
  recorded_by         uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_treatment_plan_encounter ON treatment_plan(encounter_id);
CREATE INDEX idx_treatment_plan_patient
  ON treatment_plan(clinic_id, patient_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- CLINICAL_NOTE — the append-only note journal. A clinical note is a legal
-- record: it is never edited or deleted. A correction is a NEW note that
-- supersedes an earlier one, which keeps the trail tamper-evident in the same
-- way as `event` and `audit_log`.
-- ---------------------------------------------------------------------------
CREATE TABLE clinical_note (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  encounter_id  uuid NOT NULL REFERENCES encounter(id) ON DELETE RESTRICT,
  patient_id    uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  note_type     text NOT NULL DEFAULT 'progress'
                  CHECK (note_type IN ('progress','examination','assessment','plan','correction','handover')),
  body          text NOT NULL,
  -- A correction points at the note it supersedes (same table, same encounter).
  supersedes_id uuid REFERENCES clinical_note(id),
  author_id     uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_clinical_note_correction
    CHECK (supersedes_id IS NULL OR note_type = 'correction')
);
CREATE INDEX idx_clinical_note_encounter ON clinical_note(encounter_id, created_at);
CREATE INDEX idx_clinical_note_patient
  ON clinical_note(clinic_id, patient_id, created_at DESC);

CREATE TRIGGER trg_clinical_note_append_only
  BEFORE UPDATE OR DELETE ON clinical_note
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
