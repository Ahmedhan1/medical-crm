-- ============================================================================
-- MEDCORE 0901_backup  (Platform / Agent 1)
--
-- Backup & restore ledger. Reserved platform range 0900–0999.
--
-- `backup_run` is an INSTANCE-level operational ledger (one MEDCORE BOX backs up
-- its whole database, spanning all clinics), so it is intentionally NOT clinic
-- scoped — it is on the governance test's global-table allowlist.
--
-- It records metadata ONLY: filename, size, checksum, status, counts, timings.
-- It never stores PHI, a database credential, or an encryption key.
-- ============================================================================

CREATE TABLE backup_run (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL DEFAULT 'manual'
                       CHECK (kind IN ('manual','scheduled')),
  status             text NOT NULL DEFAULT 'in_progress'
                       CHECK (status IN ('in_progress','completed','failed','verified')),
  filename           text,                       -- basename only, never a full external path
  byte_size          bigint,
  checksum_sha256    text,                       -- integrity fingerprint of the artifact
  encrypted          boolean NOT NULL DEFAULT false,
  migrations_applied integer,                    -- schema_migrations count at backup time
  table_count        integer,                    -- public base-table count at backup time
  error              text,                       -- safe, non-PHI failure summary
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  verified_at        timestamptz,
  created_by         uuid REFERENCES app_user(id) -- null for CLI/scheduled runs
);

CREATE INDEX ix_backup_run_started ON backup_run(started_at DESC);
CREATE INDEX ix_backup_run_status ON backup_run(status, started_at DESC);
