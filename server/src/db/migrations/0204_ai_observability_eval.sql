-- ============================================================================
-- MEDCORE 0204_ai_observability_eval  (Agent 3 — E5 batch)
--
-- Extends AI observability with failure/retry telemetry + structured-output
-- validation status + prompt/schema versions, and adds a PHI-free evaluation
-- ledger. All additions carry labels/sizes/versions only — NEVER prompts,
-- outputs, variables, secrets, or PHI. Reserved range: 0200–0299.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ai_generation: failure/retry + structured-output governance telemetry.
-- Append-only via ADD COLUMN; existing rows get NULL. No PHI.
-- ---------------------------------------------------------------------------
ALTER TABLE ai_generation
  ADD COLUMN attempt           int,     -- attempt number (1-based)
  ADD COLUMN retryable         boolean, -- was the failure transient/retryable
  ADD COLUMN failure_stage     text,    -- 'transcribe' | 'generate' | 'validate' | null
  ADD COLUMN validation_status text,    -- 'valid' | 'invalid' | 'skipped' | null
  ADD COLUMN schema_version    text,    -- output schema version applied
  ADD COLUMN prompt_version    text;    -- prompt version used

-- ---------------------------------------------------------------------------
-- ai_eval_run: a ledger of AI evaluation runs over DETERMINISTIC, DE-IDENTIFIED
-- fixtures. The stored `report` contains only fixture ids + numeric scores +
-- provider/model metadata — never fixture text, prompts, outputs or PHI.
-- Tenant-scoped by the clinic whose admin ran the eval. Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_eval_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  suite          text NOT NULL,                 -- 'intake' | 'summary'
  provider       text NOT NULL,
  model          text,
  total          int NOT NULL,
  passed         int NOT NULL,
  failed         int NOT NULL,
  avg_latency_ms numeric,
  report         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- ids + scores only; NO PHI
  created_by     uuid REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_eval_run_clinic ON ai_eval_run(clinic_id, created_at DESC);

CREATE TRIGGER trg_ai_eval_run_append_only
  BEFORE UPDATE OR DELETE ON ai_eval_run
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
