-- ============================================================================
-- MEDCORE 0108_document_reference  (Agent 2 — Clinical Platform, Phase 9)
--
-- Clinical document management, FHIR DocumentReference-shaped.
--
-- METADATA ONLY — the document BYTES are NOT stored here. A DocumentReference is
-- a pointer to content (FHIR content.attachment.url), not the content. Storing
-- blobs in Postgres bloats the clinical database and is a local-first storage
-- decision that belongs to the platform owner, not this workstream — filed as
-- CCR-008. `storage_key` is an opaque reference the infrastructure resolves to
-- the actual bytes; the integrity columns let a resolver verify what it fetched.
-- This keeps document CONTENT out of the database entirely, and therefore out
-- of logs, backups-of-the-clinical-DB, and every query in this system.
-- ============================================================================

CREATE TABLE document_reference (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id     uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  -- Optional context links. A document is always about a patient; it may also
  -- belong to a specific visit or a longitudinal treatment episode.
  encounter_id   uuid REFERENCES encounter(id) ON DELETE SET NULL,
  episode_id     uuid REFERENCES treatment_episode(id) ON DELETE SET NULL,

  doc_type       text NOT NULL CHECK (doc_type IN
                   ('lab_report','imaging_report','referral','consent','prescription',
                    'discharge_summary','clinical_photo','external_record','invoice','other')),
  title          text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  -- MIME type of the referenced content, e.g. 'application/pdf'.
  content_type   text NOT NULL CHECK (content_type ~ '^[-a-z]+/[-.+a-z0-9]+$'),
  -- Opaque pointer to where the bytes live. NOT the bytes.
  storage_key    text NOT NULL CHECK (length(btrim(storage_key)) BETWEEN 1 AND 512),
  size_bytes     bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  -- Lowercase hex SHA-256 of the content, for integrity verification.
  checksum_sha256 text CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),

  -- Access policy. A 'restricted' document needs an elevated read permission.
  confidentiality text NOT NULL DEFAULT 'normal'
                    CHECK (confidentiality IN ('normal','restricted')),

  -- Versioning. A new version SUPERSEDES the old; the old is kept (audit/legal),
  -- never deleted or edited in place.
  status         text NOT NULL DEFAULT 'current'
                   CHECK (status IN ('current','superseded','entered_in_error')),
  supersedes_id  uuid REFERENCES document_reference(id) ON DELETE SET NULL,

  uploaded_by    uuid NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_document_patient ON document_reference(clinic_id, patient_id, created_at DESC);
CREATE INDEX idx_document_encounter ON document_reference(encounter_id, created_at DESC)
  WHERE encounter_id IS NOT NULL;
CREATE INDEX idx_document_episode ON document_reference(episode_id, created_at DESC)
  WHERE episode_id IS NOT NULL;
-- A given stored object is referenced once; prevents accidental double-register.
CREATE UNIQUE INDEX uq_document_storage_key ON document_reference(clinic_id, storage_key);
