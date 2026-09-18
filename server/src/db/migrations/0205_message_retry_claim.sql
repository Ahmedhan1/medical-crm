-- 0205: atomic retry-claim lease for message_log (Agent 3 range 0200-0299).
--
-- Closes a duplicate-patient-communication race in the message retry path.
-- Before this, retryMessage / retryDueMessages selected a 'failed' row and then
-- called the provider send OUTSIDE any lock, so two concurrent retriers (an
-- admin retry racing the worker sweep, or two workers) could both transmit the
-- SAME message — the patient received it twice.
--
-- A retry is now granted only to the worker whose conditional UPDATE flips
-- `retry_claimed_at` (see delivery.claimForRetry): the loser's guarded UPDATE
-- matches zero rows and does not send. The claim is a short lease so a retry
-- that crashes mid-send (leaving the row 'failed') becomes reclaimable after the
-- lease window instead of being stranded. The column is nullable with no
-- backfill, so this is safe on both a fresh install and existing data.
ALTER TABLE message_log ADD COLUMN retry_claimed_at timestamptz;

-- Support the due-and-unclaimed scan the batch retriever runs.
CREATE INDEX idx_message_log_retry_claim
  ON message_log(clinic_id, status, next_attempt_at, retry_claimed_at);
