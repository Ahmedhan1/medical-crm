-- ============================================================================
-- MEDCORE 0303_pharma_content  (Agent 4)
--
-- Governed scientific content + marketing foundations (segmentation, campaigns,
-- content distribution and engagement).
--
-- Content governance is the point of this table: promotional and scientific
-- material shown to an HCP is regulated, so a content record is only usable
-- when it has an accountable OWNER, a VERSION, a JURISDICTION, an APPROVAL
-- state with an approver, and a validity window (effective → expiry) with a
-- review date. `approved_content_revision` keeps the append-only history of
-- those decisions.
--
-- The asset itself is referenced by `storage_uri`; binaries do not live in the
-- database. No content record may reference patient data (§45).
-- ============================================================================

CREATE TABLE approved_content (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  title            text NOT NULL,
  summary          text,
  content_type     text NOT NULL
                     CHECK (content_type IN ('detail_aid','reprint','leave_behind','slide_deck',
                                             'video','faq','safety_update','other')),
  therapeutic_area text,
  medication_id    uuid REFERENCES medication(id) ON DELETE SET NULL,
  -- accountability + versioning
  owner_user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  version          text NOT NULL,
  jurisdiction     text NOT NULL,
  language         text,
  -- approval lifecycle
  approval_status  text NOT NULL DEFAULT 'draft'
                     CHECK (approval_status IN ('draft','in_review','approved','rejected','withdrawn')),
  approved_by      uuid REFERENCES app_user(id),
  approved_at      timestamptz,
  rejection_reason text,
  -- validity window
  effective_date   date,
  expiry_date      date,
  review_due_date  date,
  -- references
  external_ref     text,                             -- e.g. medical/legal review code
  storage_uri      text,
  source           text NOT NULL DEFAULT 'authored',
  source_version   text,
  record_version   integer NOT NULL DEFAULT 1,
  created_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_validity_window
    CHECK (expiry_date IS NULL OR effective_date IS NULL OR expiry_date >= effective_date),
  -- Approved material must record who approved it and when, and must declare
  -- the window in which it may be used.
  CONSTRAINT content_approved_has_approver
    CHECK (approval_status <> 'approved'
           OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND effective_date IS NOT NULL))
);
CREATE INDEX idx_content_clinic ON approved_content(clinic_id, approval_status);
CREATE INDEX idx_content_medication ON approved_content(medication_id);
CREATE UNIQUE INDEX uq_content_version
  ON approved_content(clinic_id, lower(title), version, jurisdiction);

-- Append-only audit history of content decisions (author → review → approve →
-- withdraw), independent of the generic audit log.
CREATE TABLE approved_content_revision (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id       uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  content_id      uuid NOT NULL REFERENCES approved_content(id) ON DELETE CASCADE,
  record_version  integer NOT NULL,
  change_type     text NOT NULL
                    CHECK (change_type IN ('create','update','submit_review','approve','reject','withdraw')),
  changed_fields  text[] NOT NULL DEFAULT '{}',
  snapshot        jsonb NOT NULL,
  note            text,
  changed_by      uuid REFERENCES app_user(id),
  changed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, record_version)
);
CREATE INDEX idx_content_revision ON approved_content_revision(content_id, record_version);

CREATE TRIGGER trg_content_revision_append_only
  BEFORE UPDATE OR DELETE ON approved_content_revision
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();

-- A scientific request is answered FROM approved content, never from ad-hoc
-- material — the link is added here now that the content table exists.
ALTER TABLE scientific_request
  ADD COLUMN answer_content_id uuid REFERENCES approved_content(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- SEGMENTATION — declarative HCP segments plus their resolved membership.
-- ---------------------------------------------------------------------------
CREATE TABLE hcp_segment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  key          text NOT NULL,
  name         text NOT NULL,
  description  text,
  -- Declarative criteria (specialty / territory / tier / interest). Stored as
  -- data so a segment can be re-resolved later and explained to a reviewer.
  definition   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, key)
);

CREATE TABLE hcp_segment_member (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  segment_id       uuid NOT NULL REFERENCES hcp_segment(id) ON DELETE CASCADE,
  hcp_id           uuid NOT NULL REFERENCES hcp(id) ON DELETE CASCADE,
  assignment_basis text NOT NULL DEFAULT 'manual'
                     CHECK (assignment_basis IN ('manual','rule')),
  assigned_by      uuid REFERENCES app_user(id),
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, segment_id, hcp_id)
);
CREATE INDEX idx_segment_member_hcp ON hcp_segment_member(hcp_id);

-- ---------------------------------------------------------------------------
-- CAMPAIGNS — a targeted engagement programme over a segment.
-- ---------------------------------------------------------------------------
CREATE TABLE campaign (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  code           text NOT NULL,
  name           text NOT NULL,
  objective      text,
  campaign_type  text NOT NULL DEFAULT 'detailing'
                   CHECK (campaign_type IN ('detailing','digital','event','education','launch')),
  medication_id  uuid REFERENCES medication(id) ON DELETE SET NULL,
  segment_id     uuid REFERENCES hcp_segment(id) ON DELETE SET NULL,
  jurisdiction   text NOT NULL,
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','active','paused','completed','cancelled')),
  start_date     date,
  end_date       date,
  owner_user_id  uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  created_by     uuid REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, code),
  CONSTRAINT campaign_dates_ordered CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE TABLE campaign_target (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  campaign_id   uuid NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  hcp_id        uuid NOT NULL REFERENCES hcp(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','reached','engaged','opted_out','excluded')),
  last_touch_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, campaign_id, hcp_id)
);
CREATE INDEX idx_campaign_target_hcp ON campaign_target(hcp_id);

-- ---------------------------------------------------------------------------
-- CONTENT ENGAGEMENT — distribution and measured engagement. This is the HCP
-- engagement signal pharma legitimately owns (as opposed to clinical data).
-- ---------------------------------------------------------------------------
CREATE TABLE content_engagement (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  content_id       uuid NOT NULL REFERENCES approved_content(id) ON DELETE RESTRICT,
  hcp_id           uuid NOT NULL REFERENCES hcp(id) ON DELETE CASCADE,
  visit_id         uuid REFERENCES visit(id) ON DELETE SET NULL,
  campaign_id      uuid REFERENCES campaign(id) ON DELETE SET NULL,
  channel          text NOT NULL DEFAULT 'in_person'
                     CHECK (channel IN ('in_person','email','whatsapp','portal','event')),
  engagement_type  text NOT NULL DEFAULT 'presented'
                     CHECK (engagement_type IN ('presented','shared','opened','viewed','downloaded','discussed')),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  recorded_by      uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_engagement_content ON content_engagement(content_id, occurred_at DESC);
CREATE INDEX idx_engagement_hcp ON content_engagement(hcp_id, occurred_at DESC);
CREATE INDEX idx_engagement_campaign ON content_engagement(campaign_id);
