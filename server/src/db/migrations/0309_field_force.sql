-- ============================================================================
-- MEDCORE 0309_field_force  (Agent 4 — Pharma / Field Force)
--
-- FIELD FORCE HARDENING. Three gaps found by audit of 0302:
--
--  1. A "representative" was nothing but an `app_user` id on
--     `territory_assignment` and `visit`. There was no field profile, no rep
--     grade, no employment window and — critically — NO MANAGER HIERARCHY. A
--     district manager could therefore only be given visibility by handing them
--     `territory:manage`, which is clinic-wide. Authorisation had no way to say
--     "the people who report to me", so it said "everyone" instead.
--  2. A visit changed status by UPDATE, in place. The previous status was
--     overwritten and the reason for the change was squeezed into a single
--     mutable `outcome_reason` column. A completed call could be silently
--     reverted and nothing would remember it had ever been completed.
--  3. A visit could only be an in-person call on a named individual. There was
--     no MODALITY (a virtual call and a congress meeting are not the same
--     interaction) and no way to record an INSTITUTIONAL visit — a call on a
--     hospital pharmacy committee names an HCO, not an HCP.
--
-- Everything here is additive. `visit.hcp_id` is relaxed from NOT NULL to a
-- CHECK that at least one subject is named, which admits every existing row.
--
-- GOVERNANCE BOUNDARY (§45): no table here references any clinical entity.
-- Everything is keyed on `app_user`, `territory`, `hcp` and `hco`. New free-text
-- columns (`employee_ref`, `region`, transition `reason`) are screened by
-- `modules/pharma/guards.ts` before they can be stored.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- FIELD REP PROFILE — who a field user actually is, and who they report to.
--
-- Kept SEPARATE from `app_user` on purpose: `app_user` is an authentication
-- identity owned by the platform workstream, while this is field-force master
-- data owned by pharma. A user may exist without a field profile (medical
-- affairs, a steward) and a field profile never grants a permission — it is
-- read by authorisation as a SCOPE, never as a right.
--
-- `manager_user_id` references `app_user` rather than this table so a manager
-- can be modelled before their own profile exists, and so deleting a profile
-- cannot orphan a chain. The hierarchy is walked with a depth cap and cycle
-- protection in `modules/pharma/hierarchy.ts`; the CHECK below only refuses the
-- degenerate one-step case, because SQL cannot express "no cycle of any length".
-- ---------------------------------------------------------------------------
CREATE TABLE field_rep_profile (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  user_id          uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  employee_ref     text,
  rep_role         text NOT NULL DEFAULT 'representative'
                     CHECK (rep_role IN ('representative','senior_representative',
                                         'district_manager','regional_manager')),
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','on_leave','inactive')),
  manager_user_id  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  region           text,
  start_date       date NOT NULL DEFAULT current_date,
  end_date         date,
  created_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- One field profile per user per clinic. The field force is not a role the
  -- same person can hold twice.
  UNIQUE (clinic_id, user_id),
  CONSTRAINT field_rep_profile_dates
    CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT field_rep_profile_not_self_managed
    CHECK (manager_user_id IS NULL OR manager_user_id <> user_id)
);
-- Employee references are an HR key: unique where present, case-insensitively.
CREATE UNIQUE INDEX uq_field_rep_profile_employee_ref
  ON field_rep_profile (clinic_id, lower(employee_ref))
  WHERE employee_ref IS NOT NULL;
-- Drives the recursive hierarchy walk (one lookup per level).
CREATE INDEX idx_field_rep_profile_manager
  ON field_rep_profile (clinic_id, manager_user_id);
CREATE INDEX idx_field_rep_profile_status
  ON field_rep_profile (clinic_id, status, rep_role);

-- ---------------------------------------------------------------------------
-- VISIT MODALITY — how the interaction happened.
--
-- Defaulted to `face_to_face` because every row that exists today was created
-- through a face-to-face-shaped API. The default is a migration convenience,
-- not a modelling opinion: the service asks for it explicitly.
--
-- `institutional` is the modality that pairs with an HCO-only visit below.
-- ---------------------------------------------------------------------------
ALTER TABLE visit
  ADD COLUMN modality text NOT NULL DEFAULT 'face_to_face'
    CHECK (modality IN ('face_to_face','virtual','phone','conference',
                        'scientific_meeting','institutional'));
CREATE INDEX idx_visit_modality ON visit (clinic_id, modality, planned_at);

-- ---------------------------------------------------------------------------
-- INSTITUTIONAL VISITS — a call on an organisation, with no named individual.
--
-- `hcp_id` is relaxed to nullable and replaced by a subject CHECK: a visit must
-- name an HCP, an HCO, or both. Every existing row names an HCP and therefore
-- satisfies the new constraint unchanged; nothing is rewritten.
-- ---------------------------------------------------------------------------
ALTER TABLE visit ALTER COLUMN hcp_id DROP NOT NULL;
ALTER TABLE visit ADD CONSTRAINT visit_has_subject
  CHECK (hcp_id IS NOT NULL OR hco_id IS NOT NULL);
CREATE INDEX idx_visit_hco ON visit (clinic_id, hco_id, planned_at)
  WHERE hco_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- VISIT EVENT — the append-only lifecycle history of a visit.
--
-- `visit.status` remains the current state (cheap to query); this table is the
-- record of HOW it got there. It is append-only by trigger, so a status change
-- cannot be un-written: reverting a completed call, if ever permitted, would
-- leave both transitions visible.
--
-- `from_status` is NULL for the birth event of a visit.
-- ---------------------------------------------------------------------------
CREATE TABLE visit_event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id    uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  visit_id     uuid NOT NULL REFERENCES visit(id) ON DELETE RESTRICT,
  from_status  text CHECK (from_status IS NULL OR from_status IN
                 ('planned','confirmed','completed','cancelled','no_access')),
  to_status    text NOT NULL CHECK (to_status IN
                 ('planned','confirmed','completed','cancelled','no_access')),
  reason       text,
  actor_id     uuid REFERENCES app_user(id),
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_visit_event_visit ON visit_event (visit_id, occurred_at);
CREATE INDEX idx_visit_event_clinic_time ON visit_event (clinic_id, occurred_at);

CREATE TRIGGER trg_visit_event_append_only
  BEFORE UPDATE OR DELETE ON visit_event
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();

-- ---------------------------------------------------------------------------
-- CALL REPORTS FOLLOW THE VISIT'S SUBJECT.
--
-- Making a visit institutional (above) without doing the same to its report
-- would have shipped half a feature: the rep could plan and complete a hospital
-- call and then be unable to report on it, because `call_report.hcp_id` was
-- NOT NULL. The report now carries the same subject rule as the visit it
-- belongs to — at least one of an HCP or an organisation, never neither.
--
-- `hco_id` is denormalised onto the report deliberately: the per-HCP and
-- per-organisation report queries are the hot path for field reporting, and
-- joining back through `visit` for every one of them buys nothing.
-- ---------------------------------------------------------------------------
ALTER TABLE call_report ALTER COLUMN hcp_id DROP NOT NULL;
ALTER TABLE call_report
  ADD COLUMN hco_id uuid REFERENCES hco(id) ON DELETE RESTRICT,
  ADD CONSTRAINT call_report_has_subject
    CHECK (hcp_id IS NOT NULL OR hco_id IS NOT NULL);
CREATE INDEX idx_call_report_hco ON call_report (clinic_id, hco_id, submitted_at DESC)
  WHERE hco_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- THE REPORT'S CHILDREN FOLLOW THE REPORT'S SUBJECT.
--
-- `visit_objection`, `call_report_competitor` and `follow_up_action` all
-- required an HCP. On an institutional call there is no HCP, so a rep could
-- record that a hospital's procurement office raised a price objection or owed
-- them a document — and then be unable to store either. The asymmetry was
-- arbitrary: all three hang off a call report, and a call report now knows its
-- own subject.
--
-- Each keeps a subject CHECK rather than simply dropping NOT NULL, so a row
-- belonging to nobody stays impossible.
-- ---------------------------------------------------------------------------
ALTER TABLE visit_objection ALTER COLUMN hcp_id DROP NOT NULL;
ALTER TABLE visit_objection
  ADD COLUMN hco_id uuid REFERENCES hco(id) ON DELETE RESTRICT,
  ADD CONSTRAINT visit_objection_has_subject
    CHECK (hcp_id IS NOT NULL OR hco_id IS NOT NULL);

ALTER TABLE call_report_competitor ALTER COLUMN hcp_id DROP NOT NULL;
ALTER TABLE call_report_competitor
  ADD COLUMN hco_id uuid REFERENCES hco(id) ON DELETE RESTRICT,
  ADD CONSTRAINT call_report_competitor_has_subject
    CHECK (hcp_id IS NOT NULL OR hco_id IS NOT NULL);

ALTER TABLE follow_up_action ALTER COLUMN hcp_id DROP NOT NULL;
ALTER TABLE follow_up_action
  ADD COLUMN hco_id uuid REFERENCES hco(id) ON DELETE RESTRICT,
  ADD CONSTRAINT follow_up_action_has_subject
    CHECK (hcp_id IS NOT NULL OR hco_id IS NOT NULL);
CREATE INDEX idx_follow_up_hco ON follow_up_action (clinic_id, hco_id, due_date DESC)
  WHERE hco_id IS NOT NULL;
