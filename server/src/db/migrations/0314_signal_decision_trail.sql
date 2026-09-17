-- ============================================================================
-- MEDCORE 0314_signal_decision_trail  (Agent 4 — Pharma / Intelligence)
--
-- AN AGGREGATE SIGNAL IS A PUBLISHED CLAIM. ITS DECISIONS NEED A TRAIL.
--
-- 0311 gave signals a governed lifecycle, and the row records the LATEST state
-- of each decision — `approved_by`, `published_by`, `withdrawal_reason`. That is
-- a snapshot, not a history, and three consequences followed:
--
--  1. WHO PUT A CLAIM INTO REVIEW WAS NEVER RECORDED. `reviewed_by` and
--     `reviewed_at` existed on the table and no code path ever wrote them: the
--     service read each value and wrote it straight back. Dead columns that
--     looked like an answer.
--  2. A WITHDRAWAL WAS ERASED BY THE NEXT DECISION. Re-submitting a withdrawn
--     claim for review cleared `withdrawn_by`, `withdrawn_at` and
--     `withdrawal_reason`, so WHY a live claim had been pulled disappeared the
--     moment anyone reopened it — precisely when that reason matters most.
--  3. EXPIRY AND SUPERSESSION LEFT NO TRACE AT ALL. The sweep bulk-updated
--     lapsed signals and audited a count; a re-run silently returned a
--     published signal to `draft`. Both are lifecycle transitions and neither
--     was attributable afterwards.
--
-- This table is the history the row cannot be. It is shaped like `visit_event`
-- (0309) and `scientific_request_event` (0310) on purpose: the platform already
-- has one answer to "how did this record reach its state", and a third shape
-- would be a third thing to learn.
--
-- `actor_id` IS NULLABLE, and that is load-bearing: an expiry is the system
-- observing a clock, not a person deciding. Attributing it to whoever happened
-- to run the sweep would be a lie of exactly the kind this trail exists to stop.
--
-- GOVERNANCE (§45): `detail` carries decision SHAPE only — the lifecycle states,
-- the expiry instant, the run that superseded a claim. A signal's VALUE and its
-- cohort size never travel here, for the same reason they never travel in an
-- event payload: this table is read far more widely than the signal row, and an
-- exact count is the raw material of a differencing attack.
-- ============================================================================

CREATE TABLE aggregated_signal_event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id    uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  signal_id    uuid NOT NULL REFERENCES aggregated_signal(id) ON DELETE CASCADE,
  event_type   text NOT NULL
                 CHECK (event_type IN (
                   -- produced by a firewall run
                   'generated',
                   'submitted', 'approved', 'rejected', 'published', 'withdrawn',
                   -- the clock, not a person
                   'expired',
                   -- a re-run recomputed the slice, so the prior review no
                   -- longer covers the claim and it returned to `draft`
                   'superseded')),
  from_status  text CHECK (from_status IS NULL OR from_status IN (
                 'draft', 'in_review', 'approved', 'published',
                 'rejected', 'withdrawn', 'expired')),
  to_status    text NOT NULL CHECK (to_status IN (
                 'draft', 'in_review', 'approved', 'published',
                 'rejected', 'withdrawn', 'expired')),
  reason       text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- NULL for a system transition (expiry, supersession by a re-run).
  actor_id     uuid REFERENCES app_user(id),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  -- A refusal or a retraction must say why, here as well as on the row: the
  -- trail is what survives, so an unexplained entry in it is worth nothing.
  CONSTRAINT signal_event_refusal_has_reason
    CHECK (event_type NOT IN ('rejected', 'withdrawn') OR reason IS NOT NULL)
);

CREATE INDEX idx_signal_event_signal ON aggregated_signal_event (signal_id, occurred_at);
CREATE INDEX idx_signal_event_clinic_time
  ON aggregated_signal_event (clinic_id, event_type, occurred_at DESC);

-- History is evidence: it may be appended to, never edited or erased.
CREATE TRIGGER trg_aggregated_signal_event_append_only
  BEFORE UPDATE OR DELETE ON aggregated_signal_event
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
