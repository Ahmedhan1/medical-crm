-- ============================================================================
-- MEDCORE 0112_care_plan  (Agent 2 — Clinical Platform, batch: Care Plans)
--
-- Structured care plans (FHIR CarePlan-aligned): a plan linked to a patient and,
-- optionally, a treatment episode, carrying goals and interventions/activities
-- with explicit, deterministic statuses. Additive and transactional.
-- ============================================================================

CREATE TABLE care_plan (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id   uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  -- Episode-of-care linkage: a plan usually belongs to a longitudinal episode.
  episode_id   uuid REFERENCES treatment_episode(id) ON DELETE SET NULL,
  origin_encounter_id uuid REFERENCES encounter(id) ON DELETE SET NULL,

  title        text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 200),
  description  text,
  intent       text NOT NULL DEFAULT 'plan' CHECK (intent IN ('proposal','plan','order')),
  status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('draft','active','on_hold','completed','revoked')),
  period_start date NOT NULL,
  period_end   date,

  created_by   uuid NOT NULL REFERENCES app_user(id),
  updated_by   uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_care_plan_period CHECK (period_end IS NULL OR period_end >= period_start)
);
CREATE INDEX idx_care_plan_patient ON care_plan(clinic_id, patient_id, created_at DESC);
CREATE INDEX idx_care_plan_episode ON care_plan(episode_id, created_at DESC) WHERE episode_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- CARE_GOAL — a measurable goal of a plan. `achieved_at` is set exactly when
-- the goal is achieved (progress is an explicit status, never inferred).
-- ---------------------------------------------------------------------------
CREATE TABLE care_goal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  care_plan_id  uuid NOT NULL REFERENCES care_plan(id) ON DELETE CASCADE,
  patient_id    uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,

  description   text NOT NULL CHECK (length(btrim(description)) BETWEEN 2 AND 500),
  status        text NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed','active','on_hold','achieved','cancelled')),
  target_date   date,
  achieved_at   timestamptz,
  progress_note text,

  created_by    uuid NOT NULL REFERENCES app_user(id),
  updated_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_care_goal_achieved CHECK ((status = 'achieved') = (achieved_at IS NOT NULL))
);
CREATE INDEX idx_care_goal_plan ON care_goal(care_plan_id, created_at);

-- ---------------------------------------------------------------------------
-- CARE_PLAN_ACTIVITY — an intervention/action within the plan.
-- ---------------------------------------------------------------------------
CREATE TABLE care_plan_activity (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  care_plan_id   uuid NOT NULL REFERENCES care_plan(id) ON DELETE CASCADE,
  patient_id     uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,

  description    text NOT NULL CHECK (length(btrim(description)) BETWEEN 2 AND 500),
  kind           text,
  status         text NOT NULL DEFAULT 'not_started'
                   CHECK (status IN ('not_started','scheduled','in_progress','completed','cancelled')),
  scheduled_date date,
  progress_note  text,

  created_by     uuid NOT NULL REFERENCES app_user(id),
  updated_by     uuid REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_care_plan_activity_plan ON care_plan_activity(care_plan_id, created_at);
