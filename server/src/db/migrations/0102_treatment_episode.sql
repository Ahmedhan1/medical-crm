-- ============================================================================
-- MEDCORE 0102_treatment_episode  (Agent 2 — Clinical Core, task C005)
--
-- Treatment response tracking (blueprint §15). A treatment episode spans
-- encounters: it starts at one visit and its outcome is observed at later ones.
-- Response is therefore a SEPARATE append-only table rather than a column on
-- the episode — "did this treatment work?" is a series of observations over
-- time, and collapsing it to one field would destroy the longitudinal record
-- this task exists to capture.
-- ============================================================================

CREATE TABLE treatment_episode (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id               uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  -- The visit the treatment was decided at. Kept nullable so an episode
  -- reconstructed from history is still representable.
  origin_encounter_id      uuid REFERENCES encounter(id) ON DELETE SET NULL,
  -- What the treatment is for. A loose reference: the diagnosis may be revised
  -- or the episode may predate coding, so this must not block the episode.
  diagnosis_id             uuid REFERENCES diagnosis(id) ON DELETE SET NULL,

  label                    text NOT NULL,
  indication               text,

  status                   text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','completed','discontinued')),
  started_on               date NOT NULL,
  ended_on                 date,
  discontinuation_reason   text CHECK (discontinuation_reason IN
                             ('adverse_effect','ineffective','patient_choice','other')),

  recorded_by              uuid NOT NULL REFERENCES app_user(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- An episode that has stopped must say when; one still running must not.
  CONSTRAINT ck_episode_ended CHECK ((status = 'active') = (ended_on IS NULL)),
  CONSTRAINT ck_episode_dates CHECK (ended_on IS NULL OR ended_on >= started_on),
  -- A discontinuation reason belongs to a discontinuation and nothing else.
  CONSTRAINT ck_episode_discontinuation CHECK (
    (status = 'discontinued') = (discontinuation_reason IS NOT NULL)
  )
);
CREATE INDEX idx_treatment_episode_patient
  ON treatment_episode(clinic_id, patient_id, started_on DESC);
CREATE INDEX idx_treatment_episode_active
  ON treatment_episode(clinic_id, status, started_on DESC);

-- ---------------------------------------------------------------------------
-- TREATMENT_RESPONSE — append-only observations of how the patient responded.
-- Like `clinical_note`, a recorded clinical observation is never rewritten: a
-- later observation supersedes an earlier one by being later.
-- ---------------------------------------------------------------------------
CREATE TABLE treatment_response (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  episode_id    uuid NOT NULL REFERENCES treatment_episode(id) ON DELETE CASCADE,
  patient_id    uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  -- The visit the response was observed at, when it was observed at one.
  encounter_id  uuid REFERENCES encounter(id) ON DELETE SET NULL,

  response      text NOT NULL CHECK (response IN
                  ('resolved','improved','unchanged','worsened','unknown')),
  observed_on   date NOT NULL,
  notes         text,

  recorded_by   uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_treatment_response_episode
  ON treatment_response(episode_id, observed_on DESC, created_at DESC);
CREATE INDEX idx_treatment_response_patient
  ON treatment_response(clinic_id, patient_id, observed_on DESC);

CREATE TRIGGER trg_treatment_response_append_only
  BEFORE UPDATE OR DELETE ON treatment_response
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
