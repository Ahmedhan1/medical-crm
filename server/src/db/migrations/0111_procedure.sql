-- ============================================================================
-- MEDCORE 0111_procedure  (Agent 2 — Clinical Platform, batch: Procedures)
--
-- Structured procedure documentation (FHIR Procedure-aligned). A procedure is a
-- doctor-owned clinical act. Once COMPLETED it is an immutable clinical fact:
-- a row-level trigger locks its clinical content, allowing only an audit-safe
-- correction to `entered_in_error`. This mirrors the immutable-prescription
-- pattern already proven in migration 0103. Additive and transactional; the
-- runner is forward-only, so this is logically reversible by dropping the
-- objects it creates.
-- ============================================================================

-- Once a procedure is completed, block any change to its clinical substance.
-- The only permitted post-completion move is completed -> entered_in_error
-- (an audit-preserving correction); the record is never silently rewritten.
CREATE OR REPLACE FUNCTION medcore_procedure_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    IF NEW.status = 'entered_in_error'
       AND (NEW.clinic_id, NEW.patient_id, NEW.encounter_id, NEW.episode_id, NEW.name,
            NEW.code_system, NEW.code, NEW.body_site, NEW.performed_by, NEW.performed_at,
            NEW.outcome, NEW.complication)
         IS NOT DISTINCT FROM
           (OLD.clinic_id, OLD.patient_id, OLD.encounter_id, OLD.episode_id, OLD.name,
            OLD.code_system, OLD.code, OLD.body_site, OLD.performed_by, OLD.performed_at,
            OLD.outcome, OLD.complication)
    THEN
      RETURN NEW;   -- voiding an erroneous completed procedure, content unchanged
    END IF;
    RAISE EXCEPTION
      'A completed procedure is immutable; mark it entered_in_error instead of editing it';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE procedure (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id     uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  -- The visit the procedure was documented in (grounds the clinical context).
  encounter_id   uuid REFERENCES encounter(id) ON DELETE SET NULL,
  -- Episode-of-care linkage: a procedure may belong to a longitudinal episode.
  episode_id     uuid REFERENCES treatment_episode(id) ON DELETE SET NULL,

  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 300),
  -- Terminology is not owned here (same stance as diagnosis): record the system
  -- alongside the code, both or neither, and hold no cross-workstream key.
  code_system    text CHECK (code_system IN ('CPT','ICD-10-PCS','SNOMED-CT','local')),
  code           text,
  body_site      text,

  status         text NOT NULL DEFAULT 'planned'
                   CHECK (status IN ('planned','in_progress','completed','not_done','entered_in_error')),
  -- The clinician who performed (or will perform) the procedure.
  performed_by   uuid REFERENCES app_user(id),
  performed_at   timestamptz,
  outcome        text,
  complication   text,
  not_done_reason text,
  notes          text,

  recorded_by    uuid NOT NULL REFERENCES app_user(id),
  updated_by     uuid REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_procedure_code_pair CHECK ((code IS NULL) = (code_system IS NULL)),
  -- A completed procedure records who performed it and when.
  CONSTRAINT ck_procedure_completed CHECK (
    status <> 'completed' OR (performed_by IS NOT NULL AND performed_at IS NOT NULL)
  ),
  -- A not-done procedure says why.
  CONSTRAINT ck_procedure_not_done CHECK (
    (status = 'not_done') = (not_done_reason IS NOT NULL)
  )
);
CREATE INDEX idx_procedure_patient ON procedure(clinic_id, patient_id, created_at DESC);
CREATE INDEX idx_procedure_encounter ON procedure(encounter_id, created_at DESC)
  WHERE encounter_id IS NOT NULL;
CREATE INDEX idx_procedure_episode ON procedure(episode_id, created_at DESC)
  WHERE episode_id IS NOT NULL;

CREATE TRIGGER trg_procedure_immutable
  BEFORE UPDATE ON procedure
  FOR EACH ROW EXECUTE FUNCTION medcore_procedure_immutable();

-- A procedure is never deleted; history is preserved (entered_in_error marks a
-- mistake). DELETE is blocked outright.
CREATE TRIGGER trg_procedure_no_delete
  BEFORE DELETE ON procedure
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
