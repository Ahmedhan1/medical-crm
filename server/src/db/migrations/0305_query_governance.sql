-- ============================================================================
-- MEDCORE 0305_query_governance  (Agent 4 — Pharma / Intelligence)
--
-- PHASE 28/29: statistical disclosure control and query governance.
--
-- WHY THIS EXISTS. Migration 0304 enforces a per-query minimum cohort, which
-- stops a single small aggregate from being published. It does NOT stop an
-- analyst from asking a *sequence* of individually-legal questions and
-- subtracting the answers:
--
--     run over {territory A, B}, Jan 1-31  -> cohort 10
--     run over {territory B},    Jan 1-31  -> cohort  8
--     => territory A had 2 -- a below-threshold cohort, recovered by arithmetic.
--
-- The same works by narrowing the period one day at a time to isolate a single
-- subject's contribution. This was verified against the running system before
-- this migration was written; it is a real leak, not a theoretical one.
--
-- Three controls are added, all policy-driven so a jurisdiction can be stricter:
--   1. QUERY BUDGET       - a bounded number of intelligence runs per principal
--                           per rolling window. Differencing needs many queries.
--   2. NARROWING DETECTION - a run whose slice is strictly contained in slices
--                           this principal already requested in the window is
--                           refused beyond a shallow depth.
--   3. DISCLOSURE CONTROL - published aggregates are banded and rounded, and a
--                           lone suppressed cohort triggers complementary
--                           suppression (otherwise it is recoverable from the
--                           published siblings).
--
-- Exact counts are still stored, because the operator's own audit trail must be
-- truthful and the 0304 threshold CHECKs depend on them. They are simply no
-- longer what the API hands out.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- POLICY — the knobs for the controls above. All default to the safe value and
-- are CHECK-bounded so no caller can configure the protection away, exactly as
-- `min_cohort_size >= 5` is bounded in 0304.
-- ---------------------------------------------------------------------------
ALTER TABLE intelligence_policy
  -- Maximum intelligence runs per principal per rolling window.
  ADD COLUMN max_queries_per_window integer NOT NULL DEFAULT 30
    CHECK (max_queries_per_window > 0 AND max_queries_per_window <= 1000),
  ADD COLUMN query_window_hours integer NOT NULL DEFAULT 24
    CHECK (query_window_hours > 0 AND query_window_hours <= 720),
  -- How many strictly-narrower repeats of an earlier slice are tolerated before
  -- the request is refused. 0 = refuse any narrowing.
  ADD COLUMN max_narrowing_depth integer NOT NULL DEFAULT 2
    CHECK (max_narrowing_depth >= 0 AND max_narrowing_depth <= 10),
  -- Published measurements are rounded to a multiple of this base.
  ADD COLUMN value_rounding_base integer NOT NULL DEFAULT 5
    CHECK (value_rounding_base >= 1 AND value_rounding_base <= 100),
  -- A single suppressed cohort alongside published siblings is recoverable by
  -- subtraction, so a second cohort is suppressed with it. CHECKed true: this
  -- is not a setting an operator may turn off.
  ADD COLUMN complementary_suppression boolean NOT NULL DEFAULT true
    CHECK (complementary_suppression);

-- ---------------------------------------------------------------------------
-- QUERY LOG — append-only record of every intelligence request, allowed or
-- refused. This is the state the budget and narrowing checks read, and it is
-- also the forensic trail for "who tried to narrow their way to an individual".
--
-- It records the SHAPE of a request (which slice, which period), never a result
-- and never a subject. `scope_keys` holds territory ids, which are commercial
-- geography, not patient data.
-- ---------------------------------------------------------------------------
CREATE TABLE intelligence_query_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id      uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  actor_id       uuid REFERENCES app_user(id),
  query_kind     text NOT NULL CHECK (query_kind IN ('run', 'read')),
  signal_type    text NOT NULL,
  jurisdiction   text NOT NULL,
  scope_type     text NOT NULL,
  -- Sorted territory ids defining the slice; empty array means "unrestricted".
  scope_keys     text[] NOT NULL DEFAULT '{}',
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  policy_key     text NOT NULL,
  outcome        text NOT NULL
                   CHECK (outcome IN ('allowed', 'denied_budget', 'denied_narrowing')),
  -- How many already-seen slices strictly contain this one.
  narrowing_depth integer NOT NULL DEFAULT 0 CHECK (narrowing_depth >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_query_period CHECK (period_end >= period_start)
);

-- The budget/narrowing lookup: one principal's recent history for a signal type.
CREATE INDEX idx_intel_query_actor_window
  ON intelligence_query_log (clinic_id, actor_id, signal_type, created_at DESC);
CREATE INDEX idx_intel_query_outcome
  ON intelligence_query_log (clinic_id, outcome, created_at DESC);

-- Tamper-evidence: a principal must not be able to erase their own narrowing
-- history to reset the budget. Same contract as `event` and `audit_log`.
CREATE TRIGGER trg_intelligence_query_log_append_only
  BEFORE UPDATE OR DELETE ON intelligence_query_log
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();

-- ---------------------------------------------------------------------------
-- SIGNAL BANDING — the published surface of a cohort size. The exact
-- `cohort_size` stays (0304's CHECKs depend on it and the operator's audit must
-- be truthful); `cohort_band` is what the API hands out.
-- ---------------------------------------------------------------------------
ALTER TABLE aggregated_signal
  ADD COLUMN cohort_band text,
  -- The rounding base applied to `value` when it was published, so a consumer
  -- can tell a rounded 10 from an exact 10.
  ADD COLUMN value_rounding_base integer NOT NULL DEFAULT 1
    CHECK (value_rounding_base >= 1);
