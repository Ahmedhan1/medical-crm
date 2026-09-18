-- ============================================================================
-- MEDCORE 0312_pharma_export_log  (Agent 4 — Pharma reporting/export)
--
-- Bulk export is the highest-risk read in the platform: the data leaves the
-- system, it is rarely re-checked afterwards, and the person who took it is
-- often the only record that it happened. So every export writes an append-only
-- receipt here BEFORE the rows are returned.
--
-- WHAT THIS RECORDS: who exported, which registered report, in which format,
-- the filters they used, how many rows they got and the cap that applied.
--
-- WHAT IT DELIBERATELY DOES NOT RECORD: the rows themselves, or any free text
-- from them. An audit trail that copies the payload is a second copy of the
-- data with the same disclosure risk and none of the access control — the same
-- rule that keeps PHI out of `audit_log.metadata`.
-- ============================================================================

CREATE TABLE pharma_export_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  actor_id      uuid REFERENCES app_user(id),
  report_key    text NOT NULL,
  data_class    text NOT NULL
                  CHECK (data_class IN ('aggregate', 'hcp_professional', 'commercial')),
  format        text NOT NULL CHECK (format IN ('json', 'csv')),
  -- Filter SHAPE only (report key, date range, scope ids) — never row content.
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Territory ids the export was confined to; empty means the caller was
  -- clinic-wide (a steward or manager), which is itself worth recording.
  territory_ids text[] NOT NULL DEFAULT '{}',
  row_count     integer NOT NULL CHECK (row_count >= 0),
  row_limit     integer NOT NULL CHECK (row_limit > 0),
  /**
   * True when the cap clipped the result. A truncated export is a different
   * artefact from a complete one and the receipt has to say which it was.
   */
  truncated     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pharma_export_actor
  ON pharma_export_log (clinic_id, actor_id, created_at DESC);
CREATE INDEX idx_pharma_export_report
  ON pharma_export_log (clinic_id, report_key, created_at DESC);

-- Tamper-evidence, same contract as `event`, `audit_log` and
-- `intelligence_query_log`: a principal must not be able to erase the record of
-- what they took.
CREATE TRIGGER trg_pharma_export_log_append_only
  BEFORE UPDATE OR DELETE ON pharma_export_log
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
