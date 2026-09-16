-- ============================================================================
-- MEDCORE 0300_hcp_master  (Agent 4 — Pharma / HCP / Drug / Intelligence)
--
-- Physician / HCP master data. This is a MASTER-DATA system, not a contact
-- table: every reference record carries provenance (source, source_version,
-- jurisdiction, last_verified_at), a verification state, a confidence score for
-- enriched fields, and a monotonic record_version with an append-only revision
-- history so any value can be traced to where it came from and when.
--
-- GOVERNANCE BOUNDARY (blueprint §45): nothing in this file references
-- `patient`, `encounter` or any clinical table, and it never may. An HCP is a
-- professional identity used for engagement and territory work; it is not, and
-- must not become, a join point to patient data.
--
-- IDENTIFIERS: `hcp_identifier` is for LEGALLY AVAILABLE PROFESSIONAL
-- identifiers only (licence/registration numbers, NPI, ORCID). Personal
-- government identifiers (national ID, passport) are out of scope by design and
-- are rejected by the service layer.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SPECIALTY TAXONOMY — self-referencing so subspecialties hang off specialties.
-- `taxonomy` names the vocabulary so an internal list can later be replaced by
-- a standard one (SNOMED/NUCC) without rewriting rows.
-- ---------------------------------------------------------------------------
CREATE TABLE specialty (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  taxonomy          text NOT NULL DEFAULT 'MEDCORE',
  code              text NOT NULL,
  display_name      text NOT NULL,
  parent_id         uuid REFERENCES specialty(id) ON DELETE RESTRICT,
  -- provenance
  source            text NOT NULL,
  source_version    text,
  source_ref        text,
  jurisdiction      text,
  last_verified_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, taxonomy, code)
);
CREATE INDEX idx_specialty_clinic ON specialty(clinic_id);
CREATE INDEX idx_specialty_parent ON specialty(parent_id);

-- ---------------------------------------------------------------------------
-- HCO — healthcare organization (hospital, clinic, pharmacy, university…).
-- `parent_hco_id` models the group → hospital → site hierarchy.
-- ---------------------------------------------------------------------------
CREATE TABLE hco (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  name                text NOT NULL,
  hco_type            text NOT NULL DEFAULT 'other'
                        CHECK (hco_type IN ('hospital','clinic','pharmacy','university',
                                            'laboratory','group_practice','ministry','other')),
  parent_hco_id       uuid REFERENCES hco(id) ON DELETE RESTRICT,
  country             text NOT NULL,                    -- ISO-3166 alpha-2
  region              text,
  city                text,
  address_line        text,
  postal_code         text,
  -- master-data governance
  source              text NOT NULL,
  source_version      text,
  source_ref          text,
  jurisdiction        text NOT NULL,
  verification_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified','pending_review','verified','disputed','retired')),
  verified_by         uuid REFERENCES app_user(id),
  last_verified_at    timestamptz,
  confidence          numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  record_version      integer NOT NULL DEFAULT 1,
  is_active           boolean NOT NULL DEFAULT true,
  created_by          uuid REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- A verified record must say who verified it and when (no silent trust).
  CONSTRAINT hco_verified_has_evidence
    CHECK (verification_status <> 'verified' OR last_verified_at IS NOT NULL)
);
CREATE INDEX idx_hco_clinic ON hco(clinic_id);
CREATE INDEX idx_hco_parent ON hco(parent_hco_id);
CREATE UNIQUE INDEX uq_hco_name ON hco(clinic_id, lower(name), country);

-- ---------------------------------------------------------------------------
-- HCP — the physician / healthcare professional master record.
-- ---------------------------------------------------------------------------
CREATE TABLE hcp (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  full_name             text NOT NULL,
  given_name            text,
  family_name           text,
  title                 text,                           -- 'Dr.', 'Prof.'
  primary_specialty_id  uuid REFERENCES specialty(id) ON DELETE SET NULL,
  -- Professional contact channels only. Never personal/home contact details.
  professional_email    text,
  professional_phone    text,
  preferred_language    text,
  notes                 text,
  -- master-data governance
  source                text NOT NULL,
  source_version        text,
  source_ref            text,
  jurisdiction          text NOT NULL,
  verification_status   text NOT NULL DEFAULT 'unverified'
                          CHECK (verification_status IN ('unverified','pending_review','verified','disputed','retired')),
  verified_by           uuid REFERENCES app_user(id),
  last_verified_at      timestamptz,
  confidence            numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  record_version        integer NOT NULL DEFAULT 1,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','inactive','retired','merged')),
  -- Identity resolution: a merged record points at its surviving master.
  merged_into_hcp_id    uuid REFERENCES hcp(id) ON DELETE RESTRICT,
  created_by            uuid REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hcp_verified_has_evidence
    CHECK (verification_status <> 'verified' OR last_verified_at IS NOT NULL),
  CONSTRAINT hcp_merged_has_target
    CHECK ((status = 'merged') = (merged_into_hcp_id IS NOT NULL))
);
CREATE INDEX idx_hcp_clinic ON hcp(clinic_id);
CREATE INDEX idx_hcp_name ON hcp(clinic_id, lower(full_name));
CREATE INDEX idx_hcp_specialty ON hcp(primary_specialty_id);
CREATE INDEX idx_hcp_merged_into ON hcp(merged_into_hcp_id);

-- ---------------------------------------------------------------------------
-- HCP IDENTIFIERS — professional/licensure identifiers only (see header).
-- ---------------------------------------------------------------------------
CREATE TABLE hcp_identifier (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hcp_id                uuid NOT NULL REFERENCES hcp(id) ON DELETE CASCADE,
  identifier_system     text NOT NULL,                  -- e.g. 'EG_MOH_LICENSE','NPI','ORCID'
  identifier_value      text NOT NULL,
  issuing_jurisdiction  text NOT NULL,
  valid_from            date,
  valid_to              date,
  -- provenance
  source                text NOT NULL,
  source_version        text,
  verification_status   text NOT NULL DEFAULT 'unverified'
                          CHECK (verification_status IN ('unverified','pending_review','verified','disputed','retired')),
  last_verified_at      timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, identifier_system, identifier_value)
);
CREATE INDEX idx_hcp_identifier_hcp ON hcp_identifier(hcp_id);

-- ---------------------------------------------------------------------------
-- HCP ↔ SPECIALTY (a physician may hold several specialties/subspecialties).
-- ---------------------------------------------------------------------------
CREATE TABLE hcp_specialty (
  clinic_id         uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hcp_id            uuid NOT NULL REFERENCES hcp(id) ON DELETE CASCADE,
  specialty_id      uuid NOT NULL REFERENCES specialty(id) ON DELETE RESTRICT,
  is_primary        boolean NOT NULL DEFAULT false,
  source            text NOT NULL,
  confidence        numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  last_verified_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hcp_id, specialty_id)
);
CREATE INDEX idx_hcp_specialty_specialty ON hcp_specialty(specialty_id);

-- ---------------------------------------------------------------------------
-- PRACTICE LOCATIONS — where the HCP actually practises (rep routing input).
-- `territory_id` is attached by migration 0302 once territories exist.
-- ---------------------------------------------------------------------------
CREATE TABLE hcp_practice_location (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hcp_id              uuid NOT NULL REFERENCES hcp(id) ON DELETE CASCADE,
  hco_id              uuid REFERENCES hco(id) ON DELETE SET NULL,
  label               text,
  address_line        text,
  city                text,
  region              text,
  country             text NOT NULL,
  postal_code         text,
  latitude            numeric(9,6),
  longitude           numeric(9,6),
  visiting_hours      jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_primary          boolean NOT NULL DEFAULT false,
  -- provenance
  source              text NOT NULL,
  source_version      text,
  verification_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified','pending_review','verified','disputed','retired')),
  last_verified_at    timestamptz,
  confidence          numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_practice_location_hcp ON hcp_practice_location(hcp_id);
CREATE INDEX idx_practice_location_hco ON hcp_practice_location(hco_id);
-- At most one primary practice location per HCP.
CREATE UNIQUE INDEX uq_practice_location_primary
  ON hcp_practice_location(hcp_id) WHERE is_primary;

-- ---------------------------------------------------------------------------
-- HCP ↔ HCO AFFILIATIONS (hospital/clinic attachment, department, role).
-- ---------------------------------------------------------------------------
CREATE TABLE hcp_hco_affiliation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hcp_id              uuid NOT NULL REFERENCES hcp(id) ON DELETE CASCADE,
  hco_id              uuid NOT NULL REFERENCES hco(id) ON DELETE RESTRICT,
  department          text,
  role_title          text,
  affiliation_type    text NOT NULL DEFAULT 'primary'
                        CHECK (affiliation_type IN ('primary','secondary','academic','consulting','honorary')),
  start_date          date,
  end_date            date,
  -- provenance
  source              text NOT NULL,
  source_version      text,
  verification_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified','pending_review','verified','disputed','retired')),
  last_verified_at    timestamptz,
  confidence          numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliation_dates_ordered
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX idx_affiliation_hcp ON hcp_hco_affiliation(hcp_id);
CREATE INDEX idx_affiliation_hco ON hcp_hco_affiliation(hco_id);
-- One open (current) affiliation per HCP+HCO+department pair.
CREATE UNIQUE INDEX uq_affiliation_open
  ON hcp_hco_affiliation(hcp_id, hco_id, coalesce(department, ''))
  WHERE end_date IS NULL;

-- ---------------------------------------------------------------------------
-- PROFESSIONAL INTERESTS — therapeutic areas / research topics for targeting
-- and for pre-visit briefings. Declared or observed, always with a source.
-- ---------------------------------------------------------------------------
CREATE TABLE hcp_professional_interest (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hcp_id            uuid NOT NULL REFERENCES hcp(id) ON DELETE CASCADE,
  interest          text NOT NULL,
  interest_type     text NOT NULL DEFAULT 'therapeutic_area'
                      CHECK (interest_type IN ('therapeutic_area','research','education','digital','other')),
  strength          text NOT NULL DEFAULT 'medium' CHECK (strength IN ('low','medium','high')),
  source            text NOT NULL,
  confidence        numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  last_verified_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_interest_hcp ON hcp_professional_interest(hcp_id);
-- Expression uniqueness needs an index (a table constraint cannot hold lower()).
CREATE UNIQUE INDEX uq_interest_per_hcp
  ON hcp_professional_interest(clinic_id, hcp_id, lower(interest));

-- ---------------------------------------------------------------------------
-- HCP REVISION HISTORY — append-only master-data versioning. Every create,
-- update, verification, status change and merge writes a full snapshot keyed by
-- record_version, so "where did this value come from and when" is answerable.
-- ---------------------------------------------------------------------------
CREATE TABLE hcp_revision (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id       uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hcp_id          uuid NOT NULL REFERENCES hcp(id) ON DELETE CASCADE,
  record_version  integer NOT NULL,
  change_type     text NOT NULL
                    CHECK (change_type IN ('create','update','verify','status_change','merge')),
  changed_fields  text[] NOT NULL DEFAULT '{}',
  snapshot        jsonb NOT NULL,
  source          text NOT NULL,
  changed_by      uuid REFERENCES app_user(id),
  changed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hcp_id, record_version)
);
CREATE INDEX idx_hcp_revision_hcp ON hcp_revision(hcp_id, record_version);

CREATE TRIGGER trg_hcp_revision_append_only
  BEFORE UPDATE OR DELETE ON hcp_revision
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
