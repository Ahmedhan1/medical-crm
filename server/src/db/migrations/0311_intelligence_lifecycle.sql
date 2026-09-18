-- ============================================================================
-- MEDCORE 0311_intelligence_lifecycle  (Agent 4 — Pharma / Intelligence)
--
-- A GOVERNED LIFECYCLE FOR AGGREGATE SIGNALS.
--
-- WHY THIS EXISTS. Until now a firewall run published its output the instant it
-- was computed, and that output never expired. Two consequences, both of which
-- an auditor would call a finding:
--
--  1. NO REVIEW. The pipeline's arithmetic was reviewed (0304 thresholds, 0305
--     disclosure control), but nobody reviewed the *claim*. A number that is
--     statistically safe can still be commercially misleading — wrong period,
--     wrong denominator, a theme misread as a trend. It reached consumers as
--     published truth with no human having agreed that it was true.
--  2. NO WAY BACK. There was no withdrawal and no expiry, so a signal that was
--     later known to be wrong, or simply stale, stayed on display for ever.
--     A claim that cannot be retracted is not a governed claim.
--
-- The lifecycle added here:
--
--     draft ──► in_review ──► approved ──► published ──► expired
--                    │                          │
--                    └──► rejected              └──► withdrawn
--
-- Three rules matter more than the graph, and all three are enforced HERE in
-- the schema as well as in the service, so a direct write cannot produce a
-- state the service would have refused:
--
--  * A signal reaches `published` only with an approver recorded.
--  * The principal who GENERATED a signal may not be the one who APPROVES it
--    (`signal_no_self_approval`), mirroring "content cannot be approved by its
--    own owner" in the scientific-content lifecycle.
--  * A refusal must say why: `rejected` needs a review note, `withdrawn` needs
--    a withdrawal reason. An unexplained retraction is not reviewable.
--
-- Expiry is DERIVED, not merely swept — see `pharma_effective_signal_status`
-- below, which follows exactly the pattern 0306 established for HCP
-- verification. Correctness never depends on a background job having run.
--
-- WHAT IS NOT HERE, DELIBERATELY: nothing in this migration references any
-- clinical table, and no column is added that could carry a subject. The
-- lifecycle governs a claim about a cohort; it does not make the cohort finer.
-- The exact `cohort_size` remains the operator's audit-only column, and the
-- 0304 threshold CHECKs and 0305 banding are untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- LIFECYCLE STATE ON THE SIGNAL
--
-- `published_at` already exists from 0304, where it meant "the moment the run
-- persisted this row" — i.e. publication was creation. It is REUSED as the
-- moment of the publish TRANSITION, so there is exactly one publication
-- timestamp in the model. That means it must become nullable: a draft has not
-- been published, and recording `now()` for it would be a false statement.
-- ---------------------------------------------------------------------------
ALTER TABLE aggregated_signal
  ALTER COLUMN published_at DROP DEFAULT,
  ALTER COLUMN published_at DROP NOT NULL;

ALTER TABLE aggregated_signal
  -- A run now produces `draft`. Publication is a separate, reviewed decision.
  ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_status IN (
      'draft', 'in_review', 'approved', 'published',
      'rejected', 'withdrawn', 'expired')),
  -- Who moved it into review, and when. This is an authoring act (the producer
  -- submits their own output), which is why it is kept distinct from approval.
  ADD COLUMN reviewed_by   uuid REFERENCES app_user(id),
  ADD COLUMN reviewed_at   timestamptz,
  -- Who accepted the claim. Separate accountability from generation.
  ADD COLUMN approved_by   uuid REFERENCES app_user(id),
  ADD COLUMN approved_at   timestamptz,
  -- Who made it readable by consumers (`published_at`, reused, is the when).
  ADD COLUMN published_by  uuid REFERENCES app_user(id),
  -- Retraction. A withdrawn signal is never silently deleted: the row stays,
  -- carrying who pulled it, when and why.
  ADD COLUMN withdrawn_by  uuid REFERENCES app_user(id),
  ADD COLUMN withdrawn_at  timestamptz,
  ADD COLUMN withdrawal_reason text,
  -- Shelf life. NULL means "no expiry set" — the effective-status function
  -- below treats only a PASSED expiry as expired, never a missing one.
  ADD COLUMN expires_at    timestamptz,
  -- The reviewer's note: the reason for a rejection, or the remark attached to
  -- an approval. Required by CHECK for a rejection.
  ADD COLUMN review_note   text;

-- BACKFILL. Rows that already exist were published on creation under the
-- previous regime — by a pipeline run, with no human having reviewed the claim.
-- Under this migration that is precisely what `draft` means, so they are moved
-- to `draft` and their `published_at` is cleared: no approval ever happened and
-- the model must not pretend one did. Nothing is lost — 0304 set `published_at`
-- and `generated_at` to the same instant, which `generated_at` still records.
--
-- This RETRACTS existing signals from the consumer read path until they are
-- reviewed. That is the intended direction: the alternative is to grandfather
-- unreviewed claims as published truth, which is the finding this migration
-- exists to close.
UPDATE aggregated_signal
   SET published_at = NULL
 WHERE lifecycle_status = 'draft';

ALTER TABLE aggregated_signal
  -- A published signal must carry the moment it was published.
  ADD CONSTRAINT signal_published_has_timestamp
    CHECK (lifecycle_status <> 'published' OR published_at IS NOT NULL),
  -- A refusal without a recorded reason is not reviewable. Mirrors
  -- `hcp_refusal_has_reason` in 0306.
  ADD CONSTRAINT signal_rejection_has_note
    CHECK (lifecycle_status <> 'rejected' OR review_note IS NOT NULL),
  ADD CONSTRAINT signal_withdrawal_has_reason
    CHECK (lifecycle_status <> 'withdrawn' OR withdrawal_reason IS NOT NULL),
  -- SEPARATION OF DUTIES. The principal who generated a signal may not approve
  -- it. Enforced in the schema and not only in the service, so a direct write
  -- cannot manufacture a self-approved claim.
  ADD CONSTRAINT signal_no_self_approval
    CHECK (approved_by IS NULL OR generated_by IS NULL OR approved_by <> generated_by),
  -- An approval decision names its approver AND its moment: either both are
  -- present or neither is.
  ADD CONSTRAINT signal_approval_is_attributed
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  -- NOTHING REACHES THE CONSUMER UNAPPROVED. `approved` and `published` both
  -- require a recorded approver; there is no path to either state that leaves
  -- the claim unattributed. Together with `signal_no_self_approval` this is the
  -- schema-level statement of "an unapproved signal is never published truth".
  ADD CONSTRAINT signal_approved_has_approver
    CHECK (lifecycle_status NOT IN ('approved', 'published') OR approved_by IS NOT NULL);

-- The consumer read path: published signals for a clinic, newest period first.
CREATE INDEX idx_signal_lifecycle
  ON aggregated_signal (clinic_id, lifecycle_status, period_start DESC);

-- Drives the expiry sweep: published signals whose shelf life has run out.
-- A partial index rather than an expression over the STABLE function below,
-- for the same reason as 0306: a now()-dependent expression is not indexable.
CREATE INDEX idx_signal_expiry
  ON aggregated_signal (clinic_id, expires_at)
  WHERE lifecycle_status = 'published' AND expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- EFFECTIVE LIFECYCLE STATUS
--
-- Expiry is derived, not merely swept. A published signal past its `expires_at`
-- reads as `expired` from the moment it lapses, even if no sweep has run — so a
-- missed or failed background job can never leave a stale claim on display, and
-- an expired signal can never be returned to a consumer as published truth.
-- The sweep then persists the same answer and emits the event.
--
-- This is the same contract as `pharma_effective_verification` (0306), and the
-- repository uses it in BOTH the SELECT list and the WHERE clause so a filter
-- can never disagree with what a read reports.
--
-- STABLE (not IMMUTABLE) because it depends on now(); that is also why it cannot
-- be used in an index predicate, hence the partial index above.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pharma_effective_signal_status(
  lifecycle_status text,
  expires_at timestamptz
) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN lifecycle_status = 'published' AND expires_at IS NOT NULL AND expires_at < now()
      THEN 'expired'
    ELSE lifecycle_status
  END;
$$;
