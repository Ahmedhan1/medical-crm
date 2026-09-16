-- ============================================================================
-- MEDCORE 0200_automation  (Agent 3 — AI / Automation / WhatsApp)
--
-- The reusable platform layer for:
--   * Automation engine   (event → conditions → actions, idempotent, audited)
--   * Messaging            (provider-abstracted, consent-gated, retryable sends)
--   * Review-first AI      (drafts requiring human confirmation; never auto-write)
--
-- Design invariants (see AGENTS.md, docs/workstreams/ai-automation.md):
--   * Every tenant row carries clinic_id; timestamps are timestamptz.
--   * No PHI ever lands in message_log or ai_generation — those record the
--     FACT/shape of a communication or AI call, never its rendered content,
--     recipient address, or prompt/response text.
--   * AI output is a DRAFT; confirming it is a human action that does not, by
--     itself, mutate any clinical record.
--   * Idempotency is enforced in the database (unique keys), not just in code.
-- Reserved migration range for this workstream: 0200–0299.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- MESSAGING: consent / preferences
-- A message may only be sent on a channel the patient has opted into.
-- ---------------------------------------------------------------------------
CREATE TABLE communication_consent (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id  uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  status      text NOT NULL DEFAULT 'unknown'
                CHECK (status IN ('opted_in','opted_out','unknown')),
  updated_by  uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, patient_id, channel)
);
CREATE INDEX idx_consent_patient ON communication_consent(clinic_id, patient_id);

-- ---------------------------------------------------------------------------
-- MESSAGING: templates
-- Approved, localized copy with {{variable}} placeholders. Only variables the
-- template declares are substituted, so a template cannot smuggle arbitrary PHI.
-- ---------------------------------------------------------------------------
CREATE TABLE message_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  key         text NOT NULL,                    -- e.g. 'appointment_reminder'
  channel     text NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  locale      text NOT NULL DEFAULT 'en',
  body        text NOT NULL,                    -- approved copy with {{vars}}
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, key, channel, locale)
);

-- ---------------------------------------------------------------------------
-- MESSAGING: outbound message record (delivery tracking / retry / dead-letter)
-- Records the FACT and STATUS of a send only. NEVER the rendered body, NEVER
-- the raw recipient address — recipient is masked, content is referenced by
-- template_key. This keeps the operational log free of PHI.
-- ---------------------------------------------------------------------------
CREATE TABLE message_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id        uuid REFERENCES patient(id) ON DELETE SET NULL,
  channel           text NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  provider          text NOT NULL,              -- provider id that handled it
  template_key      text,                       -- which approved template (no body)
  locale            text NOT NULL DEFAULT 'en', -- template locale (for deterministic re-render on retry)
  recipient_masked  text,                       -- e.g. '+20*******7890'; never full
  status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','sent','delivered','failed','suppressed','dead')),
  suppressed_reason text,                        -- e.g. 'no_consent','no_recipient'
  provider_ref      text,                        -- provider message id (status callbacks)
  attempts          int  NOT NULL DEFAULT 0,
  max_attempts      int  NOT NULL DEFAULT 5,
  next_attempt_at   timestamptz,
  last_error        text,
  idempotency_key   text,                        -- at-most-once send guard
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- NULL idempotency_key is allowed and non-unique (ad-hoc sends); a provided
  -- key is unique per clinic so a retry never double-sends.
  UNIQUE (clinic_id, idempotency_key)
);
CREATE INDEX idx_message_log_status ON message_log(clinic_id, status, next_attempt_at);
CREATE INDEX idx_message_log_patient ON message_log(clinic_id, patient_id);
CREATE UNIQUE INDEX uq_message_provider_ref
  ON message_log(provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- AUTOMATION: rules (event → conditions → actions), stored as data
-- ---------------------------------------------------------------------------
CREATE TABLE automation_rule (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  name          text NOT NULL,
  description   text,
  trigger_type  text NOT NULL CHECK (trigger_type IN ('event','schedule')),
  event_type    text,                            -- required for trigger_type='event'
  schedule_cron text,                            -- required for trigger_type='schedule'
  conditions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions       jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_enabled    boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_trigger_shape CHECK (
    (trigger_type = 'event'    AND event_type    IS NOT NULL) OR
    (trigger_type = 'schedule' AND schedule_cron IS NOT NULL)
  )
);
CREATE INDEX idx_automation_rule_event
  ON automation_rule(clinic_id, event_type) WHERE is_enabled;

-- ---------------------------------------------------------------------------
-- AUTOMATION: execution history
-- One row per (rule, trigger). UNIQUE(rule_id, dedupe_key) is the database-level
-- guarantee that a rule fires AT MOST ONCE per triggering event (idempotency);
-- a re-processed event or a concurrent worker cannot double-execute actions.
-- ---------------------------------------------------------------------------
CREATE TABLE automation_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  rule_id          uuid NOT NULL REFERENCES automation_rule(id) ON DELETE CASCADE,
  trigger_event_id bigint,                        -- event.id (null for schedule)
  dedupe_key       text NOT NULL,                 -- 'evt:<id>' or 'sched:<slot>'
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','succeeded','failed','skipped')),
  matched          boolean NOT NULL DEFAULT true, -- did the conditions pass
  attempts         int NOT NULL DEFAULT 0,
  action_results   jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error       text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (rule_id, dedupe_key)
);
CREATE INDEX idx_automation_run_rule ON automation_run(rule_id, started_at DESC);

-- Global processing offset into the append-only event store. The engine reads
-- events with id > last_event_id; it NEVER writes triggers into `event` itself.
CREATE TABLE automation_offset (
  name           text PRIMARY KEY,
  last_event_id  bigint NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- AI: review-first drafts
-- AI output is ALWAYS a draft. A human confirms it before it can influence any
-- authoritative record; confirmation here does not itself write clinical data.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_draft (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  kind          text NOT NULL
                  CHECK (kind IN ('intake','summary','call_report','clinical_note')),
  subject_type  text NOT NULL,                    -- e.g. 'patient','encounter'
  subject_id    uuid NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','confirmed','rejected')),
  content       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- structured draft
  citations     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- source refs it is grounded in
  provider      text NOT NULL,
  model         text,
  created_by    uuid REFERENCES app_user(id),
  reviewed_by   uuid REFERENCES app_user(id),
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_draft_subject ON ai_draft(clinic_id, subject_type, subject_id);
CREATE INDEX idx_ai_draft_status  ON ai_draft(clinic_id, status);

-- ---------------------------------------------------------------------------
-- AI: observability / audit (append-only, tamper-evident)
-- One row per generation call. Records shape only — provider, model, latency,
-- sizes, grounded-source count — NEVER the prompt, response, or any PHI.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_generation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  draft_id      uuid REFERENCES ai_draft(id) ON DELETE SET NULL,
  kind          text NOT NULL,
  provider      text NOT NULL,
  model         text,
  status        text NOT NULL CHECK (status IN ('succeeded','failed')),
  input_chars   int,                              -- size only, not content
  output_chars  int,
  source_count  int,                              -- grounded sources supplied
  latency_ms    int,
  error_code    text,
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_generation_clinic ON ai_generation(clinic_id, created_at DESC);

-- The AI audit trail is append-only for tamper-evidence (reuses the shared
-- guard function from 0001_core).
CREATE TRIGGER trg_ai_generation_append_only
  BEFORE UPDATE OR DELETE ON ai_generation
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
