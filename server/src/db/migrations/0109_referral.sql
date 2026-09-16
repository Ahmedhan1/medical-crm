-- ============================================================================
-- MEDCORE 0109_referral  (Agent 2 — Clinical Platform, Phase 10)
--
-- Referrals & care coordination. A referral is a ServiceRequest-like clinical
-- order that a patient be seen by another clinician/specialty, internal or
-- external, with a deterministic lifecycle.
--
-- CARE-COORDINATION MODEL — the referral STATUS is the coordination state.
-- There is deliberately no separate task/worklist table: driving a referral
-- from ordered → sent → accepted → scheduled → completed IS the coordination.
-- When downstream automation (a reminder, a task, an escalation) is needed, the
-- Clinical Core emits an event and Agent 3 owns the action — it does not build a
-- task engine here (that would duplicate Agent 3).
--
-- Master data is NOT duplicated: patient/practitioner are foreign keys; an
-- EXTERNAL provider (not in any master we own) is free text plus a specialty.
-- ============================================================================

CREATE TABLE referral (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id               uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  -- The visit the referral was decided at.
  origin_encounter_id      uuid REFERENCES encounter(id) ON DELETE SET NULL,

  -- Who referred (always one of our clinicians).
  referring_practitioner_id uuid NOT NULL REFERENCES app_user(id),

  direction                text NOT NULL CHECK (direction IN ('internal','external')),
  -- Internal target is one of our clinicians; external target is free text
  -- because an outside provider is not in any master this system owns.
  receiving_practitioner_id uuid REFERENCES app_user(id),
  receiving_provider       text,
  receiving_specialty      text,

  reason                   text NOT NULL,
  urgency                  text NOT NULL DEFAULT 'routine'
                             CHECK (urgency IN ('routine','urgent','emergency')),

  -- Deterministic lifecycle. Transitions are an allow-list in the service; the
  -- CHECK only constrains the value domain.
  status                   text NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','ordered','sent','accepted',
                                               'scheduled','completed','cancelled',
                                               'declined','expired')),

  due_date                 date,
  completed_at             timestamptz,
  closure_reason           text,

  -- Coordination linkage. Both optional; both validated to the same patient.
  linked_appointment_id    uuid REFERENCES appointment(id) ON DELETE SET NULL,
  linked_document_id       uuid REFERENCES document_reference(id) ON DELETE SET NULL,

  notes                    text,

  created_by               uuid NOT NULL REFERENCES app_user(id),
  updated_by               uuid REFERENCES app_user(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- An internal referral names a receiving clinician; an external one names a
  -- provider or a specialty. Neither may be empty of a target.
  CONSTRAINT ck_referral_internal_target CHECK (
    direction <> 'internal' OR receiving_practitioner_id IS NOT NULL
  ),
  CONSTRAINT ck_referral_external_target CHECK (
    direction <> 'external' OR (receiving_provider IS NOT NULL OR receiving_specialty IS NOT NULL)
  ),
  -- Completion records when; only a completed referral carries it.
  CONSTRAINT ck_referral_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX idx_referral_patient ON referral(clinic_id, patient_id, created_at DESC);
CREATE INDEX idx_referral_status ON referral(clinic_id, status, due_date);
CREATE INDEX idx_referral_receiving
  ON referral(clinic_id, receiving_practitioner_id, status)
  WHERE receiving_practitioner_id IS NOT NULL;
CREATE INDEX idx_referral_appointment ON referral(linked_appointment_id)
  WHERE linked_appointment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- REFERRAL_STATUS_HISTORY — append-only transition ledger, mirroring the
-- appointment history. Every lifecycle move is permanently reconstructable.
-- ---------------------------------------------------------------------------
CREATE TABLE referral_status_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  referral_id  uuid NOT NULL REFERENCES referral(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  reason       text,
  actor_id     uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_referral_history ON referral_status_history(referral_id, created_at);

CREATE TRIGGER trg_referral_history_append_only
  BEFORE UPDATE OR DELETE ON referral_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
