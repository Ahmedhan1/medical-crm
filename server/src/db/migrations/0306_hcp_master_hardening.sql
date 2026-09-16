-- ============================================================================
-- MEDCORE 0306_hcp_master_hardening  (Agent 4 — Pharma / HCP)
--
-- PHASES 5-7: HCP master hardening, an explicit verification lifecycle, and
-- attribute-level provenance.
--
-- Three gaps found by audit of the actual 0300 schema:
--
--  1. An HCP had no PROFESSIONAL CATEGORY. The master could not distinguish a
--     physician from a pharmacist or a dentist, which is the first thing a
--     field force, a segment and a jurisdiction rule all need to know.
--  2. Verification had no REJECTED / SUSPENDED / EXPIRED state and no expiry at
--     all, so a record verified once stayed "verified" for ever. Verification
--     that never lapses is not verification; it is a historical claim.
--  3. Provenance existed per RECORD (source, source_version, jurisdiction) but
--     there was no `source_date` — when the source actually asserted the value —
--     and no way to answer "where did THIS attribute come from".
--
-- Nothing here deletes or rewrites existing data: every column is additive, the
-- verification CHECK is widened rather than narrowed, and `hcp_revision` (the
-- append-only history) is untouched except to admit one new change type.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PROFESSIONAL IDENTITY + RECORD VALIDITY
-- ---------------------------------------------------------------------------
ALTER TABLE hcp
  -- What kind of professional this is. Defaulted to 'physician' because every
  -- row that exists today was created through a physician-shaped API; the
  -- default is a migration convenience, not a modelling opinion, and the service
  -- requires the caller to state it explicitly on every new record.
  ADD COLUMN professional_category text NOT NULL DEFAULT 'physician'
    CHECK (professional_category IN (
      'physician', 'pharmacist', 'dentist', 'nurse', 'veterinarian',
      'researcher', 'allied_health', 'other')),
  -- When the SOURCE asserted these facts, as distinct from when we recorded
  -- them (created_at) or last checked them (last_verified_at). A licence export
  -- dated 2024 loaded in 2026 is two-year-old truth, and the model must say so.
  ADD COLUMN source_date date,
  -- Validity window of the professional record itself (e.g. a locum with a
  -- fixed engagement, or a record known to be stale after a date).
  ADD COLUMN effective_from date,
  ADD COLUMN effective_to date,
  -- Verification lapses. NULL means "no expiry set" — see the effective-status
  -- function below, which treats only a PASSED expiry as expired.
  ADD COLUMN verification_expires_at timestamptz,
  -- Why a record was rejected or suspended. Required by the service for those
  -- transitions: a refusal without a recorded reason is not reviewable.
  ADD COLUMN verification_note text,
  ADD CONSTRAINT hcp_effective_window
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);

-- Widen the verification vocabulary (Phase 6). `unverified` and `disputed` are
-- kept: `unverified` is the initial state every record is born in, and
-- `disputed` is in use. The three new states are the ones the lifecycle needs.
ALTER TABLE hcp DROP CONSTRAINT IF EXISTS hcp_verification_status_check;
ALTER TABLE hcp ADD CONSTRAINT hcp_verification_status_check
  CHECK (verification_status IN (
    'unverified', 'pending_review', 'verified', 'rejected',
    'suspended', 'expired', 'disputed', 'retired'));

-- A rejected or suspended record must say why. This is enforced in the schema,
-- not only in the service, so a direct write cannot produce an unexplained
-- refusal.
ALTER TABLE hcp ADD CONSTRAINT hcp_refusal_has_reason
  CHECK (verification_status NOT IN ('rejected', 'suspended') OR verification_note IS NOT NULL);

CREATE INDEX idx_hcp_category ON hcp (clinic_id, professional_category);
-- Drives the expiry sweep: find verified records whose verification has lapsed.
CREATE INDEX idx_hcp_verification_expiry
  ON hcp (clinic_id, verification_expires_at)
  WHERE verification_status = 'verified' AND verification_expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- EFFECTIVE VERIFICATION STATUS
--
-- Expiry is derived, not merely swept. A record whose verification has lapsed
-- reads as `expired` from the moment it lapses, even if no sweep has run — so a
-- missed or failed background job can never leave stale "verified" on display.
-- The sweep then persists the same answer and emits the event.
--
-- STABLE (not IMMUTABLE) because it depends on now(); that is also why it cannot
-- be used in an index predicate, hence the partial index above.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pharma_effective_verification(
  status text,
  expires_at timestamptz
) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN status = 'verified' AND expires_at IS NOT NULL AND expires_at < now()
      THEN 'expired'
    ELSE status
  END;
$$;

-- The sweep records a distinct change type, so an automatic lapse is
-- distinguishable from a human decision in the audit history.
ALTER TABLE hcp_revision DROP CONSTRAINT IF EXISTS hcp_revision_change_type_check;
ALTER TABLE hcp_revision ADD CONSTRAINT hcp_revision_change_type_check
  CHECK (change_type IN (
    'create', 'update', 'verify', 'status_change', 'merge', 'verification_expired'));

-- ---------------------------------------------------------------------------
-- CREDENTIALS — degrees, board certifications, fellowships, training.
--
-- A separate table because an HCP holds several, each with its own issuing body,
-- validity window and provenance. These are PROFESSIONAL qualifications only;
-- the `hcp_identifier` allow-list rule applies here too in spirit — nothing
-- here is a civil or government identity document.
-- ---------------------------------------------------------------------------
CREATE TABLE hcp_credential (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hcp_id                uuid NOT NULL REFERENCES hcp(id) ON DELETE CASCADE,
  credential_type       text NOT NULL DEFAULT 'degree'
                          CHECK (credential_type IN ('degree', 'board_certification',
                                                     'fellowship', 'licence', 'training', 'other')),
  -- Short form as written after a name: 'MD', 'PhD', 'FRCP'.
  credential_code       text,
  credential_name       text NOT NULL,
  issuing_body          text,
  issuing_jurisdiction  text,
  awarded_on            date,
  valid_from            date,
  valid_to              date,
  -- provenance
  source                text NOT NULL,
  source_version        text,
  source_date           date,
  verification_status   text NOT NULL DEFAULT 'unverified'
                          CHECK (verification_status IN (
                            'unverified', 'pending_review', 'verified', 'rejected',
                            'suspended', 'expired', 'disputed', 'retired')),
  verified_by           uuid REFERENCES app_user(id),
  last_verified_at      timestamptz,
  confidence            numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hcp_credential_window
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CONSTRAINT hcp_credential_verified_has_evidence
    CHECK (verification_status <> 'verified' OR last_verified_at IS NOT NULL)
);
CREATE INDEX idx_hcp_credential_hcp ON hcp_credential (hcp_id);
-- One record per credential per issuing body; re-stating the same degree is a
-- data-quality error, not a second qualification.
CREATE UNIQUE INDEX uq_hcp_credential
  ON hcp_credential (clinic_id, hcp_id, credential_type, lower(credential_name),
                     coalesce(lower(issuing_body), ''));
