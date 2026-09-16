-- ============================================================================
-- MEDCORE 0203_ai_action_kernel  (Agent 3 — AI Action Security Kernel, E4)
--
-- The persistence for a central, FAIL-CLOSED authorization boundary between an
-- AI actor and any tool/action that could mutate application state:
--
--   AI Identity → Tool → Tenant → Permission → Classification → Risk → Policy
--                → Human Confirmation → Execution
--
-- Principle: AI is an UNTRUSTED actor with an explicitly bounded identity,
-- scopes, risk ceiling and data ceiling. It never inherits a human role and
-- never implicitly gets ADMIN. The tool registry itself is code (deterministic,
-- unknown tools fail closed); only identities and the decision log are persisted.
--
-- No PHI is stored here. Reserved range for this workstream: 0200–0299.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- AI IDENTITY
-- An explicit, tenant-scoped execution identity for an AI capability/agent.
-- Its authority is expressed ONLY through `scopes` (an AI-specific vocabulary,
-- never human RBAC), a `risk_ceiling` and a `data_ceiling`. A fresh identity is
-- near-powerless by default (read-only risk, low data ceiling, no scopes).
-- ---------------------------------------------------------------------------
CREATE TABLE ai_identity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  agent_type    text NOT NULL,                    -- e.g. 'reception_assistant' (capability kind)
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  -- Highest risk class this identity may ever perform (fail-closed default).
  risk_ceiling  text NOT NULL DEFAULT 'read_only'
                  CHECK (risk_ceiling IN ('read_only','low_risk','medium_risk','high_risk')),
  -- Highest data classification this identity may touch (fail-closed default).
  data_ceiling  text NOT NULL DEFAULT 'internal'
                  CHECK (data_ceiling IN ('public','internal','operational','sensitive','phi','highly_restricted')),
  -- AI tool scopes granted to this identity (a vocabulary distinct from RBAC).
  scopes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by    uuid REFERENCES app_user(id),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- provenance; NEVER PHI
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, name)
);
CREATE INDEX idx_ai_identity_clinic ON ai_identity(clinic_id);

-- ---------------------------------------------------------------------------
-- AI ACTION LOG (append-only, tamper-evident)
-- One row per Action Guard decision. Records SHAPE ONLY — identity, tool, risk,
-- decision, reason — NEVER the tool arguments, patient data, prompt, or any PHI.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_action_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  request_id            uuid NOT NULL,
  identity_id           uuid,                       -- may be null when identity is unknown
  tool_id               text,
  access                text,                       -- 'read' | 'write'
  risk                  text,
  data_class            text,
  decision              text NOT NULL CHECK (decision IN ('allow','deny','require_confirmation')),
  reason_code           text NOT NULL,
  confirmation_required boolean NOT NULL DEFAULT false,
  executed              boolean NOT NULL DEFAULT false,
  created_by            uuid REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_action_log_clinic ON ai_action_log(clinic_id, created_at DESC);
CREATE INDEX idx_ai_action_log_request ON ai_action_log(request_id);

-- Append-only: the AI decision trail is tamper-evident (reuses 0001's guard fn).
CREATE TRIGGER trg_ai_action_log_append_only
  BEFORE UPDATE OR DELETE ON ai_action_log
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
