-- 0206: per-clinic WhatsApp (GOWA) connection STATE (Agent 3 range 0200-0299).
--
-- Records only the operational connection lifecycle of a clinic's WhatsApp
-- device: is it paired, when, a masked device number, and a generic last-error
-- code. It stores NO credentials (the GOWA basic-auth secret lives in the
-- process config / secret manager only), NO QR payloads (transient, never
-- persisted), and NO message bodies or recipients. Tenant-scoped by clinic_id.
CREATE TABLE whatsapp_connection (
  clinic_id       uuid PRIMARY KEY REFERENCES clinic(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'gowa',
  status          text NOT NULL DEFAULT 'disconnected'
                    CHECK (status IN ('disconnected','pairing','connected','error')),
  -- Masked device MSISDN once paired (e.g. "+20*****1234"); never the full number.
  phone_masked    text,
  -- Generic, non-PHI error code from the last lifecycle action (e.g.
  -- 'unreachable', 'unauthorized', 'not_paired'); never a raw provider message.
  last_error_code text,
  paired_at       timestamptz,
  last_status_at  timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
