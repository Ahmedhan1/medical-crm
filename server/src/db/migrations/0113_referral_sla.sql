-- ============================================================================
-- MEDCORE 0113_referral_sla  (Agent 2 — Clinical Platform, batch: Referral hardening)
--
-- SLA / expiry detection for referrals. The referral lifecycle already supports
-- an explicit `expired` transition (0109); this adds DETECTION of referrals that
-- have breached their due_date SLA. Detection never mutates clinical state — it
-- publishes REFERRAL_SLA_BREACHED for Agent 3 to act on. The single marker column
-- makes that event emission idempotent (at most once per referral), exactly as
-- the follow-up detection sweep does (0110). Additive.
-- ============================================================================

ALTER TABLE referral
  ADD COLUMN sla_breach_event_at timestamptz;

-- Cheap scan for the SLA sweep: still-open referrals past their due date that
-- have not yet had a breach published.
CREATE INDEX idx_referral_sla_pending
  ON referral(clinic_id, due_date)
  WHERE due_date IS NOT NULL
    AND sla_breach_event_at IS NULL
    AND status IN ('draft','ordered','sent','accepted','scheduled');
