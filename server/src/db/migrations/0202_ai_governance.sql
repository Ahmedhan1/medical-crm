-- ============================================================================
-- MEDCORE 0202_ai_governance  (Agent 3 — AI Safety & Governance Layer)
--
-- The FRONT of the AI governance chain: data classification + a per-tenant
-- PHI/cloud policy that the AI gateway enforces so no AI request can bypass it.
--
--   AI request → classify input → tenant policy → provider routing decision
--
-- Safety invariants established here:
--   * Fail-closed by default: a clinic with NO policy row is treated as
--     "cloud NOT allowed" — every AI request runs on the LOCAL provider (on-box).
--   * PHI never leaves the box unless a clinic EXPLICITLY opts into cloud AI AND
--     raises its cloud data-class ceiling to include PHI. This is deliberate,
--     auditable configuration, never a default.
--
-- Reserved range for this workstream: 0200–0299.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- TENANT AI POLICY
-- Per-clinic control over whether AI inputs may be processed off-box (cloud)
-- and up to which data-classification ceiling. Absent row ⇒ fail-closed
-- (local-only), enforced in code.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_ai_policy (
  clinic_id        uuid PRIMARY KEY REFERENCES clinic(id) ON DELETE RESTRICT,
  -- Master switch: may this clinic use a cloud/off-box AI provider at all?
  allow_cloud      boolean NOT NULL DEFAULT false,
  -- The HIGHEST data class permitted to be sent to a cloud provider. Data more
  -- sensitive than this always stays local, even when allow_cloud is true.
  -- Defaults to 'operational' so that raising to PHI is a conscious act.
  cloud_max_class  text NOT NULL DEFAULT 'operational'
                     CHECK (cloud_max_class IN
                       ('public','internal','operational','sensitive','phi','highly_restricted')),
  updated_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- AI OBSERVABILITY: record the governance decision for every AI generation.
-- ai_generation is append-only; ADD COLUMN is DDL (allowed) — existing rows get
-- NULLs. These columns carry NO PHI: a classification label, a policy decision,
-- the provider tier, and a correlation id.
-- ---------------------------------------------------------------------------
ALTER TABLE ai_generation
  ADD COLUMN data_class      text,   -- classification of the AI input
  ADD COLUMN policy_decision text,   -- routing decision (allow_local/allow_cloud/deny)
  ADD COLUMN provider_tier   text,   -- 'local' | 'cloud'
  ADD COLUMN request_id      uuid;   -- correlation id for the AI request

CREATE INDEX idx_ai_generation_request ON ai_generation(request_id);
