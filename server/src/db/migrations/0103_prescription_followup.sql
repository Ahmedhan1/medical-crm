-- ============================================================================
-- MEDCORE 0103_prescription_followup  (Agent 2 — Clinical Core, task C007)
--
-- Prescriptions and follow-ups complete the clinical workflow this workstream
-- owns (Patient → … → Treatment → Prescription → Follow-up). They are named in
-- the Clinical Core mission but carry no task id in TASKS.md — see
-- docs/agent-state/agent-2.md.
--
-- A prescription is a legal document. Once issued it is IMMUTABLE: a mistake is
-- corrected by cancelling it and issuing a new one, never by editing what a
-- pharmacist may already have dispensed against. That rule is enforced by the
-- database below, not only by the service layer.
-- ============================================================================

-- Reject any UPDATE that changes a prescription's clinical substance. Only the
-- cancellation columns may move, and only in one direction (see the CHECK).
CREATE OR REPLACE FUNCTION medcore_prescription_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.clinic_id, NEW.encounter_id, NEW.patient_id, NEW.prescriber_id,
      NEW.issued_at, NEW.notes)
     IS DISTINCT FROM
     (OLD.clinic_id, OLD.encounter_id, OLD.patient_id, OLD.prescriber_id,
      OLD.issued_at, OLD.notes)
  THEN
    RAISE EXCEPTION
      'Issued prescriptions are immutable; cancel and re-issue instead of editing';
  END IF;
  IF OLD.status <> 'active' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'A prescription that is already % cannot change status', OLD.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE prescription (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id            uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  encounter_id         uuid NOT NULL REFERENCES encounter(id) ON DELETE RESTRICT,
  patient_id           uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  -- The clinician who takes responsibility for this prescription.
  prescriber_id        uuid NOT NULL REFERENCES app_user(id),

  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','cancelled')),
  notes                text,
  issued_at            timestamptz NOT NULL DEFAULT now(),

  cancelled_at         timestamptz,
  cancelled_by         uuid REFERENCES app_user(id),
  cancellation_reason  text,

  created_at           timestamptz NOT NULL DEFAULT now(),

  -- Cancellation is all-or-nothing: a cancelled prescription records when, by
  -- whom and why; an active one records none of it.
  CONSTRAINT ck_prescription_cancelled CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (status = 'cancelled') = (cancelled_by IS NOT NULL)
    AND (status = 'cancelled') = (cancellation_reason IS NOT NULL)
  )
);
CREATE INDEX idx_prescription_encounter ON prescription(encounter_id, issued_at DESC);
CREATE INDEX idx_prescription_patient
  ON prescription(clinic_id, patient_id, issued_at DESC);

CREATE TRIGGER trg_prescription_immutable
  BEFORE UPDATE ON prescription
  FOR EACH ROW EXECUTE FUNCTION medcore_prescription_immutable();

-- A prescription is never deleted; cancellation is the only exit.
CREATE TRIGGER trg_prescription_no_delete
  BEFORE DELETE ON prescription
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();

-- ---------------------------------------------------------------------------
-- PRESCRIPTION_ITEM — the prescribed lines. Append-only: items are written once
-- with their prescription and never altered afterwards.
--
-- `medication_name` is free text and `medication_ref` is an opaque reference
-- deliberately carrying NO foreign key. The canonical medication master is
-- another workstream's concern (P002); a foreign key here would couple the
-- clinical schema to it and make prescribing impossible for anything not yet in
-- that catalog. See CONTRACT_CHANGE_REQUEST.md CCR-001.
-- ---------------------------------------------------------------------------
CREATE TABLE prescription_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  prescription_id  uuid NOT NULL REFERENCES prescription(id) ON DELETE RESTRICT,
  line_no          integer NOT NULL CHECK (line_no > 0),

  medication_name  text NOT NULL,
  medication_ref   text,
  dose             text NOT NULL,
  route            text NOT NULL CHECK (route IN
                     ('oral','topical','inhaled','intravenous','intramuscular',
                      'subcutaneous','rectal','ophthalmic','otic','nasal','other')),
  frequency        text NOT NULL,
  duration_days    integer CHECK (duration_days BETWEEN 1 AND 365),
  quantity         text,
  instructions     text,

  created_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (prescription_id, line_no)
);
CREATE INDEX idx_prescription_item_prescription ON prescription_item(prescription_id, line_no);

CREATE TRIGGER trg_prescription_item_append_only
  BEFORE UPDATE OR DELETE ON prescription_item
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();

-- ---------------------------------------------------------------------------
-- FOLLOW_UP — the clinical intent to see the patient again, and the worklist
-- reception works from. Scheduling is a clinical decision; closing one out is
-- an operational action, so the two carry different permissions.
-- ---------------------------------------------------------------------------
CREATE TABLE follow_up (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id              uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id             uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  -- The visit at which the follow-up was decided.
  origin_encounter_id    uuid REFERENCES encounter(id) ON DELETE SET NULL,
  -- The visit that fulfilled it, once one has.
  completed_encounter_id uuid REFERENCES encounter(id) ON DELETE SET NULL,

  due_on                 date NOT NULL,
  reason                 text,
  status                 text NOT NULL DEFAULT 'scheduled'
                           CHECK (status IN ('scheduled','completed','cancelled')),

  created_by             uuid NOT NULL REFERENCES app_user(id),
  closed_by              uuid REFERENCES app_user(id),
  closed_at              timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- A closed follow-up records who closed it and when; an open one does not.
  CONSTRAINT ck_follow_up_closed CHECK (
    (status = 'scheduled') = (closed_at IS NULL)
    AND (status = 'scheduled') = (closed_by IS NULL)
  ),
  -- Only a completed follow-up may point at the visit that fulfilled it.
  CONSTRAINT ck_follow_up_completed_encounter CHECK (
    completed_encounter_id IS NULL OR status = 'completed'
  )
);
-- The recall worklist: what is due, oldest first, within a clinic.
CREATE INDEX idx_follow_up_due ON follow_up(clinic_id, status, due_on);
CREATE INDEX idx_follow_up_patient ON follow_up(clinic_id, patient_id, due_on DESC);
