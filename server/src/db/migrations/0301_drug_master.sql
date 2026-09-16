-- ============================================================================
-- MEDCORE 0301_drug_master  (Agent 4)
--
-- Canonical medication/drug master. Three levels, deliberately separated:
--
--   medication            the concept   — generic name / molecule (+ATC class)
--   medication_ingredient composition   — active ingredients and strengths
--   medication_product    the thing you can actually buy — brand, manufacturer,
--                         dosage form, route, pack, and the REGULATORY facts
--                         that only make sense per jurisdiction.
--
-- Regulatory identity is a property of a product IN a jurisdiction, not of the
-- molecule: the same generic is registered separately (and may be approved in
-- one country and withdrawn in another). That is why jurisdiction, regulatory
-- authority, regulatory identifier and regulatory status live on the product.
--
-- LICENSING (§ data-source discipline): rows carry `source`, `source_version`,
-- `source_ref` and a `license_basis` naming the legal basis for holding the
-- data. Imports run through a registered provider (`medication_import_run`)
-- whose licence basis is declared in code, so a proprietary dataset cannot be
-- ingested by accident. This schema stores no proprietary dataset itself.
--
-- SEPARATION: this is drug *knowledge* (a data layer). It is NOT clinical
-- decision support and must not be used as such — that needs far stronger
-- validation and stays review-first (ARCHITECTURE §5.6).
-- ============================================================================

CREATE TABLE manufacturer (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  name                text NOT NULL,
  country             text,
  source              text NOT NULL,
  source_version      text,
  source_ref          text,
  jurisdiction        text NOT NULL,
  verification_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified','pending_review','verified','disputed','retired')),
  last_verified_at    timestamptz,
  confidence          numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_by          uuid REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_manufacturer_name ON manufacturer(clinic_id, lower(name));

-- ---------------------------------------------------------------------------
-- MEDICATION — the canonical concept (molecule or fixed combination).
-- ---------------------------------------------------------------------------
CREATE TABLE medication (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  generic_name        text NOT NULL,
  atc_code            text,                          -- WHO ATC (openly published)
  concept_type        text NOT NULL DEFAULT 'molecule'
                        CHECK (concept_type IN ('molecule','combination')),
  therapeutic_area    text,
  -- provenance + governance
  source              text NOT NULL,
  source_version      text,
  source_ref          text,
  license_basis       text NOT NULL DEFAULT 'manual_entry',
  jurisdiction        text NOT NULL,
  verification_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified','pending_review','verified','disputed','retired')),
  last_verified_at    timestamptz,
  confidence          numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  record_version      integer NOT NULL DEFAULT 1,
  is_active           boolean NOT NULL DEFAULT true,
  created_by          uuid REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medication_verified_has_evidence
    CHECK (verification_status <> 'verified' OR last_verified_at IS NOT NULL)
);
CREATE INDEX idx_medication_clinic ON medication(clinic_id);
CREATE INDEX idx_medication_atc ON medication(clinic_id, atc_code);
-- The same generic can legitimately exist once per jurisdiction (different
-- regulatory reality), never twice within one.
CREATE UNIQUE INDEX uq_medication_generic
  ON medication(clinic_id, jurisdiction, lower(generic_name));

CREATE TABLE medication_ingredient (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  medication_id      uuid NOT NULL REFERENCES medication(id) ON DELETE CASCADE,
  ingredient_name    text NOT NULL,
  strength_value     numeric(12,4),
  strength_unit      text,
  is_active_ingredient boolean NOT NULL DEFAULT true,
  source             text NOT NULL,
  source_version     text,
  last_verified_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_medication_ingredient
  ON medication_ingredient(medication_id, lower(ingredient_name));

-- ---------------------------------------------------------------------------
-- MEDICATION PRODUCT — the marketed, packaged, registered item.
-- ---------------------------------------------------------------------------
CREATE TABLE medication_product (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id              uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  medication_id          uuid NOT NULL REFERENCES medication(id) ON DELETE RESTRICT,
  brand_name             text NOT NULL,
  manufacturer_id        uuid REFERENCES manufacturer(id) ON DELETE SET NULL,
  dosage_form            text NOT NULL,              -- tablet, capsule, syrup, injection
  route                  text NOT NULL,              -- oral, intravenous, topical
  strength_text          text,                       -- '500 mg', '5 mg/ml'
  package_description    text,                       -- 'box of 2 strips x 10 tablets'
  package_size           integer CHECK (package_size IS NULL OR package_size > 0),
  package_unit           text,
  -- regulatory identity (per jurisdiction)
  jurisdiction           text NOT NULL,
  regulatory_authority   text,                       -- e.g. 'EDA', 'FDA', 'EMA'
  regulatory_identifier  text,                       -- registration/marketing number
  regulatory_status      text NOT NULL DEFAULT 'unknown'
                           CHECK (regulatory_status IN ('approved','pending','withdrawn','suspended','unknown')),
  approval_date          date,
  withdrawal_date        date,
  -- provenance + governance
  source                 text NOT NULL,
  source_version         text,
  source_ref             text,
  license_basis          text NOT NULL DEFAULT 'manual_entry',
  verification_status    text NOT NULL DEFAULT 'unverified'
                           CHECK (verification_status IN ('unverified','pending_review','verified','disputed','retired')),
  last_verified_at       timestamptz,
  confidence             numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  record_version         integer NOT NULL DEFAULT 1,
  is_active              boolean NOT NULL DEFAULT true,
  created_by             uuid REFERENCES app_user(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_withdrawal_after_approval
    CHECK (withdrawal_date IS NULL OR approval_date IS NULL OR withdrawal_date >= approval_date),
  CONSTRAINT product_verified_has_evidence
    CHECK (verification_status <> 'verified' OR last_verified_at IS NOT NULL)
);
CREATE INDEX idx_product_medication ON medication_product(medication_id);
CREATE INDEX idx_product_clinic_brand ON medication_product(clinic_id, lower(brand_name));
-- A registration number is unique within its jurisdiction when present.
CREATE UNIQUE INDEX uq_product_regulatory_id
  ON medication_product(clinic_id, jurisdiction, regulatory_identifier)
  WHERE regulatory_identifier IS NOT NULL;

-- ---------------------------------------------------------------------------
-- MEDICATION REVISION HISTORY — append-only, same contract as hcp_revision.
-- ---------------------------------------------------------------------------
CREATE TABLE medication_revision (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id       uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  medication_id   uuid NOT NULL REFERENCES medication(id) ON DELETE CASCADE,
  record_version  integer NOT NULL,
  change_type     text NOT NULL CHECK (change_type IN ('create','update','verify','status_change','import')),
  changed_fields  text[] NOT NULL DEFAULT '{}',
  snapshot        jsonb NOT NULL,
  source          text NOT NULL,
  source_version  text,
  changed_by      uuid REFERENCES app_user(id),
  changed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (medication_id, record_version)
);
CREATE INDEX idx_medication_revision ON medication_revision(medication_id, record_version);

CREATE TRIGGER trg_medication_revision_append_only
  BEFORE UPDATE OR DELETE ON medication_revision
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();

-- ---------------------------------------------------------------------------
-- IMPORT RUNS — the provider/import architecture. Every bulk load names the
-- provider, its version, the source reference and the licence basis, so data
-- can be traced, refreshed, or removed if a licence lapses (no vendor lock-in:
-- providers are pluggable and the schema is provider-neutral).
-- ---------------------------------------------------------------------------
CREATE TABLE medication_import_run (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  provider_key      text NOT NULL,                   -- registered provider id
  provider_version  text,
  source_ref        text,
  license_basis     text NOT NULL,
  jurisdiction      text NOT NULL,
  status            text NOT NULL DEFAULT 'started'
                      CHECK (status IN ('started','completed','failed')),
  records_created   integer NOT NULL DEFAULT 0,
  records_updated   integer NOT NULL DEFAULT 0,
  records_skipped   integer NOT NULL DEFAULT 0,
  error_message     text,
  started_by        uuid REFERENCES app_user(id),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);
CREATE INDEX idx_import_run_clinic ON medication_import_run(clinic_id, started_at DESC);
