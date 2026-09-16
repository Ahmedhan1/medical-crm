-- ============================================================================
-- MEDCORE 0201_scheduling  (Agent 3 — AI / Automation / WhatsApp)
--
-- Time engine + engine hardening + communication-quality guards. Extends the
-- 0200 automation platform with:
--   * rule priority + version (deterministic execution ordering; rule versioning)
--   * scheduled_action  — durable, timezone-aware delayed/scheduled actions with
--     expiry, retry, dead-letter and DB-enforced idempotency
--   * messaging_policy   — per-clinic/channel quiet-hours + frequency caps so an
--     automation can never spam a patient
--
-- Invariants (unchanged from 0200): clinic-scoped, timestamptz, idempotency in
-- the DB. Reserved range for this workstream: 0200–0299.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ENGINE HARDENING: rule priority + version
--   priority: lower runs first when several rules match one event (deterministic
--             ordering); default 100 leaves existing rules mid-band.
--   version : bumped on each rule edit so run history is attributable to the
--             rule definition that produced it.
-- ---------------------------------------------------------------------------
ALTER TABLE automation_rule
  ADD COLUMN priority int NOT NULL DEFAULT 100,
  ADD COLUMN version  int NOT NULL DEFAULT 1;

-- Deterministic hot-path ordering: enabled event rules by (priority, created_at).
CREATE INDEX idx_automation_rule_event_priority
  ON automation_rule(clinic_id, event_type, priority, created_at) WHERE is_enabled;

-- Record which rule version produced a run (nullable for pre-existing rows).
ALTER TABLE automation_run
  ADD COLUMN rule_version int;

-- ---------------------------------------------------------------------------
-- SCHEDULED ACTION QUEUE (the time engine)
-- A durable record of an action to run at/after `scheduled_for`. Executed by
-- `runDueActions` via the same action registry as event rules. `not_before`
-- carries quiet-hours deferral; `expires_at` drops a reminder that has gone
-- stale rather than sending it late. UNIQUE(clinic_id, dedupe_key) makes
-- scheduling idempotent (re-scheduling the same logical action is a no-op).
-- ---------------------------------------------------------------------------
CREATE TABLE scheduled_action (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  rule_id          uuid REFERENCES automation_rule(id) ON DELETE SET NULL,
  source_event_id  bigint,                         -- event that scheduled it (if any)
  action_type      text NOT NULL,                  -- registry action to run when due
  params           jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key       text,                           -- idempotency (nullable = ad-hoc)
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','executing','done','failed','cancelled','expired')),
  scheduled_for    timestamptz NOT NULL,           -- becomes due at/after this
  not_before       timestamptz,                    -- quiet-hours: do not run before
  expires_at       timestamptz,                    -- do not run at/after this (stale guard)
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 5,
  next_attempt_at  timestamptz,
  last_error       text,
  result           jsonb,
  created_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, dedupe_key)
);
-- Due-scan hot path: pending actions ordered by when they should run.
CREATE INDEX idx_scheduled_action_due
  ON scheduled_action(status, scheduled_for) WHERE status = 'pending';
CREATE INDEX idx_scheduled_action_clinic ON scheduled_action(clinic_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- MESSAGING POLICY (communication-quality guards)
-- Per-clinic, optionally per-channel. Fallback order at send time: exact channel
-- row → the clinic's 'all' row → permissive built-in defaults (so clinics with
-- no policy behave exactly as before). Quiet hours are evaluated in the clinic's
-- timezone; caps bound how often a patient can be contacted.
-- ---------------------------------------------------------------------------
CREATE TABLE messaging_policy (
  clinic_id            uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  channel              text NOT NULL DEFAULT 'all'
                         CHECK (channel IN ('all','whatsapp','sms','email')),
  quiet_hours_enabled  boolean NOT NULL DEFAULT false,
  quiet_start_hour     int NOT NULL DEFAULT 21 CHECK (quiet_start_hour BETWEEN 0 AND 23),
  quiet_end_hour       int NOT NULL DEFAULT 8  CHECK (quiet_end_hour   BETWEEN 0 AND 23),
  daily_cap            int CHECK (daily_cap IS NULL OR daily_cap >= 0),  -- null = unlimited
  min_gap_minutes      int NOT NULL DEFAULT 0 CHECK (min_gap_minutes >= 0),
  updated_by           uuid REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, channel)
);
