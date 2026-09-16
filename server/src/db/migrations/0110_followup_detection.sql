-- ============================================================================
-- MEDCORE 0110_followup_detection  (Agent 2 — Clinical Platform, Phase 11)
--
-- Overdue follow-up detection. The follow-up STATE already exists: `follow_up`
-- (migration 0103) carries the clinician-defined `due_on` and a lifecycle
-- (scheduled / completed / cancelled). Detection is therefore a READ over that
-- table — no new entity table is created.
--
-- The only persistence needed is IDEMPOTENCY for event emission: a detection
-- sweep must emit FOLLOW_UP_DUE / FOLLOW_UP_OVERDUE at most ONCE per follow-up,
-- so that Agent 3 does not send a reminder on every sweep. These two nullable
-- timestamp markers record that the event was published; re-running the sweep
-- is a no-op. They are additive columns on Agent 2's own table.
-- ============================================================================

ALTER TABLE follow_up
  ADD COLUMN due_event_at     timestamptz,
  ADD COLUMN overdue_event_at timestamptz;

-- The sweep scans scheduled follow-ups that have not yet had their event
-- published, ordered by due date. A partial index keeps that scan cheap as the
-- table grows and most rows are already notified or closed.
CREATE INDEX idx_follow_up_pending_due
  ON follow_up(clinic_id, due_on)
  WHERE status = 'scheduled' AND (due_event_at IS NULL OR overdue_event_at IS NULL);
