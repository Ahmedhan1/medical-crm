-- ============================================================================
-- MEDCORE 0302_pharma_field  (Agent 4)
--
-- Medical-representative platform: territories, HCP targeting, visit planning,
-- call reports, objections, scientific requests and follow-up actions.
--
-- GOVERNANCE BOUNDARY (§45): every table here is keyed on `hcp`, `territory`
-- and `app_user`. None references `patient` or `encounter`, and none ever may.
-- Free text written in the field (summaries, objections, questions) is screened
-- for patient-identifier-shaped tokens by `modules/pharma/guards.ts` before it
-- is stored, because free text is the only realistic path for patient data to
-- be copied by hand into the commercial side of the system.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- TERRITORY — a hierarchical sales/field geography.
-- ---------------------------------------------------------------------------
CREATE TABLE territory (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id            uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  code                 text NOT NULL,
  name                 text NOT NULL,
  parent_territory_id  uuid REFERENCES territory(id) ON DELETE RESTRICT,
  country              text NOT NULL,
  region               text,
  is_active            boolean NOT NULL DEFAULT true,
  created_by           uuid REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, code)
);
CREATE INDEX idx_territory_parent ON territory(parent_territory_id);

-- Which representative covers which territory, and when.
CREATE TABLE territory_assignment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  territory_id   uuid NOT NULL REFERENCES territory(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  assignment_role text NOT NULL DEFAULT 'primary_rep'
                   CHECK (assignment_role IN ('primary_rep','backup_rep','manager')),
  valid_from     date NOT NULL DEFAULT current_date,
  valid_to       date,
  created_by     uuid REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT territory_assignment_dates CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX idx_territory_assignment_user ON territory_assignment(user_id, territory_id);
-- One open assignment per (territory, user, role).
CREATE UNIQUE INDEX uq_territory_assignment_open
  ON territory_assignment(territory_id, user_id, assignment_role)
  WHERE valid_to IS NULL;

-- Practice locations gain a territory now that territories exist (0300 created
-- the column-less table; routing is by location, not by the HCP as a whole).
ALTER TABLE hcp_practice_location
  ADD COLUMN territory_id uuid REFERENCES territory(id) ON DELETE SET NULL;
CREATE INDEX idx_practice_location_territory ON hcp_practice_location(territory_id);

-- ---------------------------------------------------------------------------
-- HCP TARGETING — which HCPs a territory covers, and how often to call.
-- This is also the VISIBILITY RULE for field representatives: a rep may only
-- see HCPs targeted in a territory they are currently assigned to.
-- ---------------------------------------------------------------------------
CREATE TABLE hcp_territory (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id               uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hcp_id                  uuid NOT NULL REFERENCES hcp(id) ON DELETE CASCADE,
  territory_id            uuid NOT NULL REFERENCES territory(id) ON DELETE CASCADE,
  is_target               boolean NOT NULL DEFAULT true,
  tier                    text CHECK (tier IS NULL OR tier IN ('A','B','C','D')),
  target_visits_per_quarter integer
                            CHECK (target_visits_per_quarter IS NULL OR target_visits_per_quarter >= 0),
  assigned_by             uuid REFERENCES app_user(id),
  assigned_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, hcp_id, territory_id)
);
CREATE INDEX idx_hcp_territory_territory ON hcp_territory(territory_id);
CREATE INDEX idx_hcp_territory_hcp ON hcp_territory(hcp_id);

-- ---------------------------------------------------------------------------
-- VISIT — planned and executed representative calls on an HCP.
-- ---------------------------------------------------------------------------
CREATE TABLE visit (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hcp_id                uuid NOT NULL REFERENCES hcp(id) ON DELETE RESTRICT,
  territory_id          uuid REFERENCES territory(id) ON DELETE SET NULL,
  hco_id                uuid REFERENCES hco(id) ON DELETE SET NULL,
  practice_location_id  uuid REFERENCES hcp_practice_location(id) ON DELETE SET NULL,
  rep_user_id           uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  status                text NOT NULL DEFAULT 'planned'
                          CHECK (status IN ('planned','confirmed','completed','cancelled','no_access')),
  visit_type            text NOT NULL DEFAULT 'detail'
                          CHECK (visit_type IN ('detail','follow_up','scientific','courtesy','event')),
  planned_at            timestamptz NOT NULL,
  started_at            timestamptz,
  ended_at              timestamptz,
  objective             text,
  outcome_reason        text,                        -- cancellation / no-access reason
  created_by            uuid REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visit_times_ordered CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);
-- "Today's visits" for a representative.
CREATE INDEX idx_visit_rep_day ON visit(clinic_id, rep_user_id, planned_at);
CREATE INDEX idx_visit_hcp ON visit(hcp_id, planned_at DESC);
CREATE INDEX idx_visit_territory ON visit(territory_id, planned_at);

-- ---------------------------------------------------------------------------
-- CALL REPORT — exactly one per completed visit.
-- ---------------------------------------------------------------------------
CREATE TABLE call_report (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  visit_id       uuid NOT NULL UNIQUE REFERENCES visit(id) ON DELETE CASCADE,
  hcp_id         uuid NOT NULL REFERENCES hcp(id) ON DELETE RESTRICT,
  rep_user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  summary        text NOT NULL,
  hcp_sentiment  text NOT NULL DEFAULT 'unknown'
                   CHECK (hcp_sentiment IN ('positive','neutral','negative','unknown')),
  next_step      text,
  follow_up_date date,
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_call_report_hcp ON call_report(hcp_id, submitted_at DESC);
CREATE INDEX idx_call_report_clinic_time ON call_report(clinic_id, submitted_at);

-- Products discussed during the call — the raw material for product-interest
-- intelligence (aggregated and threshold-gated before it leaves this layer).
CREATE TABLE call_report_product (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  call_report_id     uuid NOT NULL REFERENCES call_report(id) ON DELETE CASCADE,
  medication_id      uuid REFERENCES medication(id) ON DELETE SET NULL,
  product_label      text,                           -- free label when not yet mastered
  discussion_outcome text NOT NULL DEFAULT 'needs_info'
                       CHECK (discussion_outcome IN ('interested','not_interested','needs_info','objection','committed')),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_report_product_identified
    CHECK (medication_id IS NOT NULL OR product_label IS NOT NULL)
);
CREATE INDEX idx_call_report_product_report ON call_report_product(call_report_id);
CREATE INDEX idx_call_report_product_medication ON call_report_product(medication_id);

-- Objections/questions raised by the HCP — the raw material for feedback-theme
-- and availability intelligence.
CREATE TABLE visit_objection (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  call_report_id  uuid NOT NULL REFERENCES call_report(id) ON DELETE CASCADE,
  hcp_id          uuid NOT NULL REFERENCES hcp(id) ON DELETE RESTRICT,
  medication_id   uuid REFERENCES medication(id) ON DELETE SET NULL,
  objection_type  text NOT NULL
                    CHECK (objection_type IN ('efficacy','safety','cost','availability','guideline','experience','other')),
  objection_text  text NOT NULL,
  resolved        boolean NOT NULL DEFAULT false,
  resolution_note text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_objection_report ON visit_objection(call_report_id);
CREATE INDEX idx_objection_theme ON visit_objection(clinic_id, objection_type, created_at);

-- Competitor mentions — competitive intelligence, reported from the field.
CREATE TABLE call_report_competitor (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  call_report_id     uuid NOT NULL REFERENCES call_report(id) ON DELETE CASCADE,
  hcp_id             uuid NOT NULL REFERENCES hcp(id) ON DELETE RESTRICT,
  competitor_name    text NOT NULL,
  competitor_product text,
  context            text,
  sentiment          text NOT NULL DEFAULT 'unknown'
                       CHECK (sentiment IN ('positive','neutral','negative','unknown')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_competitor_report ON call_report_competitor(call_report_id);
CREATE INDEX idx_competitor_name ON call_report_competitor(clinic_id, lower(competitor_name), created_at);

-- ---------------------------------------------------------------------------
-- SCIENTIFIC REQUESTS — an HCP question the rep cannot answer, routed to
-- medical affairs. Answered from approved content (FK added in 0303).
-- ---------------------------------------------------------------------------
CREATE TABLE scientific_request (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hcp_id              uuid NOT NULL REFERENCES hcp(id) ON DELETE RESTRICT,
  visit_id            uuid REFERENCES visit(id) ON DELETE SET NULL,
  call_report_id      uuid REFERENCES call_report(id) ON DELETE SET NULL,
  medication_id       uuid REFERENCES medication(id) ON DELETE SET NULL,
  requested_by        uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  request_type        text NOT NULL DEFAULT 'other'
                        CHECK (request_type IN ('clinical_data','safety_info','dosing','publication','formulation','other')),
  question            text NOT NULL,
  urgency             text NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine','high')),
  status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','in_review','answered','closed','rejected')),
  due_date            date,
  answer_summary      text,
  answered_by         uuid REFERENCES app_user(id),
  answered_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scientific_request_answered_has_answer
    CHECK (status <> 'answered' OR (answer_summary IS NOT NULL AND answered_at IS NOT NULL))
);
CREATE INDEX idx_scientific_request_hcp ON scientific_request(hcp_id, created_at DESC);
CREATE INDEX idx_scientific_request_open ON scientific_request(clinic_id, status, due_date);
CREATE INDEX idx_scientific_request_trend ON scientific_request(clinic_id, request_type, created_at);

-- ---------------------------------------------------------------------------
-- FOLLOW-UP ACTIONS — the commitments a visit generates.
-- ---------------------------------------------------------------------------
CREATE TABLE follow_up_action (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hcp_id          uuid NOT NULL REFERENCES hcp(id) ON DELETE RESTRICT,
  visit_id        uuid REFERENCES visit(id) ON DELETE SET NULL,
  call_report_id  uuid REFERENCES call_report(id) ON DELETE CASCADE,
  owner_user_id   uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  action          text NOT NULL,
  due_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  completed_at    timestamptz,
  created_by      uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT follow_up_done_has_timestamp
    CHECK (status <> 'done' OR completed_at IS NOT NULL)
);
CREATE INDEX idx_follow_up_owner ON follow_up_action(clinic_id, owner_user_id, status, due_date);
CREATE INDEX idx_follow_up_hcp ON follow_up_action(hcp_id, due_date DESC);
