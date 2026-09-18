-- ============================================================================
-- MEDCORE 0304_intelligence  (Agent 4)
--
-- Healthcare intelligence: the governed OUTPUT side of the firewall.
--
--   classification → authorization → de-identification → aggregation
--   → minimum-cohort threshold → policy validation → allowed signal
--
-- Only the last stage is persisted. `aggregated_signal` holds counts over
-- cohorts, never rows about individuals: there is no subject id, no free text
-- copied from a source record, and `cohort_size` is stored alongside the
-- `min_cohort_size` that was in force, so any published number can be audited
-- against the policy that allowed it.
--
-- WHAT IS NOT HERE, DELIBERATELY: no table in this migration references
-- `patient`, `encounter`, or any clinical table. Clinical data has no path into
-- this schema. The governed clinical read contract (CCR-001) is still PROPOSED;
-- until Agent 1 approves it, the only sources the pipeline accepts are pharma's
-- own field data, and `intelligence_run.source_kind` records which was used.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- POLICY — the rules the pipeline enforces, as data rather than as constants,
-- so a jurisdiction can require a stricter threshold than the global default.
-- ---------------------------------------------------------------------------
CREATE TABLE intelligence_policy (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                 uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  key                       text NOT NULL,
  description               text NOT NULL,
  jurisdiction              text NOT NULL,
  -- The floor is 5: a cohort smaller than this is treated as re-identifiable.
  -- The CHECK makes weakening the threshold below the floor impossible from the
  -- application, not merely discouraged.
  min_cohort_size           integer NOT NULL DEFAULT 5 CHECK (min_cohort_size >= 5),
  -- Coarsest identifiable unit a signal may describe.
  max_precision             text NOT NULL DEFAULT 'territory'
                              CHECK (max_precision IN ('territory','region','country')),
  requires_deidentification boolean NOT NULL DEFAULT true
                              CHECK (requires_deidentification),
  allowed_signal_types      text[] NOT NULL DEFAULT '{}',
  is_active                 boolean NOT NULL DEFAULT true,
  created_by                uuid REFERENCES app_user(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, key)
);

-- ---------------------------------------------------------------------------
-- RUN — one execution of the pipeline. Records what was evaluated, what was
-- suppressed and why, so suppression is observable rather than silent.
-- ---------------------------------------------------------------------------
CREATE TABLE intelligence_run (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  -- Which governed source the cohorts came from. 'clinical_governed' is only
  -- reachable once CCR-001 is APPROVED and implemented by Agent 1.
  source_kind         text NOT NULL
                        CHECK (source_kind IN ('pharma_field','clinical_governed')),
  signal_type         text NOT NULL,
  scope_type          text NOT NULL
                        CHECK (scope_type IN ('territory','region','country','therapeutic_area','product','global')),
  jurisdiction        text NOT NULL,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  policy_key          text NOT NULL,
  min_cohort_size     integer NOT NULL,
  status              text NOT NULL
                        CHECK (status IN ('completed','denied','failed')),
  cohorts_evaluated   integer NOT NULL DEFAULT 0,
  cohorts_suppressed  integer NOT NULL DEFAULT 0,
  signals_published   integer NOT NULL DEFAULT 0,
  denial_reason       text,
  requested_by        uuid REFERENCES app_user(id),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  CONSTRAINT intelligence_run_period CHECK (period_end >= period_start)
);
CREATE INDEX idx_intelligence_run_clinic ON intelligence_run(clinic_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- AGGREGATED SIGNAL — the only artefact pharma may read.
--
-- Every signal carries its full governance envelope: source, timestamp, scope,
-- jurisdiction, confidence, aggregation level, provenance and policy status
-- (GOVERNANCE.md § Intelligence firewall).
-- ---------------------------------------------------------------------------
CREATE TABLE aggregated_signal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  run_id            uuid REFERENCES intelligence_run(id) ON DELETE SET NULL,
  signal_type       text NOT NULL,                   -- e.g. 'hcp_feedback_theme'
  signal_key        text NOT NULL,                   -- dimension value, e.g. 'safety'
  signal_label      text,
  -- scope
  scope_type        text NOT NULL
                      CHECK (scope_type IN ('territory','region','country','therapeutic_area','product','global')),
  scope_id          text,
  scope_label       text,
  jurisdiction      text NOT NULL,
  aggregation_level text NOT NULL
                      CHECK (aggregation_level IN ('hcp_group','territory','region','country')),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  -- the measurement
  value             numeric(14,4) NOT NULL,
  value_unit        text NOT NULL CHECK (value_unit IN ('count','percent','index','rate')),
  cohort_size       integer NOT NULL,
  min_cohort_size   integer NOT NULL,
  confidence        numeric(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- governance envelope
  source            text NOT NULL,
  source_version    text,
  method            text NOT NULL,                   -- how the value was derived
  provenance        jsonb NOT NULL DEFAULT '{}'::jsonb,
  deidentified      boolean NOT NULL DEFAULT true CHECK (deidentified),
  policy_key        text NOT NULL,
  policy_status     text NOT NULL DEFAULT 'passed' CHECK (policy_status = 'passed'),
  generated_at      timestamptz NOT NULL DEFAULT now(),
  generated_by      uuid REFERENCES app_user(id),
  published_at      timestamptz NOT NULL DEFAULT now(),
  -- A stored signal can never be below the threshold that governed it. This is
  -- the firewall's last line: even a bug in the pipeline cannot persist a
  -- re-identifiable cohort.
  CONSTRAINT signal_meets_threshold CHECK (cohort_size >= min_cohort_size),
  CONSTRAINT signal_threshold_floor CHECK (min_cohort_size >= 5),
  CONSTRAINT signal_period CHECK (period_end >= period_start),
  UNIQUE (clinic_id, signal_type, signal_key, scope_type, scope_id, period_start, period_end)
);
CREATE INDEX idx_signal_lookup
  ON aggregated_signal(clinic_id, signal_type, period_start DESC);
CREATE INDEX idx_signal_scope ON aggregated_signal(clinic_id, scope_type, scope_id);
