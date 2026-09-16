-- ============================================================================
-- MEDCORE 0107_allergy_safety  (Agent 2 — Clinical Platform, Phase 8)
--
-- The patient safety layer. Until now allergies existed only as free text in
-- `intake.allergies`, so prescribing had NO safety net — the highest-severity
-- clinical gap in the platform. This adds a structured allergy record and,
-- with it, a deterministic allergy check at prescription time (in the service).
--
-- SAFETY MODEL — the platform provides DETERMINISTIC rules; it never decides.
-- The prescribing check warns and refuses by default, but a clinician can
-- override with an explicit, audited acknowledgement (the same refuse-then-
-- acknowledge pattern already used for duplicate patients and double-booking).
-- AI cannot bypass it: AI holds no prescribing principal, and the override is a
-- human acknowledgement, not a field a draft can set.
-- ============================================================================

CREATE TABLE allergy (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id    uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,

  -- The allergen/substance, free text. A coded allergen master is another
  -- workstream's concern (like diagnosis and medication coding), so this carries
  -- an optional opaque reference and NO cross-workstream foreign key.
  substance     text NOT NULL CHECK (length(btrim(substance)) BETWEEN 1 AND 200),
  substance_ref text,

  kind          text NOT NULL DEFAULT 'allergy'
                  CHECK (kind IN ('allergy','intolerance')),
  category      text NOT NULL DEFAULT 'medication'
                  CHECK (category IN ('medication','food','environment','other')),
  reaction      text,
  severity      text NOT NULL DEFAULT 'moderate'
                  CHECK (severity IN ('mild','moderate','severe','life_threatening')),
  -- Clinical status of the allergy itself.
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','inactive','resolved','entered_in_error')),
  -- How sure we are it is real. A refuted allergy never blocks prescribing.
  verification  text NOT NULL DEFAULT 'unconfirmed'
                  CHECK (verification IN ('unconfirmed','confirmed','refuted')),
  onset_date    date,
  notes         text,

  recorded_by   uuid NOT NULL REFERENCES app_user(id),
  updated_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- The safety check reads active medication allergies for a patient; index for it.
CREATE INDEX idx_allergy_patient ON allergy(clinic_id, patient_id, status);
CREATE INDEX idx_allergy_active_medication
  ON allergy(clinic_id, patient_id)
  WHERE status = 'active' AND verification <> 'refuted' AND category = 'medication';
-- The same substance should not be recorded twice as an active allergy for a
-- patient; a correction changes the existing row's status instead.
CREATE UNIQUE INDEX uq_allergy_active_substance
  ON allergy(clinic_id, patient_id, lower(btrim(substance)))
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- SAFETY_OVERRIDE — append-only ledger of every time a clinician prescribed
-- through a safety alert. WHO overrode WHAT alert, WHY, and on which
-- prescription. A safety override is a high-consequence clinical decision and
-- must be permanently reconstructable.
-- ---------------------------------------------------------------------------
CREATE TABLE safety_override (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id       uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  prescription_id  uuid REFERENCES prescription(id) ON DELETE SET NULL,
  -- What was overridden, e.g. 'allergy' or 'duplicate_medication'.
  alert_type       text NOT NULL,
  -- The alerts that were present, as structured JSON (no free-text PHI beyond
  -- the medication/substance names the clinician is acting on).
  alerts           jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason           text NOT NULL,
  overridden_by    uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_safety_override_patient ON safety_override(clinic_id, patient_id, created_at DESC);

CREATE TRIGGER trg_safety_override_append_only
  BEFORE UPDATE OR DELETE ON safety_override
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
