import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType, type EventType as EventTypeName } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { hasPermission, requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';
import { checkIn } from '../workflow/checkin.service.js';
import {
  APPOINTMENT_COLS,
  findAppointment,
  findAppointmentType,
  findResource,
  insertAppointmentType,
  insertResource,
  listAppointmentTypes,
  listResources,
  listTransitions,
  lockAppointment,
  mapAppointment,
  recordTransition,
  type Appointment,
  type AppointmentRow,
  type AppointmentStatus,
  type AppointmentType,
  type ClinicalResource,
} from './scheduling.repo.js';

/**
 * The scheduling engine (Phase 2).
 *
 * The appointment lifecycle is an explicit allow-list, so a caller can never
 * drive an appointment into an order the front desk does not permit — no
 * arriving for a cancelled slot, no completing a visit that never started.
 * Every transition is written to an append-only history.
 */
const ALLOWED_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  scheduled: ['confirmed', 'arrived', 'cancelled', 'no_show'],
  confirmed: ['arrived', 'cancelled', 'no_show'],
  arrived: ['waiting', 'in_consultation', 'left_without_being_seen', 'cancelled'],
  waiting: ['in_consultation', 'left_without_being_seen', 'cancelled'],
  // Completion follows the encounter; see `syncAppointmentFromEncounterTx`.
  in_consultation: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
  left_without_being_seen: [],
};

/** Statuses that still hold their slot. Mirrors the EXCLUDE predicate in 0105. */
const LIVE_STATUSES: readonly AppointmentStatus[] = [
  'scheduled',
  'confirmed',
  'arrived',
  'waiting',
  'in_consultation',
];

/** Statuses that close an appointment out, requiring `closed_at`. */
const CLOSED_STATUSES: readonly AppointmentStatus[] = [
  'completed',
  'cancelled',
  'no_show',
  'left_without_being_seen',
];

/**
 * Statuses the front desk sets directly. `in_consultation` and `completed` are
 * absent on purpose: they describe what the clinician did, and follow the
 * encounter rather than being asserted by a second actor.
 */
const DESK_ASSIGNABLE: readonly AppointmentStatus[] = [
  'confirmed',
  'arrived',
  'waiting',
  'cancelled',
  'no_show',
  'left_without_being_seen',
];

const EVENT_FOR_STATUS: Partial<Record<AppointmentStatus, EventTypeName>> = {
  confirmed: EventType.APPOINTMENT_CONFIRMED,
  arrived: EventType.PATIENT_ARRIVED,
  cancelled: EventType.APPOINTMENT_CANCELLED,
  no_show: EventType.APPOINTMENT_NO_SHOW,
  left_without_being_seen: EventType.APPOINTMENT_LEFT_WITHOUT_BEING_SEEN,
  completed: EventType.APPOINTMENT_COMPLETED,
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const isoDateTime = z.string().datetime({ offset: true });

export const BookAppointmentSchema = z
  .object({
    patientId: z.string().uuid(),
    startsAt: isoDateTime,
    /** Either an explicit end, or a duration; otherwise the type's default. */
    endsAt: isoDateTime.optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    appointmentTypeId: z.string().uuid().optional(),
    practitionerId: z.string().uuid().optional(),
    resourceId: z.string().uuid().optional(),
    priority: z.enum(['routine', 'urgent', 'emergency']).default('routine'),
    origin: z.enum(['booked', 'walk_in']).default('booked'),
    reason: z.string().trim().max(1_000).optional(),
    /**
     * Book over a practitioner's existing appointment. Clinics overbook on
     * purpose, so this is permitted — but only deliberately, only by a holder
     * of `appointment:overbook`, and it is audited.
     */
    allowDoubleBooking: z.boolean().default(false),
  })
  .refine((v) => !(v.endsAt && v.durationMinutes), {
    message: 'Supply endsAt or durationMinutes, not both',
    path: ['endsAt'],
  });

export const RescheduleSchema = z
  .object({
    startsAt: isoDateTime.optional(),
    endsAt: isoDateTime.optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    practitionerId: z.string().uuid().nullable().optional(),
    resourceId: z.string().uuid().nullable().optional(),
    priority: z.enum(['routine', 'urgent', 'emergency']).optional(),
    reason: z.string().trim().max(1_000).nullable().optional(),
    allowDoubleBooking: z.boolean().default(false),
  })
  .refine((v) => !(v.endsAt && v.durationMinutes), {
    message: 'Supply endsAt or durationMinutes, not both',
    path: ['endsAt'],
  })
  .refine(
    (v) =>
      Object.keys(v).filter((k) => k !== 'allowDoubleBooking').length > 0,
    { message: 'No changes supplied' },
  );

export const AppointmentStatusSchema = z.object({
  status: z.enum([
    'confirmed',
    'arrived',
    'waiting',
    'cancelled',
    'no_show',
    'left_without_being_seen',
  ]),
  reason: z.string().trim().max(500).optional(),
});

export const ScheduleQuerySchema = z
  .object({
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    practitionerId: z.string().uuid().optional(),
    patientId: z.string().uuid().optional(),
    status: z
      .enum([
        'scheduled',
        'confirmed',
        'arrived',
        'waiting',
        'in_consultation',
        'completed',
        'cancelled',
        'no_show',
        'left_without_being_seen',
      ])
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .refine((v) => !v.from || !v.to || v.to > v.from, {
    message: 'to must be after from',
    path: ['to'],
  });

export const ResourceSchema = z.object({
  kind: z.enum(['room', 'chair', 'equipment', 'other']).default('room'),
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(40).optional(),
});

export const AppointmentTypeSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,48}$/, 'lower_snake_case key'),
  name: z.string().trim().min(1).max(120),
  defaultDurationMinutes: z.number().int().min(5).max(480),
});

// ---------------------------------------------------------------------------
// Configuration: resources and appointment types
// ---------------------------------------------------------------------------
export async function createResource(
  principal: Principal,
  raw: unknown,
): Promise<ClinicalResource> {
  requirePermission(principal, Permission.SCHEDULE_CONFIG_MANAGE);
  const parsed = ResourceSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid resource', parsed.error.flatten());

  return withTransaction(async (client) => {
    try {
      const resource = await insertResource(client, {
        clinicId: principal.clinicId,
        kind: parsed.data.kind,
        name: parsed.data.name,
        code: parsed.data.code ?? null,
        createdBy: principal.userId,
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'schedule.resource.create',
        outcome: 'success',
        targetType: 'clinical_resource',
        targetId: resource.id,
        metadata: { kind: resource.kind },
      });
      return resource;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('A resource with that name or code already exists');
      }
      throw err;
    }
  });
}

export async function getResources(
  principal: Principal,
  kind?: string,
): Promise<ClinicalResource[]> {
  requirePermission(principal, Permission.SCHEDULE_CONFIG_READ);
  const parsed = z.enum(['room', 'chair', 'equipment', 'other']).optional().safeParse(kind);
  if (!parsed.success) throw new ValidationError('Invalid resource kind');
  return listResources(principal.clinicId, { kind: parsed.data });
}

export async function createAppointmentType(
  principal: Principal,
  raw: unknown,
): Promise<AppointmentType> {
  requirePermission(principal, Permission.SCHEDULE_CONFIG_MANAGE);
  const parsed = AppointmentTypeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid appointment type', parsed.error.flatten());
  }

  return withTransaction(async (client) => {
    try {
      const type = await insertAppointmentType(client, {
        clinicId: principal.clinicId,
        key: parsed.data.key,
        name: parsed.data.name,
        defaultDurationMinutes: parsed.data.defaultDurationMinutes,
        createdBy: principal.userId,
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'schedule.type.create',
        outcome: 'success',
        targetType: 'appointment_type',
        targetId: type.id,
        metadata: { key: type.key },
      });
      return type;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('An appointment type with that key already exists');
      }
      throw err;
    }
  });
}

export async function getAppointmentTypes(principal: Principal): Promise<AppointmentType[]> {
  requirePermission(principal, Permission.SCHEDULE_CONFIG_READ);
  return listAppointmentTypes(principal.clinicId);
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/** Resolve the appointment window from an end time, a duration, or the type. */
async function resolveWindow(
  clinicId: string,
  startsAt: string,
  opts: { endsAt?: string; durationMinutes?: number; appointmentTypeId?: string },
  runner: Pick<PoolClient, 'query'>,
): Promise<{ startsAt: string; endsAt: string }> {
  if (opts.endsAt) {
    if (new Date(opts.endsAt) <= new Date(startsAt)) {
      throw new ValidationError('endsAt must be after startsAt');
    }
    return { startsAt, endsAt: opts.endsAt };
  }

  let minutes = opts.durationMinutes;
  if (minutes === undefined && opts.appointmentTypeId) {
    const type = await findAppointmentType(clinicId, opts.appointmentTypeId, runner);
    minutes = type?.defaultDurationMinutes;
  }
  if (minutes === undefined) {
    throw new ValidationError(
      'Supply endsAt, durationMinutes, or an appointmentTypeId with a default duration',
    );
  }
  const end = new Date(new Date(startsAt).getTime() + minutes * 60_000);
  return { startsAt, endsAt: end.toISOString() };
}

/**
 * Practitioner appointments overlapping a window. Used to warn about (not
 * forbid) double-booking; the room conflict is a database constraint instead.
 */
async function findPractitionerConflicts(
  client: PoolClient,
  clinicId: string,
  practitionerId: string,
  startsAt: string,
  endsAt: string,
  excludeAppointmentId: string | null,
): Promise<Appointment[]> {
  const { rows } = await client.query<AppointmentRow>(
    `SELECT ${APPOINTMENT_COLS} FROM appointment
      WHERE clinic_id = $1
        AND practitioner_id = $2
        AND status = ANY($3::text[])
        AND tstzrange(starts_at, ends_at) && tstzrange($4::timestamptz, $5::timestamptz)
        AND ($6::uuid IS NULL OR id <> $6)
      ORDER BY starts_at`,
    [clinicId, practitionerId, LIVE_STATUSES, startsAt, endsAt, excludeAppointmentId],
  );
  return rows.map(mapAppointment);
}

/** Validate that a referenced practitioner / resource / type belongs here. */
async function assertReferencesValid(
  client: PoolClient,
  clinicId: string,
  refs: { practitionerId?: string | null; resourceId?: string | null; appointmentTypeId?: string | null },
): Promise<void> {
  if (refs.practitionerId) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM app_user WHERE id = $1 AND clinic_id = $2 AND is_active`,
      [refs.practitionerId, clinicId],
    );
    if (!rows[0]) throw new ValidationError('practitionerId is not an active user in this clinic');
  }
  if (refs.resourceId) {
    const resource = await findResource(clinicId, refs.resourceId, client);
    if (!resource) throw new ValidationError('resourceId does not belong to this clinic');
    if (!resource.isActive) throw new ValidationError('That resource is not active');
  }
  if (refs.appointmentTypeId) {
    const type = await findAppointmentType(clinicId, refs.appointmentTypeId, client);
    if (!type) throw new ValidationError('appointmentTypeId does not belong to this clinic');
    if (!type.isActive) throw new ValidationError('That appointment type is not active');
  }
}

export async function bookAppointment(
  principal: Principal,
  raw: unknown,
): Promise<Appointment> {
  requirePermission(principal, Permission.APPOINTMENT_SCHEDULE);

  const parsed = BookAppointmentSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid appointment', parsed.error.flatten());
  const input = parsed.data;

  const patient = await getPatientById(principal.clinicId, input.patientId);
  if (!patient) throw new NotFoundError('Patient');
  if (patient.status === 'merged') {
    throw new ConflictError('This record was merged into another patient; book the survivor', {
      mergedIntoId: patient.mergedIntoId,
    });
  }
  if (patient.status === 'deceased') {
    throw new ConflictError('This patient record is marked deceased');
  }

  return withTransaction(async (client) => {
    await assertReferencesValid(client, principal.clinicId, input);
    const window = await resolveWindow(principal.clinicId, input.startsAt, input, client);

    let overbooked = false;
    if (input.practitionerId) {
      const conflicts = await findPractitionerConflicts(
        client,
        principal.clinicId,
        input.practitionerId,
        window.startsAt,
        window.endsAt,
        null,
      );
      if (conflicts.length > 0) {
        if (!input.allowDoubleBooking) {
          throw new ConflictError(
            'That practitioner already has an appointment in this window; set allowDoubleBooking to book anyway',
            { conflicts: conflicts.map((c) => c.id) },
          );
        }
        requirePermission(principal, Permission.APPOINTMENT_OVERBOOK);
        overbooked = true;
      }
    }

    let appointment: Appointment;
    try {
      const { rows } = await client.query<AppointmentRow>(
        `INSERT INTO appointment
           (clinic_id, patient_id, appointment_type_id, practitioner_id, resource_id,
            starts_at, ends_at, priority, origin, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING ${APPOINTMENT_COLS}`,
        [
          principal.clinicId,
          patient.id,
          input.appointmentTypeId ?? null,
          input.practitionerId ?? null,
          input.resourceId ?? null,
          window.startsAt,
          window.endsAt,
          input.priority,
          input.origin,
          input.reason ?? null,
          principal.userId,
        ],
      );
      appointment = mapAppointment(rows[0]!);
    } catch (err) {
      if (isExclusionViolation(err)) {
        throw new ConflictError('That room is already booked for an overlapping appointment');
      }
      throw err;
    }

    await recordTransition(client, {
      clinicId: principal.clinicId,
      appointmentId: appointment.id,
      from: null,
      to: 'scheduled',
      reason: null,
      actorId: principal.userId,
    });

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.APPOINTMENT_SCHEDULED,
      subjectType: 'appointment',
      subjectId: appointment.id,
      actorId: principal.userId,
      // Identifiers and scheduling shape. The visit reason is clinical and
      // stays in the record; automation gets the time, which is what a
      // reminder needs.
      payload: {
        patientId: patient.id,
        practitionerId: appointment.practitionerId,
        startsAt: appointment.startsAt,
        priority: appointment.priority,
        origin: appointment.origin,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'appointment.book',
      outcome: 'success',
      targetType: 'appointment',
      targetId: appointment.id,
      metadata: { patientId: patient.id, overbooked, origin: appointment.origin },
    });

    return appointment;
  });
}

export async function rescheduleAppointment(
  principal: Principal,
  appointmentId: string,
  raw: unknown,
): Promise<Appointment> {
  requirePermission(principal, Permission.APPOINTMENT_UPDATE);

  const parsed = RescheduleSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid change', parsed.error.flatten());
  const input = parsed.data;

  return withTransaction(async (client) => {
    const existing = await lockAppointment(client, principal.clinicId, appointmentId);
    if (!existing) throw new NotFoundError('Appointment');
    if (!LIVE_STATUSES.includes(existing.status)) {
      throw new ConflictError(`Appointment is ${existing.status} and can no longer be changed`);
    }
    if (existing.status === 'in_consultation') {
      throw new ConflictError('The consultation has started; the appointment cannot be moved');
    }

    await assertReferencesValid(client, principal.clinicId, {
      practitionerId: input.practitionerId ?? undefined,
      resourceId: input.resourceId ?? undefined,
    });

    const startsAt = input.startsAt ?? existing.startsAt;
    const window =
      input.startsAt || input.endsAt || input.durationMinutes
        ? await resolveWindow(
            principal.clinicId,
            startsAt,
            {
              ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
              ...(input.durationMinutes !== undefined
                ? { durationMinutes: input.durationMinutes }
                : {}),
              ...(!input.endsAt && input.durationMinutes === undefined
                ? {
                    durationMinutes: Math.round(
                      (new Date(existing.endsAt).getTime() -
                        new Date(existing.startsAt).getTime()) /
                        60_000,
                    ),
                  }
                : {}),
            },
            client,
          )
        : { startsAt: existing.startsAt, endsAt: existing.endsAt };

    const practitionerId =
      input.practitionerId === undefined ? existing.practitionerId : input.practitionerId;

    let overbooked = false;
    if (practitionerId) {
      const conflicts = await findPractitionerConflicts(
        client,
        principal.clinicId,
        practitionerId,
        window.startsAt,
        window.endsAt,
        existing.id,
      );
      if (conflicts.length > 0) {
        if (!input.allowDoubleBooking) {
          throw new ConflictError(
            'That practitioner already has an appointment in this window; set allowDoubleBooking to move it anyway',
            { conflicts: conflicts.map((c) => c.id) },
          );
        }
        requirePermission(principal, Permission.APPOINTMENT_OVERBOOK);
        overbooked = true;
      }
    }

    const moved =
      window.startsAt !== existing.startsAt || window.endsAt !== existing.endsAt;

    let updated: Appointment;
    try {
      const { rows } = await client.query<AppointmentRow>(
        `UPDATE appointment
            SET starts_at = $3, ends_at = $4,
                practitioner_id = $5,
                resource_id = $6,
                priority = COALESCE($7, priority),
                reason = CASE WHEN $8::boolean THEN $9 ELSE reason END,
                updated_at = now()
          WHERE clinic_id = $1 AND id = $2
          RETURNING ${APPOINTMENT_COLS}`,
        [
          principal.clinicId,
          existing.id,
          window.startsAt,
          window.endsAt,
          practitionerId,
          input.resourceId === undefined ? existing.resourceId : input.resourceId,
          input.priority ?? null,
          'reason' in input,
          input.reason ?? null,
        ],
      );
      updated = mapAppointment(rows[0]!);
    } catch (err) {
      if (isExclusionViolation(err)) {
        throw new ConflictError('That room is already booked for an overlapping appointment');
      }
      throw err;
    }

    if (moved) {
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.APPOINTMENT_RESCHEDULED,
        subjectType: 'appointment',
        subjectId: updated.id,
        actorId: principal.userId,
        payload: {
          patientId: updated.patientId,
          from: existing.startsAt,
          to: updated.startsAt,
        },
      });
    }
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'appointment.update',
      outcome: 'success',
      targetType: 'appointment',
      targetId: updated.id,
      metadata: {
        patientId: updated.patientId,
        moved,
        overbooked,
        fields: Object.keys(input).filter((k) => k !== 'allowDoubleBooking'),
      },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------
export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface TransitionResult {
  appointment: Appointment;
  /** The encounter opened by arrival, when arrival opened one. */
  encounterId: string | null;
}

/**
 * Move an appointment through the front-desk part of its lifecycle.
 *
 * Arrival is the join between scheduling and the clinical record: it opens an
 * encounter through the existing check-in service, so an arrival produces
 * exactly the same encounter, event and audit trail as a walk-in does today.
 */
export async function setAppointmentStatus(
  principal: Principal,
  appointmentId: string,
  raw: unknown,
): Promise<TransitionResult> {
  const parsed = AppointmentStatusSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid status', parsed.error.flatten());
  const { status: to, reason } = parsed.data;

  // Cancelling is its own authority; everything else here is desk work.
  //
  // Note that `arrived` additionally requires `encounter:checkin`, because it
  // opens a clinical encounter through the check-in service. A nurse holds
  // `appointment:arrival` and can move a patient through the waiting room, but
  // opening the visit stays with the front desk — one permission, one meaning.
  requirePermission(
    principal,
    to === 'cancelled' ? Permission.APPOINTMENT_CANCEL : Permission.APPOINTMENT_ARRIVAL,
  );
  if (!DESK_ASSIGNABLE.includes(to)) {
    throw new ValidationError(`Status '${to}' is not settable from the front desk`);
  }

  // Arrival opens an encounter, which has its own permission and its own
  // transaction; doing it first means a failure there never leaves an
  // appointment marked arrived with no visit behind it.
  let encounterId: string | null = null;
  if (to === 'arrived') {
    const existing = await findAppointment(principal.clinicId, appointmentId);
    if (!existing) throw new NotFoundError('Appointment');
    if (!canTransition(existing.status, 'arrived')) {
      throw new ConflictError(`Cannot mark an appointment ${existing.status} as arrived`, {
        from: existing.status,
        allowed: ALLOWED_TRANSITIONS[existing.status],
      });
    }
    const encounter = await checkIn(principal, existing.patientId);
    encounterId = encounter.id;
  }

  return withTransaction(async (client) => {
    const existing = await lockAppointment(client, principal.clinicId, appointmentId);
    if (!existing) throw new NotFoundError('Appointment');
    if (existing.status === to) throw new ConflictError(`Appointment is already ${to}`);
    if (!canTransition(existing.status, to)) {
      throw new ConflictError(`Cannot move an appointment from ${existing.status} to ${to}`, {
        from: existing.status,
        to,
        allowed: ALLOWED_TRANSITIONS[existing.status],
      });
    }

    const closing = CLOSED_STATUSES.includes(to);
    const { rows } = await client.query<AppointmentRow>(
      `UPDATE appointment
          SET status = $3::text,
              encounter_id = COALESCE($4::uuid, encounter_id),
              arrived_at = CASE WHEN $3::text = 'arrived' THEN now() ELSE arrived_at END,
              closed_at = CASE WHEN $5::boolean THEN now() ELSE NULL END,
              closed_by = CASE WHEN $5::boolean THEN $6::uuid ELSE NULL END,
              closure_reason = CASE WHEN $5::boolean THEN $7::text ELSE NULL END,
              updated_at = now()
        WHERE clinic_id = $1 AND id = $2
        RETURNING ${APPOINTMENT_COLS}`,
      [
        principal.clinicId,
        existing.id,
        to,
        encounterId,
        closing,
        principal.userId,
        reason ?? null,
      ],
    );
    const updated = mapAppointment(rows[0]!);

    await recordTransition(client, {
      clinicId: principal.clinicId,
      appointmentId: updated.id,
      from: existing.status,
      to,
      reason: reason ?? null,
      actorId: principal.userId,
    });

    const eventType = EVENT_FOR_STATUS[to];
    if (eventType) {
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: eventType,
        subjectType: 'appointment',
        subjectId: updated.id,
        actorId: principal.userId,
        payload: {
          patientId: updated.patientId,
          from: existing.status,
          ...(encounterId ? { encounterId } : {}),
        },
      });
    }
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'appointment.status',
      outcome: 'success',
      targetType: 'appointment',
      targetId: updated.id,
      metadata: { patientId: updated.patientId, from: existing.status, to },
    });

    return { appointment: updated, encounterId: updated.encounterId };
  });
}

/**
 * Keep a linked appointment in step with its encounter.
 *
 * The encounter is the clinical source of truth for whether a patient was seen,
 * so `in_consultation` and `completed` are derived from it rather than asserted
 * separately — one fact, one owner. A no-op when nothing is linked.
 */
export async function syncAppointmentFromEncounterTx(
  client: PoolClient,
  principal: Principal,
  encounterId: string,
  to: 'in_consultation' | 'completed' | 'left_without_being_seen',
): Promise<void> {
  const { rows } = await client.query<AppointmentRow>(
    `SELECT ${APPOINTMENT_COLS} FROM appointment
      WHERE clinic_id = $1 AND encounter_id = $2 FOR UPDATE`,
    [principal.clinicId, encounterId],
  );
  const appointment = rows[0] ? mapAppointment(rows[0]) : null;
  if (!appointment) return;
  if (appointment.status === to) return;
  // A cancelled encounter closes its linked appointment from ANY live state.
  // A linked appointment has always been through arrival (that is what creates
  // the encounter), so `arrived_at` is set and the appointment can only close as
  // `completed` or `left_without_being_seen` (ck_appointment_arrival, 0105) —
  // never `cancelled`, which is reserved for a visit abandoned before arrival.
  // So a cancelled visit lands its appointment on `left_without_being_seen`: the
  // patient arrived but the consultation never completed, and the slot is freed.
  // `in_consultation` has no desk transition here, so this system-driven sync
  // (the clinical record is the source of truth) accepts any live state.
  const permitted =
    to === 'left_without_being_seen'
      ? LIVE_STATUSES.includes(appointment.status)
      : canTransition(appointment.status, to);
  if (!permitted) return;

  const closing = CLOSED_STATUSES.includes(to);
  await client.query(
    `UPDATE appointment
        SET status = $3::text,
            closed_at = CASE WHEN $4::boolean THEN now() ELSE closed_at END,
            closed_by = CASE WHEN $4::boolean THEN $5::uuid ELSE closed_by END,
            updated_at = now()
      WHERE clinic_id = $1 AND id = $2`,
    [principal.clinicId, appointment.id, to, closing, principal.userId],
  );
  await recordTransition(client, {
    clinicId: principal.clinicId,
    appointmentId: appointment.id,
    from: appointment.status,
    to,
    reason: 'encounter',
    actorId: principal.userId,
  });

  const eventType = EVENT_FOR_STATUS[to];
  if (eventType) {
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: eventType,
      subjectType: 'appointment',
      subjectId: appointment.id,
      actorId: principal.userId,
      payload: { patientId: appointment.patientId, encounterId },
    });
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export interface ScheduleEntry extends Appointment {
  patientName: string;
  mrn: string;
  appointmentTypeName: string | null;
  resourceName: string | null;
}

export async function getSchedule(
  principal: Principal,
  rawQuery: unknown,
): Promise<ScheduleEntry[]> {
  requirePermission(principal, Permission.APPOINTMENT_READ);

  const parsed = ScheduleQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid schedule query', parsed.error.flatten());
  const q = parsed.data;

  const { rows } = await getPool().query<
    AppointmentRow & { full_name: string; mrn: string; type_name: string | null; resource_name: string | null }
  >(
    `SELECT ${APPOINTMENT_COLS.split(', ').map((c) => `a.${c}`).join(', ')},
            p.full_name, p.mrn,
            t.name AS type_name,
            r.name AS resource_name
       FROM appointment a
       JOIN patient p ON p.id = a.patient_id AND p.clinic_id = a.clinic_id
       LEFT JOIN appointment_type t ON t.id = a.appointment_type_id
       LEFT JOIN clinical_resource r ON r.id = a.resource_id
      WHERE a.clinic_id = $1
        AND ($2::timestamptz IS NULL OR a.starts_at >= $2)
        AND ($3::timestamptz IS NULL OR a.starts_at < $3)
        AND ($4::uuid IS NULL OR a.practitioner_id = $4)
        AND ($5::uuid IS NULL OR a.patient_id = $5)
        AND ($6::text IS NULL OR a.status = $6)
      ORDER BY a.starts_at, a.created_at
      LIMIT $7`,
    [
      principal.clinicId,
      q.from ?? null,
      q.to ?? null,
      q.practitionerId ?? null,
      q.patientId ?? null,
      q.status ?? null,
      q.limit,
    ],
  );

  return rows.map((r) => ({
    ...mapAppointment(r),
    patientName: r.full_name,
    mrn: r.mrn,
    appointmentTypeName: r.type_name,
    resourceName: r.resource_name,
  }));
}

export interface AppointmentDetail {
  appointment: Appointment;
  history: Awaited<ReturnType<typeof listTransitions>>;
}

export async function getAppointment(
  principal: Principal,
  appointmentId: string,
): Promise<AppointmentDetail> {
  requirePermission(principal, Permission.APPOINTMENT_READ);
  const appointment = await findAppointment(principal.clinicId, appointmentId);
  if (!appointment) throw new NotFoundError('Appointment');
  return {
    appointment,
    history: await listTransitions(principal.clinicId, appointment.id),
  };
}

/** Appointments linked to a patient, newest first. Lineage-aware via caller. */
export async function getPatientAppointments(
  principal: Principal,
  patientId: string,
  rawQuery: unknown,
): Promise<ScheduleEntry[]> {
  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');
  return getSchedule(principal, { ...(rawQuery as object), patientId: patient.id });
}

/** True when the principal may see scheduling at all — used to shape views. */
export function canReadSchedule(principal: Principal): boolean {
  return hasPermission(principal, Permission.APPOINTMENT_READ);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/** 23P01 = exclusion_violation, raised by the room double-booking constraint. */
function isExclusionViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23P01';
}
