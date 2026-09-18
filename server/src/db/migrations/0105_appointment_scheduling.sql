-- ============================================================================
-- MEDCORE 0105_appointment_scheduling  (Agent 2 — Clinical Platform, Phase 2)
--
-- The scheduling engine: bookable resources, configurable appointment types,
-- appointments with an explicit state machine, and an append-only transition
-- ledger.
--
-- DEPLOYMENT NOTE: requires the `btree_gist` contrib extension, used for the
-- room double-booking constraint below. It ships with standard PostgreSQL and
-- is created here; a deployment whose database role cannot CREATE EXTENSION
-- must have a DBA enable it before migrating.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- CLINICAL_RESOURCE — anything an appointment can occupy: a room, a chair, a
-- machine. One table rather than one per kind, because the scheduling rule is
-- identical for all of them (a physical thing holds one appointment at a time)
-- and Phase 6 needs the same abstraction for procedure equipment.
--
-- This is deliberately NOT an org hierarchy. Organization → Location →
-- Department is foundation-owned; a resource here is simply a bookable thing
-- belonging to a clinic, and can gain a department link when that model lands.
-- ---------------------------------------------------------------------------
CREATE TABLE clinical_resource (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  kind        text NOT NULL CHECK (kind IN ('room','chair','equipment','other')),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  code        text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_clinical_resource_name
  ON clinical_resource(clinic_id, kind, lower(name));
CREATE UNIQUE INDEX uq_clinical_resource_code
  ON clinical_resource(clinic_id, code) WHERE code IS NOT NULL;
CREATE INDEX idx_clinical_resource_clinic ON clinical_resource(clinic_id, kind, is_active);

-- ---------------------------------------------------------------------------
-- APPOINTMENT_TYPE — configuration, not code. A new visit kind is a row, not a
-- deployment; this is the first of the Phase-18 specialty-configuration
-- primitives.
-- ---------------------------------------------------------------------------
CREATE TABLE appointment_type (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  key                      text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,48}$'),
  name                     text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  default_duration_minutes integer NOT NULL CHECK (default_duration_minutes BETWEEN 5 AND 480),
  is_active                boolean NOT NULL DEFAULT true,
  created_by               uuid NOT NULL REFERENCES app_user(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, key)
);
CREATE INDEX idx_appointment_type_clinic ON appointment_type(clinic_id, is_active);

-- ---------------------------------------------------------------------------
-- APPOINTMENT
--
-- Lifecycle (enforced as an allow-list in the service, recorded here):
--   scheduled → confirmed | cancelled | no_show
--   confirmed → arrived   | cancelled | no_show
--   arrived   → waiting | in_consultation | left_without_being_seen | cancelled
--   waiting   → in_consultation | left_without_being_seen | cancelled
--   in_consultation → completed
--   completed / cancelled / no_show / left_without_being_seen are terminal.
--
-- `in_consultation` and `completed` are NOT set directly: they follow the
-- linked encounter, which is the clinical source of truth for what actually
-- happened. One fact, one owner.
-- ---------------------------------------------------------------------------
CREATE TABLE appointment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id            uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id           uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  appointment_type_id  uuid REFERENCES appointment_type(id) ON DELETE RESTRICT,
  practitioner_id      uuid REFERENCES app_user(id),
  resource_id          uuid REFERENCES clinical_resource(id) ON DELETE RESTRICT,
  -- The visit this appointment produced, set when the patient arrives.
  encounter_id         uuid REFERENCES encounter(id) ON DELETE SET NULL,

  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,

  status               text NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled','confirmed','arrived','waiting',
                                           'in_consultation','completed','cancelled',
                                           'no_show','left_without_being_seen')),
  priority             text NOT NULL DEFAULT 'routine'
                         CHECK (priority IN ('routine','urgent','emergency')),
  -- A walk-in is an appointment created at the desk; the lifecycle is the same.
  origin               text NOT NULL DEFAULT 'booked'
                         CHECK (origin IN ('booked','walk_in')),
  reason               text,

  arrived_at           timestamptz,
  closed_at            timestamptz,
  closed_by            uuid REFERENCES app_user(id),
  closure_reason       text,

  created_by           uuid NOT NULL REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_appointment_window CHECK (ends_at > starts_at),
  -- A closed appointment records when and by whom; an open one does not.
  CONSTRAINT ck_appointment_closed CHECK (
    (status IN ('completed','cancelled','no_show','left_without_being_seen'))
      = (closed_at IS NOT NULL)
  ),
  -- Arrival is what produces an encounter, so the two travel together.
  CONSTRAINT ck_appointment_arrival CHECK (
    (arrived_at IS NULL) OR
    (status IN ('arrived','waiting','in_consultation','completed','left_without_being_seen'))
  )
);
-- The day view: what is on, for this clinic, in this window.
CREATE INDEX idx_appointment_schedule ON appointment(clinic_id, starts_at, status);
CREATE INDEX idx_appointment_practitioner
  ON appointment(clinic_id, practitioner_id, starts_at)
  WHERE practitioner_id IS NOT NULL;
CREATE INDEX idx_appointment_patient ON appointment(clinic_id, patient_id, starts_at DESC);
CREATE UNIQUE INDEX uq_appointment_encounter
  ON appointment(encounter_id) WHERE encounter_id IS NOT NULL;

/*
 * A room cannot hold two patients at once. That is a physical fact, so it is a
 * database constraint rather than a service check — no code path, now or later,
 * can book over it.
 *
 * Practitioner overlap is deliberately NOT constrained here: clinics overbook a
 * doctor's list on purpose. That is a policy decision, enforced in the service
 * with an explicit, audited override, not a physical impossibility.
 *
 * Only live appointments reserve the room; cancelled, no-show and completed
 * ones release it.
 */
ALTER TABLE appointment ADD CONSTRAINT ex_appointment_resource
  EXCLUDE USING gist (
    clinic_id WITH =,
    resource_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (
    resource_id IS NOT NULL
    AND status IN ('scheduled','confirmed','arrived','waiting','in_consultation')
  );

-- ---------------------------------------------------------------------------
-- APPOINTMENT_STATUS_HISTORY — every transition, append-only. "All state
-- transitions must be auditable" is a storage guarantee here, not a convention.
-- ---------------------------------------------------------------------------
CREATE TABLE appointment_status_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  appointment_id  uuid NOT NULL REFERENCES appointment(id) ON DELETE CASCADE,
  from_status     text,
  to_status       text NOT NULL,
  reason          text,
  actor_id        uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointment_history ON appointment_status_history(appointment_id, created_at);

CREATE TRIGGER trg_appointment_history_append_only
  BEFORE UPDATE OR DELETE ON appointment_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
