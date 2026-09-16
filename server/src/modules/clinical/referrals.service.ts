import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType, type EventType as EventName } from '../../domain/events.js';
import { audit, auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';
import { findEncounter } from './encounter.repo.js';
import { toIsoDate, todayIso } from './dates.js';

/**
 * Referrals & care coordination (Phase 10).
 *
 * The referral STATUS is the coordination state — there is no separate task
 * engine (that is Agent 3's). Clinical Core drives the lifecycle and emits an
 * event on each transition; Agent 3 decides whether that becomes a reminder, a
 * task or an escalation. This module never sends anything.
 */

export type ReferralStatus =
  | 'draft'
  | 'ordered'
  | 'sent'
  | 'accepted'
  | 'scheduled'
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'expired';

/**
 * The deterministic lifecycle allow-list. An invalid transition is rejected;
 * this is the smallest machine that covers order → send → accept/decline →
 * schedule → complete, with cancel/expire available while live.
 */
const ALLOWED_TRANSITIONS: Record<ReferralStatus, readonly ReferralStatus[]> = {
  draft: ['ordered', 'cancelled'],
  ordered: ['sent', 'cancelled'],
  sent: ['accepted', 'declined', 'cancelled', 'expired'],
  accepted: ['scheduled', 'completed', 'cancelled', 'expired'],
  scheduled: ['completed', 'cancelled', 'expired'],
  completed: [],
  cancelled: [],
  declined: [],
  expired: [],
};

const TERMINAL: readonly ReferralStatus[] = ['completed', 'cancelled', 'declined', 'expired'];

/** Which permission a target status requires. */
function permissionForTransition(to: ReferralStatus): Permission {
  if (to === 'completed') return Permission.REFERRAL_COMPLETE;
  // Everything else in the lifecycle is administrative coordination.
  return Permission.REFERRAL_MANAGE;
}

const EVENT_FOR_STATUS: Partial<Record<ReferralStatus, EventName>> = {
  sent: EventType.REFERRAL_SENT,
  accepted: EventType.REFERRAL_ACCEPTED,
  declined: EventType.REFERRAL_DECLINED,
  scheduled: EventType.REFERRAL_SCHEDULED,
  completed: EventType.REFERRAL_COMPLETED,
  cancelled: EventType.REFERRAL_CANCELLED,
  expired: EventType.REFERRAL_EXPIRED,
};

export function canTransition(from: ReferralStatus, to: ReferralStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const CreateReferralSchema = z
  .object({
    patientId: z.string().uuid(),
    encounterId: z.string().uuid().optional(),
    direction: z.enum(['internal', 'external']),
    receivingPractitionerId: z.string().uuid().optional(),
    receivingProvider: z.string().trim().min(1).max(200).optional(),
    receivingSpecialty: z.string().trim().min(1).max(120).optional(),
    reason: z.string().trim().min(2).max(2_000),
    urgency: z.enum(['routine', 'urgent', 'emergency']).default('routine'),
    dueDate: isoDate.optional(),
    notes: z.string().trim().max(4_000).optional(),
    /** Order immediately instead of leaving as a draft. */
    order: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.direction === 'internal' && !v.receivingPractitionerId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['receivingPractitionerId'], message: 'An internal referral needs a receiving practitioner' });
    }
    if (v.direction === 'external' && !v.receivingProvider && !v.receivingSpecialty) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['receivingProvider'], message: 'An external referral needs a provider or a specialty' });
    }
  });

export const TransitionReferralSchema = z.object({
  status: z.enum(['ordered', 'sent', 'accepted', 'scheduled', 'completed', 'cancelled', 'declined', 'expired']),
  reason: z.string().trim().max(500).optional(),
  /** A scheduled referral may link the appointment that fulfils it. */
  appointmentId: z.string().uuid().optional(),
  /** Any transition may attach a document (referral letter, reply). */
  documentId: z.string().uuid().optional(),
});

export const ListReferralsQuery = z.object({
  status: z.enum(['draft', 'ordered', 'sent', 'accepted', 'scheduled', 'completed', 'cancelled', 'declined', 'expired']).optional(),
  patientId: z.string().uuid().optional(),
  direction: z.enum(['internal', 'external']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------
export interface Referral {
  id: string;
  patientId: string;
  originEncounterId: string | null;
  referringPractitionerId: string;
  direction: 'internal' | 'external';
  receivingPractitionerId: string | null;
  receivingProvider: string | null;
  receivingSpecialty: string | null;
  reason: string;
  urgency: 'routine' | 'urgent' | 'emergency';
  status: ReferralStatus;
  dueDate: string | null;
  completedAt: string | null;
  closureReason: string | null;
  linkedAppointmentId: string | null;
  linkedDocumentId: string | null;
  notes: string | null;
  createdAt: string;
}

interface ReferralRow {
  id: string;
  patient_id: string;
  origin_encounter_id: string | null;
  referring_practitioner_id: string;
  direction: 'internal' | 'external';
  receiving_practitioner_id: string | null;
  receiving_provider: string | null;
  receiving_specialty: string | null;
  reason: string;
  urgency: Referral['urgency'];
  status: ReferralStatus;
  due_date: string | Date | null;
  completed_at: string | null;
  closure_reason: string | null;
  linked_appointment_id: string | null;
  linked_document_id: string | null;
  notes: string | null;
  created_at: string;
}

function mapReferral(r: ReferralRow): Referral {
  return {
    id: r.id,
    patientId: r.patient_id,
    originEncounterId: r.origin_encounter_id,
    referringPractitionerId: r.referring_practitioner_id,
    direction: r.direction,
    receivingPractitionerId: r.receiving_practitioner_id,
    receivingProvider: r.receiving_provider,
    receivingSpecialty: r.receiving_specialty,
    reason: r.reason,
    urgency: r.urgency,
    status: r.status,
    dueDate: toIsoDate(r.due_date),
    completedAt: r.completed_at,
    closureReason: r.closure_reason,
    linkedAppointmentId: r.linked_appointment_id,
    linkedDocumentId: r.linked_document_id,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

const REFERRAL_COLS = `id, patient_id, origin_encounter_id, referring_practitioner_id, direction,
  receiving_practitioner_id, receiving_provider, receiving_specialty, reason, urgency, status,
  due_date, completed_at, closure_reason, linked_appointment_id, linked_document_id, notes,
  created_at`;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
async function assertActiveUser(
  client: PoolClient,
  clinicId: string,
  userId: string,
  label: string,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM app_user WHERE id = $1 AND clinic_id = $2 AND is_active`,
    [userId, clinicId],
  );
  if (!rows[0]) throw new ValidationError(`${label} is not an active user in this clinic`);
}

async function assertAppointmentForPatient(
  client: PoolClient,
  clinicId: string,
  appointmentId: string,
  patientId: string,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM appointment WHERE id = $1 AND clinic_id = $2 AND patient_id = $3`,
    [appointmentId, clinicId, patientId],
  );
  if (!rows[0]) throw new ValidationError('appointmentId does not belong to this patient');
}

async function assertDocumentForPatient(
  client: PoolClient,
  clinicId: string,
  documentId: string,
  patientId: string,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM document_reference WHERE id = $1 AND clinic_id = $2 AND patient_id = $3`,
    [documentId, clinicId, patientId],
  );
  if (!rows[0]) throw new ValidationError('documentId does not belong to this patient');
}

async function recordHistory(
  client: PoolClient,
  input: { clinicId: string; referralId: string; from: ReferralStatus | null; to: ReferralStatus; reason: string | null; actorId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO referral_status_history (clinic_id, referral_id, from_status, to_status, reason, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.clinicId, input.referralId, input.from, input.to, input.reason, input.actorId],
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export async function createReferral(principal: Principal, raw: unknown): Promise<Referral> {
  requirePermission(principal, Permission.REFERRAL_CREATE);

  const parsed = CreateReferralSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid referral', parsed.error.flatten());
  const input = parsed.data;

  const patient = await getPatientById(principal.clinicId, input.patientId);
  if (!patient) throw new NotFoundError('Patient');
  if (patient.status === 'merged') {
    throw new ConflictError('This record was merged; refer the surviving patient', { mergedIntoId: patient.mergedIntoId });
  }
  if (patient.status === 'deceased') {
    throw new ConflictError('This patient record is marked deceased');
  }

  return withTransaction(async (client) => {
    if (input.encounterId) {
      const encounter = await findEncounter(principal.clinicId, input.encounterId);
      if (!encounter || encounter.patientId !== patient.id) {
        throw new ValidationError('encounterId does not belong to this patient');
      }
    }
    if (input.receivingPractitionerId) {
      await assertActiveUser(client, principal.clinicId, input.receivingPractitionerId, 'receivingPractitionerId');
    }

    const status: ReferralStatus = input.order ? 'ordered' : 'draft';
    const { rows } = await client.query<ReferralRow>(
      `INSERT INTO referral
         (clinic_id, patient_id, origin_encounter_id, referring_practitioner_id, direction,
          receiving_practitioner_id, receiving_provider, receiving_specialty, reason, urgency,
          status, due_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${REFERRAL_COLS}`,
      [
        principal.clinicId,
        patient.id,
        input.encounterId ?? null,
        principal.userId,
        input.direction,
        input.receivingPractitionerId ?? null,
        input.receivingProvider ?? null,
        input.receivingSpecialty ?? null,
        input.reason,
        input.urgency,
        status,
        input.dueDate ?? null,
        input.notes ?? null,
        principal.userId,
      ],
    );
    const referral = mapReferral(rows[0]!);

    await recordHistory(client, { clinicId: principal.clinicId, referralId: referral.id, from: null, to: status, reason: null, actorId: principal.userId });

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.REFERRAL_CREATED,
      subjectType: 'referral',
      subjectId: referral.id,
      actorId: principal.userId,
      // Identifiers, direction, specialty and urgency — the clinical reason and
      // notes stay in the record, out of the event.
      payload: {
        patientId: patient.id,
        direction: referral.direction,
        specialty: referral.receivingSpecialty,
        urgency: referral.urgency,
        status: referral.status,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'referral.create',
      outcome: 'success',
      targetType: 'referral',
      targetId: referral.id,
      metadata: { patientId: patient.id, direction: referral.direction, urgency: referral.urgency, status: referral.status },
    });

    return referral;
  });
}

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------
export async function transitionReferral(
  principal: Principal,
  referralId: string,
  raw: unknown,
): Promise<Referral> {
  const parsed = TransitionReferralSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid transition', parsed.error.flatten());
  const { status: to, reason, appointmentId, documentId } = parsed.data;

  // Authorization is the target's authority: completion is clinical
  // (referral:complete), the rest is administrative (referral:manage). Asserted
  // before any state is read or changed.
  requirePermission(principal, permissionForTransition(to));

  return withTransaction(async (client) => {
    const { rows: locked } = await client.query<ReferralRow>(
      `SELECT ${REFERRAL_COLS} FROM referral WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [referralId, principal.clinicId],
    );
    if (!locked[0]) throw new NotFoundError('Referral');
    const existing = mapReferral(locked[0]);

    if (existing.status === to) throw new ConflictError(`Referral is already ${to}`);
    if (!canTransition(existing.status, to)) {
      throw new ConflictError(`Cannot move a referral from ${existing.status} to ${to}`, {
        from: existing.status,
        to,
        allowed: ALLOWED_TRANSITIONS[existing.status],
      });
    }

    if (appointmentId) {
      await assertAppointmentForPatient(client, principal.clinicId, appointmentId, existing.patientId);
    }
    if (documentId) {
      await assertDocumentForPatient(client, principal.clinicId, documentId, existing.patientId);
    }

    const completing = to === 'completed';
    const { rows } = await client.query<ReferralRow>(
      `UPDATE referral
          SET status = $3::text,
              completed_at = CASE WHEN $3::text = 'completed' THEN now() ELSE completed_at END,
              closure_reason = CASE WHEN $4::text = ANY(ARRAY['cancelled','declined','expired'])
                                    THEN $5 ELSE closure_reason END,
              linked_appointment_id = COALESCE($6::uuid, linked_appointment_id),
              linked_document_id = COALESCE($7::uuid, linked_document_id),
              updated_by = $8,
              updated_at = now()
        WHERE id = $1 AND clinic_id = $2
        RETURNING ${REFERRAL_COLS}`,
      [
        referralId,
        principal.clinicId,
        to,
        to,
        reason ?? null,
        appointmentId ?? null,
        documentId ?? null,
        principal.userId,
      ],
    );
    const updated = mapReferral(rows[0]!);

    await recordHistory(client, { clinicId: principal.clinicId, referralId, from: existing.status, to, reason: reason ?? null, actorId: principal.userId });

    const eventType = EVENT_FOR_STATUS[to];
    if (eventType) {
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: eventType,
        subjectType: 'referral',
        subjectId: referralId,
        actorId: principal.userId,
        payload: {
          patientId: updated.patientId,
          from: existing.status,
          direction: updated.direction,
          urgency: updated.urgency,
        },
      });
    }
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'referral.transition',
      outcome: 'success',
      targetType: 'referral',
      targetId: referralId,
      metadata: { patientId: updated.patientId, from: existing.status, to, terminal: TERMINAL.includes(to) },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export interface ReferralDetail {
  referral: Referral;
  history: { fromStatus: string | null; toStatus: string; reason: string | null; actorId: string | null; createdAt: string }[];
}

export async function getReferral(principal: Principal, referralId: string): Promise<ReferralDetail> {
  requirePermission(principal, Permission.REFERRAL_READ);
  const { rows } = await getPool().query<ReferralRow>(
    `SELECT ${REFERRAL_COLS} FROM referral WHERE id = $1 AND clinic_id = $2`,
    [referralId, principal.clinicId],
  );
  if (!rows[0]) throw new NotFoundError('Referral');

  const { rows: history } = await getPool().query<{
    from_status: string | null;
    to_status: string;
    reason: string | null;
    actor_id: string | null;
    created_at: string;
  }>(
    `SELECT from_status, to_status, reason, actor_id, created_at
       FROM referral_status_history WHERE clinic_id = $1 AND referral_id = $2
      ORDER BY created_at, id`,
    [principal.clinicId, referralId],
  );

  return {
    referral: mapReferral(rows[0]),
    history: history.map((h) => ({
      fromStatus: h.from_status,
      toStatus: h.to_status,
      reason: h.reason,
      actorId: h.actor_id,
      createdAt: h.created_at,
    })),
  };
}

export async function listReferrals(principal: Principal, rawQuery: unknown): Promise<Referral[]> {
  requirePermission(principal, Permission.REFERRAL_READ);
  const parsed = ListReferralsQuery.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());
  const q = parsed.data;

  const { rows } = await getPool().query<ReferralRow>(
    `SELECT ${REFERRAL_COLS} FROM referral
      WHERE clinic_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::uuid IS NULL OR patient_id = $3)
        AND ($4::text IS NULL OR direction = $4)
      ORDER BY created_at DESC
      LIMIT $5`,
    [principal.clinicId, q.status ?? null, q.patientId ?? null, q.direction ?? null, q.limit],
  );
  return rows.map(mapReferral);
}

/** A patient's referrals — used by Patient 360 and the timeline join. */
export async function listPatientReferrals(
  principal: Principal,
  patientId: string,
  limit = 50,
): Promise<Referral[]> {
  requirePermission(principal, Permission.REFERRAL_READ);
  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');
  const { rows } = await getPool().query<ReferralRow>(
    `SELECT ${REFERRAL_COLS} FROM referral
      WHERE clinic_id = $1 AND patient_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [principal.clinicId, patient.id, limit],
  );
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'referral.list',
    outcome: 'success',
    targetType: 'patient',
    targetId: patient.id,
    metadata: { count: rows.length },
  });
  return rows.map(mapReferral);
}

// ---------------------------------------------------------------------------
// SLA / expiry detection (referral hardening)
//
// A referral with a due_date that passes while still open has breached its SLA.
// Detection classifies referrals against a reference date (a READ) and an
// idempotent sweep publishes REFERRAL_SLA_BREACHED at most once per referral.
// It NEVER auto-transitions a referral's clinical status — expiry stays an
// explicit, human decision; the platform only surfaces the breach for Agent 3.
// ---------------------------------------------------------------------------
const SLA_OPEN_STATUSES: readonly ReferralStatus[] = ['draft', 'ordered', 'sent', 'accepted', 'scheduled'];

export type ReferralSlaState = 'no_due_date' | 'within_sla' | 'approaching' | 'breached';

export function classifyReferralSla(
  dueDate: string | null,
  status: ReferralStatus,
  asOf: string,
  approachingDays: number,
): ReferralSlaState {
  if (!dueDate || !SLA_OPEN_STATUSES.includes(status)) return dueDate ? 'within_sla' : 'no_due_date';
  if (dueDate < asOf) return 'breached';
  const horizon = new Date(`${asOf}T00:00:00.000Z`);
  horizon.setUTCDate(horizon.getUTCDate() + approachingDays);
  if (dueDate <= horizon.toISOString().slice(0, 10)) return 'approaching';
  return 'within_sla';
}

const SlaQuery = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  approachingDays: z.coerce.number().int().min(1).max(90).default(7),
  state: z.enum(['within_sla', 'approaching', 'breached']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function getReferralSlaDetection(principal: Principal, rawQuery: unknown): Promise<{ asOf: string; entries: Array<{ id: string; patientId: string; status: ReferralStatus; dueDate: string | null; slaState: ReferralSlaState }> }> {
  requirePermission(principal, Permission.REFERRAL_READ);
  const parsed = SlaQuery.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());
  const asOf = parsed.data.asOf ?? todayIso();
  const { rows } = await getPool().query<ReferralRow>(
    `SELECT ${REFERRAL_COLS} FROM referral
      WHERE clinic_id = $1 AND status = ANY($2::text[]) AND due_date IS NOT NULL
      ORDER BY due_date ASC LIMIT $3`,
    [principal.clinicId, SLA_OPEN_STATUSES, parsed.data.limit],
  );
  const entries = rows
    .map((r) => {
      const ref = mapReferral(r);
      return { id: ref.id, patientId: ref.patientId, status: ref.status, dueDate: ref.dueDate, slaState: classifyReferralSla(ref.dueDate, ref.status, asOf, parsed.data.approachingDays) };
    })
    .filter((e) => (parsed.data.state ? e.slaState === parsed.data.state : true));
  return { asOf, entries };
}

export async function runReferralSlaSweep(principal: Principal): Promise<{ asOf: string; scanned: number; breachedEmitted: number }> {
  requirePermission(principal, Permission.REFERRAL_MANAGE);
  const asOf = todayIso();
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; patient_id: string; due_date: string | Date }>(
      `SELECT id, patient_id, due_date FROM referral
        WHERE clinic_id = $1 AND status = ANY($2::text[])
          AND due_date IS NOT NULL AND due_date < $3::date AND sla_breach_event_at IS NULL
        ORDER BY due_date ASC
        FOR UPDATE SKIP LOCKED`,
      [principal.clinicId, SLA_OPEN_STATUSES, asOf],
    );
    let breachedEmitted = 0;
    for (const row of rows) {
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.REFERRAL_SLA_BREACHED,
        subjectType: 'referral',
        subjectId: row.id,
        actorId: principal.userId,
        payload: { patientId: row.patient_id, dueDate: toIsoDate(row.due_date) },
      });
      await client.query(`UPDATE referral SET sla_breach_event_at = now() WHERE id = $1 AND clinic_id = $2`, [row.id, principal.clinicId]);
      breachedEmitted += 1;
    }
    if (breachedEmitted > 0) {
      await auditTx(client, { clinicId: principal.clinicId, actorId: principal.userId, action: 'referral.sla.sweep', outcome: 'success', targetType: 'clinic', targetId: principal.clinicId, metadata: { asOf, scanned: rows.length, breachedEmitted } });
    }
    return { asOf, scanned: rows.length, breachedEmitted };
  });
}
