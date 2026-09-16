-- ============================================================================
-- MEDCORE 0310_medical_affairs  (Agent 4 — Pharma / Medical Affairs)
--
-- MEDICAL INFORMATION WORKFLOW. `scientific_request` (0302) modelled the
-- question and the answer but not the WORK: nobody owned a request, nothing
-- classified it, a `due_date` existed with no consequence for passing it, and
-- the only record of the answer was the answered row itself. A request could
-- sit unowned and overdue for ever and no artefact would say so.
--
-- This migration makes the medical-information workflow governable:
--   * ownership      — `assigned_to` / `assigned_by` / `assigned_at`
--   * classification — `inquiry_category`, `source_channel`
--   * service level  — `priority`, `sla_due_at` (an instant, not a calendar day)
--   * escalation     — recorded, evidenced and never silent
--   * audit trail    — an append-only `scientific_request_event` per state change
--
-- SEPARATION FROM MARKETING (§45 / CCR-005). A scientific request is a medical
-- interaction, not a commercial signal. Nothing here references, or may ever
-- reference, `campaign`, `campaign_target` or `hcp_segment` — there is
-- deliberately no column that could carry a request into a promotional
-- audience, and `test/integration/medical-affairs.test.ts` asserts that the
-- medical-affairs code path writes to none of those tables.
--
-- GOVERNANCE BOUNDARY (§45): no clinical entity is referenced. Every new free
-- text column (`escalation_reason`, event `reason`) is screened by
-- `modules/pharma/guards.ts` before it can be stored.
-- ============================================================================

ALTER TABLE scientific_request
  -- OWNERSHIP. A request with no owner is nobody's problem; medical affairs
  -- assigns it to a named fulfiller, who is recorded with who assigned and when.
  ADD COLUMN assigned_to    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN assigned_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN assigned_at    timestamptz,

  -- CLASSIFICATION. `request_type` (0302) describes the SHAPE of the question
  -- asked in the field; `inquiry_category` is the medical-information taxonomy
  -- applied by medical affairs on triage. They are different judgements made by
  -- different people, so they are different columns.
  ADD COLUMN inquiry_category text NOT NULL DEFAULT 'unclassified'
    CHECK (inquiry_category IN ('unclassified','efficacy','safety','dosing_administration',
                                'pharmacology','interactions','special_population',
                                'formulation_stability','regulatory','health_economics','other')),

  -- SERVICE LEVEL. `urgency` (0302) is what the rep claimed; `priority` is what
  -- medical affairs decided, and `sla_due_at` is the instant the commitment
  -- expires. A `date` was not precise enough to say whether a same-day critical
  -- request is late.
  ADD COLUMN priority text NOT NULL DEFAULT 'routine'
    CHECK (priority IN ('routine','high','critical')),
  ADD COLUMN sla_due_at timestamptz,

  -- WHERE THE QUESTION CAME FROM. Regulators ask this of every medical-
  -- information system; it cannot be reconstructed after the fact.
  ADD COLUMN source_channel text NOT NULL DEFAULT 'field_visit'
    CHECK (source_channel IN ('field_visit','email','phone','congress','web_form',
                              'medical_information_line','other')),

  -- ESCALATION. Level 0 is "never escalated". Any level above 0 must carry both
  -- a timestamp and a reason — the CHECK makes a silent escalation unstorable,
  -- not merely discouraged, so a direct write cannot produce one either.
  ADD COLUMN escalation_level integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  ADD COLUMN escalated_at     timestamptz,
  ADD COLUMN escalated_by     uuid REFERENCES app_user(id),
  ADD COLUMN escalation_reason text,
  ADD CONSTRAINT scientific_request_escalation_evidenced
    CHECK (escalation_level = 0
           OR (escalated_at IS NOT NULL AND escalated_by IS NOT NULL
               AND escalation_reason IS NOT NULL));

-- An answer may be a written summary OR a citation of approved content. The
-- 0302 CHECK demanded a summary, which made a citation-only answer unstorable
-- even though the service has always accepted one. Widened, never narrowed.
ALTER TABLE scientific_request DROP CONSTRAINT IF EXISTS scientific_request_answered_has_answer;
ALTER TABLE scientific_request ADD CONSTRAINT scientific_request_answered_has_answer
  CHECK (status <> 'answered'
         OR (answered_at IS NOT NULL
             AND (answer_summary IS NOT NULL OR answer_content_id IS NOT NULL)));

-- The fulfilment queue: what is mine, what is late.
CREATE INDEX idx_scientific_request_assignee
  ON scientific_request (clinic_id, assigned_to, status, sla_due_at);
-- The breach sweep: open work whose service level has expired.
CREATE INDEX idx_scientific_request_sla
  ON scientific_request (clinic_id, sla_due_at)
  WHERE status IN ('open','in_review') AND sla_due_at IS NOT NULL;
CREATE INDEX idx_scientific_request_category
  ON scientific_request (clinic_id, inquiry_category, created_at);

-- ---------------------------------------------------------------------------
-- SCIENTIFIC REQUEST EVENT — append-only audit trail of every state change.
--
-- The request row carries the CURRENT state; this table carries the HISTORY of
-- how it was reached, including assignments and escalations that do not change
-- the status at all. Append-only by trigger: a late answer, a reassignment or
-- an escalation cannot be edited away afterwards.
-- ---------------------------------------------------------------------------
CREATE TABLE scientific_request_event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id    uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  request_id   uuid NOT NULL REFERENCES scientific_request(id) ON DELETE RESTRICT,
  event_type   text NOT NULL
                 CHECK (event_type IN ('created','assigned','status_changed',
                                       'escalated','answered','closed','reopened')),
  from_status  text CHECK (from_status IS NULL OR from_status IN
                 ('open','in_review','answered','closed','rejected')),
  to_status    text CHECK (to_status IS NULL OR to_status IN
                 ('open','in_review','answered','closed','rejected')),
  reason       text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id     uuid REFERENCES app_user(id),
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_scientific_request_event_request
  ON scientific_request_event (request_id, occurred_at);
CREATE INDEX idx_scientific_request_event_clinic_time
  ON scientific_request_event (clinic_id, event_type, occurred_at);

CREATE TRIGGER trg_scientific_request_event_append_only
  BEFORE UPDATE OR DELETE ON scientific_request_event
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
