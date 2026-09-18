import { getPool, type PoolClient } from '../../db/pool.js';

/** Row access for the scheduling engine (migration 0105). */

type Runner = Pick<PoolClient, 'query'>;

export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'arrived'
  | 'waiting'
  | 'in_consultation'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'left_without_being_seen';

export type ResourceKind = 'room' | 'chair' | 'equipment' | 'other';

// ---------------------------------------------------------------------------
// clinical_resource
// ---------------------------------------------------------------------------
export interface ClinicalResource {
  id: string;
  kind: ResourceKind;
  name: string;
  code: string | null;
  isActive: boolean;
}

interface ResourceRow {
  id: string;
  kind: ResourceKind;
  name: string;
  code: string | null;
  is_active: boolean;
}

const mapResource = (r: ResourceRow): ClinicalResource => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  code: r.code,
  isActive: r.is_active,
});

export async function insertResource(
  client: PoolClient,
  input: {
    clinicId: string;
    kind: ResourceKind;
    name: string;
    code: string | null;
    createdBy: string;
  },
): Promise<ClinicalResource> {
  const { rows } = await client.query<ResourceRow>(
    `INSERT INTO clinical_resource (clinic_id, kind, name, code, created_by)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, kind, name, code, is_active`,
    [input.clinicId, input.kind, input.name, input.code, input.createdBy],
  );
  return mapResource(rows[0]!);
}

export async function listResources(
  clinicId: string,
  opts: { kind?: ResourceKind; includeInactive?: boolean } = {},
  runner: Runner = getPool(),
): Promise<ClinicalResource[]> {
  const { rows } = await runner.query<ResourceRow>(
    `SELECT id, kind, name, code, is_active FROM clinical_resource
      WHERE clinic_id = $1
        AND ($2::text IS NULL OR kind = $2)
        AND ($3::boolean OR is_active)
      ORDER BY kind, name`,
    [clinicId, opts.kind ?? null, opts.includeInactive ?? false],
  );
  return rows.map(mapResource);
}

export async function findResource(
  clinicId: string,
  resourceId: string,
  runner: Runner = getPool(),
): Promise<ClinicalResource | null> {
  const { rows } = await runner.query<ResourceRow>(
    `SELECT id, kind, name, code, is_active FROM clinical_resource
      WHERE clinic_id = $1 AND id = $2`,
    [clinicId, resourceId],
  );
  return rows[0] ? mapResource(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// appointment_type
// ---------------------------------------------------------------------------
export interface AppointmentType {
  id: string;
  key: string;
  name: string;
  defaultDurationMinutes: number;
  isActive: boolean;
}

interface TypeRow {
  id: string;
  key: string;
  name: string;
  default_duration_minutes: number;
  is_active: boolean;
}

const mapType = (r: TypeRow): AppointmentType => ({
  id: r.id,
  key: r.key,
  name: r.name,
  defaultDurationMinutes: r.default_duration_minutes,
  isActive: r.is_active,
});

export async function insertAppointmentType(
  client: PoolClient,
  input: {
    clinicId: string;
    key: string;
    name: string;
    defaultDurationMinutes: number;
    createdBy: string;
  },
): Promise<AppointmentType> {
  const { rows } = await client.query<TypeRow>(
    `INSERT INTO appointment_type
       (clinic_id, key, name, default_duration_minutes, created_by)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, key, name, default_duration_minutes, is_active`,
    [input.clinicId, input.key, input.name, input.defaultDurationMinutes, input.createdBy],
  );
  return mapType(rows[0]!);
}

export async function listAppointmentTypes(
  clinicId: string,
  includeInactive = false,
  runner: Runner = getPool(),
): Promise<AppointmentType[]> {
  const { rows } = await runner.query<TypeRow>(
    `SELECT id, key, name, default_duration_minutes, is_active FROM appointment_type
      WHERE clinic_id = $1 AND ($2::boolean OR is_active)
      ORDER BY name`,
    [clinicId, includeInactive],
  );
  return rows.map(mapType);
}

export async function findAppointmentType(
  clinicId: string,
  typeId: string,
  runner: Runner = getPool(),
): Promise<AppointmentType | null> {
  const { rows } = await runner.query<TypeRow>(
    `SELECT id, key, name, default_duration_minutes, is_active FROM appointment_type
      WHERE clinic_id = $1 AND id = $2`,
    [clinicId, typeId],
  );
  return rows[0] ? mapType(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// appointment
// ---------------------------------------------------------------------------
export interface Appointment {
  id: string;
  patientId: string;
  appointmentTypeId: string | null;
  practitionerId: string | null;
  resourceId: string | null;
  encounterId: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  priority: 'routine' | 'urgent' | 'emergency';
  origin: 'booked' | 'walk_in';
  reason: string | null;
  arrivedAt: string | null;
  closedAt: string | null;
  closureReason: string | null;
}

export interface AppointmentRow {
  id: string;
  patient_id: string;
  appointment_type_id: string | null;
  practitioner_id: string | null;
  resource_id: string | null;
  encounter_id: string | null;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  priority: Appointment['priority'];
  origin: Appointment['origin'];
  reason: string | null;
  arrived_at: string | null;
  closed_at: string | null;
  closure_reason: string | null;
}

export const APPOINTMENT_COLS = `id, patient_id, appointment_type_id, practitioner_id,
  resource_id, encounter_id, starts_at, ends_at, status, priority, origin, reason,
  arrived_at, closed_at, closure_reason`;

export function mapAppointment(r: AppointmentRow): Appointment {
  return {
    id: r.id,
    patientId: r.patient_id,
    appointmentTypeId: r.appointment_type_id,
    practitionerId: r.practitioner_id,
    resourceId: r.resource_id,
    encounterId: r.encounter_id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    priority: r.priority,
    origin: r.origin,
    reason: r.reason,
    arrivedAt: r.arrived_at,
    closedAt: r.closed_at,
    closureReason: r.closure_reason,
  };
}

export async function findAppointment(
  clinicId: string,
  appointmentId: string,
  runner: Runner = getPool(),
): Promise<Appointment | null> {
  const { rows } = await runner.query<AppointmentRow>(
    `SELECT ${APPOINTMENT_COLS} FROM appointment WHERE clinic_id = $1 AND id = $2`,
    [clinicId, appointmentId],
  );
  return rows[0] ? mapAppointment(rows[0]) : null;
}

export async function lockAppointment(
  client: PoolClient,
  clinicId: string,
  appointmentId: string,
): Promise<Appointment | null> {
  const { rows } = await client.query<AppointmentRow>(
    `SELECT ${APPOINTMENT_COLS} FROM appointment
      WHERE clinic_id = $1 AND id = $2 FOR UPDATE`,
    [clinicId, appointmentId],
  );
  return rows[0] ? mapAppointment(rows[0]) : null;
}

/** Record a transition in the append-only history. */
export async function recordTransition(
  client: PoolClient,
  input: {
    clinicId: string;
    appointmentId: string;
    from: AppointmentStatus | null;
    to: AppointmentStatus;
    reason: string | null;
    actorId: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO appointment_status_history
       (clinic_id, appointment_id, from_status, to_status, reason, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.clinicId,
      input.appointmentId,
      input.from,
      input.to,
      input.reason,
      input.actorId,
    ],
  );
}

export interface TransitionRecord {
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  actorId: string | null;
  createdAt: string;
}

export async function listTransitions(
  clinicId: string,
  appointmentId: string,
  runner: Runner = getPool(),
): Promise<TransitionRecord[]> {
  const { rows } = await runner.query<{
    from_status: string | null;
    to_status: string;
    reason: string | null;
    actor_id: string | null;
    created_at: string;
  }>(
    `SELECT from_status, to_status, reason, actor_id, created_at
       FROM appointment_status_history
      WHERE clinic_id = $1 AND appointment_id = $2
      ORDER BY created_at, id`,
    [clinicId, appointmentId],
  );
  return rows.map((r) => ({
    fromStatus: r.from_status,
    toStatus: r.to_status,
    reason: r.reason,
    actorId: r.actor_id,
    createdAt: r.created_at,
  }));
}
