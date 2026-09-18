-- ============================================================================
-- MEDCORE 0308_hco_locations  (Agent 4 — Pharma / HCO)
--
-- LOCATIONS AND DEPARTMENTS AS FIRST-CLASS ENTITIES.
--
-- Until now the only "department" in the system was a free-text column on
-- `hcp_hco_affiliation`. That is enough to print on a call sheet and nothing
-- else: "Cardiology", "cardiology" and "Dept. of Cardiology" were three
-- different departments, a department could not be verified, could not carry
-- provenance, could not be attached to a site, and could not be counted. The
-- same was true of sites: a hospital group with six buildings was one `hco`
-- row with one address, so territory routing had to be done through the
-- practice location of each individual physician instead of the organisation's
-- own geography.
--
-- This migration introduces the two missing entities:
--
--   hco ──< hco_location ──< hco_department
--             │                    │
--             territory            └──< hcp_hco_affiliation.hco_department_id
--
-- MIGRATION SAFETY: the legacy `hcp_hco_affiliation.department` text column is
-- KEPT and untouched. Existing rows keep their free-text value, the new FK is
-- NULLABLE, and no backfill is attempted — guessing which structured department
-- a free-text string meant is exactly the kind of silent data invention this
-- platform refuses. The text column is now the legacy value; the FK is the
-- governed one, and a record may carry either, both or neither.
--
-- TENANCY: every table here carries `clinic_id NOT NULL REFERENCES clinic(id)`.
-- Locations and departments are tenant data like everything else; there is no
-- shared "reference" pool of sites across clinics.
--
-- GOVERNANCE BOUNDARY (§45): a location is a place a representative calls at
-- and a department is an organisational unit — neither references a clinical
-- table, and neither is a care record about anyone.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- HCO LOCATION — a physical site of an organisation.
--
-- Shaped deliberately like `hcp_practice_location` (address, optional geo,
-- `is_primary`, territory, provenance) so field routing can treat the two
-- alike, but owned by the ORGANISATION rather than by an individual, which is
-- what makes an organisation's geography representable at all.
-- ---------------------------------------------------------------------------
CREATE TABLE hco_location (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hco_id                uuid NOT NULL REFERENCES hco(id) ON DELETE CASCADE,
  label                 text NOT NULL,                  -- 'Main campus', 'Maadi branch'
  address_line          text,
  city                  text,
  region                text,
  country               text NOT NULL,                  -- ISO-3166 alpha-2
  postal_code           text,
  latitude              numeric(9,6) CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
  longitude             numeric(9,6) CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
  -- Field geography. `ON DELETE SET NULL`: retiring a territory must never
  -- delete a site, it only leaves it unrouted.
  territory_id          uuid REFERENCES territory(id) ON DELETE SET NULL,
  is_primary            boolean NOT NULL DEFAULT false,
  -- Whether the site itself is operating, on the same vocabulary as `hco`.
  operating_status      text NOT NULL DEFAULT 'active'
                          CHECK (operating_status IN ('active', 'suspended', 'closed', 'merged')),
  -- provenance (mandatory: `source` and `jurisdiction` are NOT NULL here and
  -- required at the API boundary, exactly as for every other pharma fact)
  source                text NOT NULL,
  source_version        text,
  source_ref            text,
  source_date           date,
  jurisdiction          text NOT NULL,
  -- verification — the same eight-state vocabulary as `hcp` and `hco`, so one
  -- lifecycle module governs all three.
  verification_status   text NOT NULL DEFAULT 'unverified'
                          CHECK (verification_status IN (
                            'unverified', 'pending_review', 'verified', 'rejected',
                            'suspended', 'expired', 'disputed', 'retired')),
  verified_by           uuid REFERENCES app_user(id),
  last_verified_at      timestamptz,
  verification_expires_at timestamptz,
  verification_note     text,
  confidence            numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  effective_from        date,
  effective_to          date,
  created_by            uuid REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hco_location_verified_has_evidence
    CHECK (verification_status <> 'verified' OR last_verified_at IS NOT NULL),
  CONSTRAINT hco_location_refusal_has_reason
    CHECK (verification_status NOT IN ('rejected', 'suspended') OR verification_note IS NOT NULL),
  CONSTRAINT hco_location_effective_window
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  -- Target of the composite foreign key used by `hco_department` below: it lets
  -- the database, not the service, guarantee that a department's site belongs
  -- to the department's own organisation.
  CONSTRAINT uq_hco_location_identity UNIQUE (id, hco_id)
);
CREATE INDEX idx_hco_location_clinic ON hco_location (clinic_id);
CREATE INDEX idx_hco_location_hco ON hco_location (hco_id);
CREATE INDEX idx_hco_location_territory ON hco_location (territory_id);
-- At most one primary site per organisation.
CREATE UNIQUE INDEX uq_hco_location_primary
  ON hco_location (hco_id) WHERE is_primary;
-- One site per organisation per label; a second "Main campus" is a duplicate.
CREATE UNIQUE INDEX uq_hco_location_label
  ON hco_location (clinic_id, hco_id, lower(label));

-- ---------------------------------------------------------------------------
-- HCO DEPARTMENT — an organisational unit, optionally sited at one location.
--
-- `specialty_id` is OPTIONAL on purpose: plenty of real departments ("Clinical
-- Pharmacy", "Procurement") map to no clinical specialty, and forcing a link
-- would produce invented taxonomy entries. When it IS set, department-level
-- specialty coverage becomes computable for the organisation.
-- ---------------------------------------------------------------------------
CREATE TABLE hco_department (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  hco_id                uuid NOT NULL REFERENCES hco(id) ON DELETE CASCADE,
  -- Which site the department sits at, when known.
  hco_location_id       uuid,
  name                  text NOT NULL,
  specialty_id          uuid REFERENCES specialty(id) ON DELETE SET NULL,
  operating_status      text NOT NULL DEFAULT 'active'
                          CHECK (operating_status IN ('active', 'suspended', 'closed', 'merged')),
  -- provenance (mandatory, as everywhere else)
  source                text NOT NULL,
  source_version        text,
  source_ref            text,
  source_date           date,
  jurisdiction          text NOT NULL,
  -- verification — same vocabulary, same lifecycle module
  verification_status   text NOT NULL DEFAULT 'unverified'
                          CHECK (verification_status IN (
                            'unverified', 'pending_review', 'verified', 'rejected',
                            'suspended', 'expired', 'disputed', 'retired')),
  verified_by           uuid REFERENCES app_user(id),
  last_verified_at      timestamptz,
  verification_expires_at timestamptz,
  verification_note     text,
  confidence            numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_by            uuid REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hco_department_verified_has_evidence
    CHECK (verification_status <> 'verified' OR last_verified_at IS NOT NULL),
  CONSTRAINT hco_department_refusal_has_reason
    CHECK (verification_status NOT IN ('rejected', 'suspended') OR verification_note IS NOT NULL),
  -- A department's site must belong to the department's own organisation. This
  -- is a composite FK rather than a service check so it cannot be bypassed by
  -- any write path. MATCH SIMPLE (the default) means the constraint is not
  -- enforced while `hco_location_id` is NULL, which is exactly the intent: a
  -- department need not be sited. NO ACTION (checked at end of statement, not
  -- per row) so that deleting the parent organisation — which cascades to both
  -- sites and departments in one statement — is not blocked by the order rows
  -- happen to be removed in.
  CONSTRAINT fk_hco_department_location
    FOREIGN KEY (hco_location_id, hco_id)
    REFERENCES hco_location (id, hco_id) ON DELETE NO ACTION,
  -- Target of the composite FK added to `hcp_hco_affiliation` below.
  CONSTRAINT uq_hco_department_identity UNIQUE (id, hco_id)
);
CREATE INDEX idx_hco_department_clinic ON hco_department (clinic_id);
CREATE INDEX idx_hco_department_hco ON hco_department (hco_id);
CREATE INDEX idx_hco_department_location ON hco_department (hco_location_id);
CREATE INDEX idx_hco_department_specialty ON hco_department (specialty_id);
-- One department per organisation per site per name. The sentinel uuid stands
-- in for "no site", because NULL would make every unsited department unique.
CREATE UNIQUE INDEX uq_hco_department_name
  ON hco_department (
    clinic_id, hco_id,
    coalesce(hco_location_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name));

-- ---------------------------------------------------------------------------
-- AFFILIATION → DEPARTMENT.
--
-- Additive and nullable. The legacy `department` text column stays exactly as
-- it was: it is still written, still read, and is now explicitly the LEGACY
-- free-text value. The composite FK guarantees the chosen department belongs to
-- the same organisation as the affiliation itself.
-- ---------------------------------------------------------------------------
ALTER TABLE hcp_hco_affiliation
  ADD COLUMN hco_department_id uuid,
  ADD CONSTRAINT fk_affiliation_department
    FOREIGN KEY (hco_department_id, hco_id)
    REFERENCES hco_department (id, hco_id) ON DELETE NO ACTION;
CREATE INDEX idx_affiliation_department ON hcp_hco_affiliation (hco_department_id);
