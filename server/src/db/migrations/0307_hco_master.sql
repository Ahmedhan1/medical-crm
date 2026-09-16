-- ============================================================================
-- MEDCORE 0307_hco_master  (Agent 4 — Pharma / HCO)
--
-- HCO MASTER HARDENING. The `hco` table from 0300 is real master data — it is
-- the organisation a physician is affiliated to, the place a representative
-- calls at, and the unit a territory is drawn around — but it was given far
-- less governance than `hcp`:
--
--  1. An organisation had NO IDENTIFIERS. A hospital is identified in the real
--     world by its registration, licence or tax number; without them two feeds
--     describing the same hospital cannot be reconciled, and the only key we
--     had was a lowercased name.
--  2. It had no OWNERSHIP and no OPERATING STATUS. Whether a site is public,
--     private, NGO or university-owned changes who may be engaged and under
--     which code; whether it is open, suspended or closed changes whether it
--     should be visited at all. Both were unrepresentable.
--  3. Its verification was the NARROW 0300 vocabulary (five states, no expiry,
--     no recorded reason) while `hcp` moved to the full lifecycle in 0306, and
--     it had NO REVISION HISTORY at all — an HCO could be edited without trace.
--
-- This migration closes those three gaps by mirroring exactly what 0306 did for
-- `hcp`: the same date/validity columns, the same eight-state vocabulary, the
-- same "a refusal must say why" CHECK, the same append-only revision table, and
-- the same DERIVED expiry through `pharma_effective_verification()` — which is
-- reused here, not re-declared, so the two masters can never disagree about
-- what "expired" means.
--
-- GOVERNANCE BOUNDARY (§45): nothing here references a clinical table, and an
-- HCO never becomes a join point to one. An organisation is a commercial and
-- professional counterparty; it is not a care setting we hold records about.
--
-- IDENTIFIERS: `hco_identifier` is for PUBLIC BUSINESS identifiers of the
-- organisation itself — registration numbers, facility licences, tax numbers
-- that are published in a commercial or health-authority register. Identifiers
-- belonging to a PERSON (national id, passport, a director's tax number) are
-- out of scope by design and are rejected by the service allow-list, exactly as
-- `hcp_identifier` rejects civil identity documents.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ORGANISATION IDENTITY + RECORD VALIDITY
-- ---------------------------------------------------------------------------
ALTER TABLE hco
  -- Who owns the organisation. Drives engagement rules (a public hospital and a
  -- private group are not governed the same way) and is a segmentation axis.
  -- Defaulted to 'unknown' rather than guessing: rows created before this
  -- migration were never asked the question, and 'unknown' says so honestly.
  ADD COLUMN ownership_type text NOT NULL DEFAULT 'unknown'
    CHECK (ownership_type IN (
      'public', 'private', 'ngo', 'university', 'military',
      'religious', 'mixed', 'unknown')),
  -- Whether the organisation is actually operating. Distinct from `is_active`,
  -- which is a record-level flag: a site can be CLOSED in the world while its
  -- record remains active and useful for history.
  ADD COLUMN operating_status text NOT NULL DEFAULT 'active'
    CHECK (operating_status IN ('active', 'suspended', 'closed', 'merged')),
  -- Identity resolution: a merged organisation points at its surviving master,
  -- mirroring `hcp.merged_into_hcp_id`.
  ADD COLUMN merged_into_hco_id uuid REFERENCES hco(id) ON DELETE RESTRICT,
  -- When the SOURCE asserted these facts, as distinct from when we recorded
  -- them (created_at) or last checked them (last_verified_at).
  ADD COLUMN source_date date,
  -- Validity window of the organisation record itself.
  ADD COLUMN effective_from date,
  ADD COLUMN effective_to date,
  -- Verification lapses. NULL means "no expiry set"; only a PASSED expiry is
  -- treated as expired (see `pharma_effective_verification` from 0306).
  ADD COLUMN verification_expires_at timestamptz,
  -- Why a record was rejected or suspended. Required by the service for those
  -- transitions: a refusal without a recorded reason is not reviewable.
  ADD COLUMN verification_note text,
  ADD CONSTRAINT hco_effective_window
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  -- A merged organisation must name its survivor, and only a merged one may.
  ADD CONSTRAINT hco_merged_has_target
    CHECK ((operating_status = 'merged') = (merged_into_hco_id IS NOT NULL));

-- Widen the verification vocabulary to the SAME eight states as `hcp`, so one
-- lifecycle module (`modules/hcp/verification.ts`) governs both masters.
ALTER TABLE hco DROP CONSTRAINT IF EXISTS hco_verification_status_check;
ALTER TABLE hco ADD CONSTRAINT hco_verification_status_check
  CHECK (verification_status IN (
    'unverified', 'pending_review', 'verified', 'rejected',
    'suspended', 'expired', 'disputed', 'retired'));

-- A rejected or suspended record must say why, enforced in the schema and not
-- only in the service, so a direct write cannot produce an unexplained refusal.
ALTER TABLE hco ADD CONSTRAINT hco_refusal_has_reason
  CHECK (verification_status NOT IN ('rejected', 'suspended') OR verification_note IS NOT NULL);

CREATE INDEX idx_hco_ownership ON hco (clinic_id, ownership_type);
CREATE INDEX idx_hco_operating_status ON hco (clinic_id, operating_status);
CREATE INDEX idx_hco_merged_into ON hco (merged_into_hco_id);
-- Drives the expiry sweep: verified organisations whose verification lapsed.
-- `pharma_effective_verification` is STABLE (it reads now()), so it cannot sit
-- in an index predicate — hence this partial index over the stored columns.
CREATE INDEX idx_hco_verification_expiry
  ON hco (clinic_id, verification_expires_at)
  WHERE verification_status = 'verified' AND verification_expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- HCO IDENTIFIERS — public business identifiers of the organisation (header).
--
-- Deliberately shaped like `hcp_identifier`: same columns, same uniqueness
-- rule, same provenance. The allow-list of permitted `identifier_system`
-- values lives in the service (`HCO_IDENTIFIER_SYSTEMS`), mirroring
-- `PROFESSIONAL_IDENTIFIER_SYSTEMS`, because widening it is a governance
-- decision rather than a data-entry one.
-- ---------------------------------------------------------------------------
CREATE TABLE hco_identifier (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hco_id                uuid NOT NULL REFERENCES hco(id) ON DELETE CASCADE,
  identifier_system     text NOT NULL,       -- e.g. 'EG_MOH_FACILITY','EG_TAX_ID','GLN'
  identifier_value      text NOT NULL,
  issuing_jurisdiction  text NOT NULL,
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
  last_verified_at      timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hco_identifier_window
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  -- The same business number cannot belong to two organisations in one tenant;
  -- that is a duplicate, not a second fact.
  UNIQUE (clinic_id, identifier_system, identifier_value)
);
CREATE INDEX idx_hco_identifier_hco ON hco_identifier (hco_id);

-- ---------------------------------------------------------------------------
-- HCO REVISION HISTORY — append-only master-data versioning, mirroring
-- `hcp_revision` field for field (including the `verification_expired` change
-- type, so an automatic lapse stays distinguishable from a human decision).
-- ---------------------------------------------------------------------------
CREATE TABLE hco_revision (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id       uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hco_id          uuid NOT NULL REFERENCES hco(id) ON DELETE CASCADE,
  record_version  integer NOT NULL,
  change_type     text NOT NULL
                    CHECK (change_type IN (
                      'create', 'update', 'verify', 'status_change', 'merge',
                      'verification_expired')),
  changed_fields  text[] NOT NULL DEFAULT '{}',
  snapshot        jsonb NOT NULL,
  source          text NOT NULL,
  changed_by      uuid REFERENCES app_user(id),
  changed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hco_id, record_version)
);
CREATE INDEX idx_hco_revision_hco ON hco_revision (hco_id, record_version);

-- History is evidence: it may be appended to, never edited or erased.
CREATE TRIGGER trg_hco_revision_append_only
  BEFORE UPDATE OR DELETE ON hco_revision
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
