-- ============================================================================
-- MEDCORE 0114_vital_observation_append_only  (Agent 2 — Clinical Platform)
--
-- Append-only integrity for recorded measurements.
--
-- `vital` (0100) and `observation` (0106) are recorded clinical facts: once a
-- measurement is written it is part of the patient record and must never be
-- edited or deleted in place. The service layer already treats both as
-- insert-only — there is no UPDATE or DELETE path anywhere in code — but the
-- database was not yet the last line of defence for them the way it is for
-- clinical notes, allergies, prescriptions and safety overrides.
--
-- This closes that gap: the same `medcore_append_only()` guard (0001) that
-- protects the other immutable clinical tables now fires BEFORE UPDATE OR DELETE
-- on `vital` and `observation`, raising rather than mutating. A correction to a
-- measurement is a new row (and, for observations, an entered-in-error record
-- via a fresh observation), never an edit of the original.
--
-- Additive and safe: no data change, no column change, purely a new guard on
-- tables that are already only ever inserted into.
-- ============================================================================

CREATE TRIGGER trg_vital_append_only
  BEFORE UPDATE OR DELETE ON vital
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();

CREATE TRIGGER trg_observation_append_only
  BEFORE UPDATE OR DELETE ON observation
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
