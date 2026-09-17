-- ============================================================================
-- MEDCORE 0315_drug_master_governance  (Agent 4 — Pharma / Drug)
--
-- THE THIRD MASTER CATCHES UP WITH THE OTHER TWO.
--
-- 0306 gave the HCP master a real verification lifecycle and 0307 gave the HCO
-- master the same one. The MEDICATION master — the third governed master-data
-- entity in this workstream, and the one whose records describe regulated
-- products — was left on the narrow 0301 vocabulary and never revisited. The
-- audit found three consequences:
--
--  1. NO LIFECYCLE. `verifyMedication` accepted any status the caller named, so
--     `unverified → verified` in one step was legal. The rule the other two
--     masters enforce — nothing reaches `verified` except through
--     `pending_review` — simply did not exist here.
--  2. NO REFUSAL VOCABULARY. `rejected` and `suspended` were unrepresentable,
--     so a steward who checked a record and found it wrong could only leave it
--     `disputed` with nowhere to say why.
--  3. VERIFICATION NEVER LAPSED. There was no `verification_expires_at`, so a
--     drug record attested in 2019 still reads `verified` today — for data
--     whose regulatory status is exactly the kind that changes underneath you.
--
-- This migration adds the missing columns and widens the CHECKs. It reuses
-- `pharma_effective_verification()` from 0306 rather than declaring a third
-- copy, so all three masters answer "is this still verified?" identically.
--
-- ADDITIVE AND SAFE. Every column is nullable or defaulted, no column changes
-- type, and the vocabulary is WIDENED, never narrowed — every value legal
-- before is legal after, so no existing row can be invalidated by this.
--
-- GOVERNANCE BOUNDARY (§45): a medication record describes a PRODUCT. Nothing
-- here references a patient, a prescription or any clinical table; the
-- prescription→medication reference runs the other way and is Agent 2's under
-- CCR-001.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- MEDICATION (the molecule / concept level)
-- ---------------------------------------------------------------------------
ALTER TABLE medication
  ADD COLUMN verified_by uuid REFERENCES app_user(id),
  -- When the current attestation lapses. NULL means no expiry was set; only a
  -- PASSED expiry counts, exactly as in 0306.
  ADD COLUMN verification_expires_at timestamptz,
  -- Why a record was rejected or suspended. An unexplained refusal is not
  -- reviewable, and for a regulated product that matters more, not less.
  ADD COLUMN verification_note text;

ALTER TABLE medication DROP CONSTRAINT IF EXISTS medication_verification_status_check;
ALTER TABLE medication ADD CONSTRAINT medication_verification_status_check
  CHECK (verification_status IN (
    'unverified', 'pending_review', 'verified', 'rejected',
    'suspended', 'expired', 'disputed', 'retired'));

ALTER TABLE medication ADD CONSTRAINT medication_refusal_has_reason
  CHECK (verification_status NOT IN ('rejected', 'suspended') OR verification_note IS NOT NULL);

-- Drives the expiry sweep. `pharma_effective_verification` is STABLE (it reads
-- now()) so it cannot sit in an index predicate; this is over stored columns,
-- the same shape as 0306/0307/0313.
CREATE INDEX idx_medication_verification_expiry
  ON medication (clinic_id, verification_expires_at)
  WHERE verification_status = 'verified' AND verification_expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- MEDICATION_PRODUCT (the branded, registered pack)
--
-- Given the same treatment: a product carries a regulatory identifier, and a
-- registration is precisely the kind of fact that is withdrawn without warning.
-- ---------------------------------------------------------------------------
ALTER TABLE medication_product
  ADD COLUMN verified_by uuid REFERENCES app_user(id),
  ADD COLUMN verification_expires_at timestamptz,
  ADD COLUMN verification_note text;

ALTER TABLE medication_product DROP CONSTRAINT IF EXISTS medication_product_verification_status_check;
ALTER TABLE medication_product ADD CONSTRAINT medication_product_verification_status_check
  CHECK (verification_status IN (
    'unverified', 'pending_review', 'verified', 'rejected',
    'suspended', 'expired', 'disputed', 'retired'));

ALTER TABLE medication_product ADD CONSTRAINT medication_product_refusal_has_reason
  CHECK (verification_status NOT IN ('rejected', 'suspended') OR verification_note IS NOT NULL);

CREATE INDEX idx_medication_product_verification_expiry
  ON medication_product (clinic_id, verification_expires_at)
  WHERE verification_status = 'verified' AND verification_expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The revision vocabulary gains the automatic lapse, so a sweep-written
-- expiry stays distinguishable from a human decision in the history —
-- the same distinction 0306 and 0307 make.
-- ---------------------------------------------------------------------------
ALTER TABLE medication_revision DROP CONSTRAINT IF EXISTS medication_revision_change_type_check;
ALTER TABLE medication_revision ADD CONSTRAINT medication_revision_change_type_check
  CHECK (change_type IN (
    'create', 'update', 'verify', 'status_change', 'import', 'verification_expired'));
