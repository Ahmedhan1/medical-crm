import { z } from 'zod';
import { getPool } from '../../db/pool.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { audit } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';

/**
 * The patient timeline (blueprint §4.3): every clinical entry for one patient in
 * one chronological stream.
 *
 * Each source contributes a fragment with the same shape, so adding a new
 * clinical record type to the timeline is a one-entry change here rather than a
 * rewrite of the query. Every fragment is scoped by BOTH `clinic_id` and
 * `patient_id` — tenant isolation is part of each branch, not bolted on outside
 * the union where a future edit could miss it.
 */
const TIMELINE_SOURCES: readonly string[] = [
  `SELECT e.id::text AS entry_id, 'visit' AS kind, e.checked_in_at AS occurred_at,
          e.id AS encounter_id, NULL::text AS summary,
          jsonb_build_object('status', e.status) AS detail
     FROM encounter e
    WHERE e.clinic_id = $1 AND e.patient_id = $2`,

  `SELECT i.id::text, 'intake', i.created_at, i.encounter_id, i.chief_complaint,
          jsonb_build_object('source', i.source)
     FROM intake i
    WHERE i.clinic_id = $1 AND i.patient_id = $2`,

  `SELECT v.id::text, 'vitals', v.recorded_at, v.encounter_id, NULL::text,
          jsonb_strip_nulls(jsonb_build_object(
            'systolicBp', v.systolic_bp, 'diastolicBp', v.diastolic_bp,
            'heartRate', v.heart_rate, 'respiratoryRate', v.respiratory_rate,
            'temperatureC', v.temperature_c, 'spo2', v.spo2,
            'weightKg', v.weight_kg, 'heightCm', v.height_cm, 'bmi', v.bmi,
            'bloodGlucoseMgdl', v.blood_glucose_mgdl, 'painScore', v.pain_score))
     FROM vital v
    WHERE v.clinic_id = $1 AND v.patient_id = $2`,

  `SELECT a.id::text, 'assessment', a.updated_at, a.encounter_id, a.summary,
          jsonb_strip_nulls(jsonb_build_object('severity', a.severity))
     FROM assessment a
    WHERE a.clinic_id = $1 AND a.patient_id = $2`,

  `SELECT d.id::text, 'diagnosis', d.created_at, d.encounter_id, d.description,
          jsonb_strip_nulls(jsonb_build_object(
            'category', d.category, 'certainty', d.certainty, 'status', d.status,
            'code', d.code, 'codeSystem', d.code_system))
     FROM diagnosis d
    WHERE d.clinic_id = $1 AND d.patient_id = $2`,

  `SELECT t.id::text, 'treatment_plan', t.updated_at, t.encounter_id, t.summary,
          jsonb_strip_nulls(jsonb_build_object(
            'instructions', t.instructions, 'followUpInDays', t.follow_up_in_days))
     FROM treatment_plan t
    WHERE t.clinic_id = $1 AND t.patient_id = $2`,

  `SELECT n.id::text, 'note', n.created_at, n.encounter_id, n.body,
          jsonb_strip_nulls(jsonb_build_object(
            'noteType', n.note_type, 'supersedesId', n.supersedes_id))
     FROM clinical_note n
    WHERE n.clinic_id = $1 AND n.patient_id = $2`,

  `SELECT te.id::text, 'treatment_episode', te.created_at, te.origin_encounter_id, te.label,
          jsonb_strip_nulls(jsonb_build_object(
            'status', te.status, 'startedOn', te.started_on, 'endedOn', te.ended_on,
            'discontinuationReason', te.discontinuation_reason))
     FROM treatment_episode te
    WHERE te.clinic_id = $1 AND te.patient_id = $2`,

  `SELECT tr.id::text, 'treatment_response', tr.created_at, tr.encounter_id, tr.notes,
          jsonb_strip_nulls(jsonb_build_object(
            'response', tr.response, 'observedOn', tr.observed_on, 'episodeId', tr.episode_id))
     FROM treatment_response tr
    WHERE tr.clinic_id = $1 AND tr.patient_id = $2`,
];

export interface TimelineEntry {
  id: string;
  kind: string;
  occurredAt: string;
  encounterId: string | null;
  summary: string | null;
  detail: Record<string, unknown>;
}

export interface TimelinePage {
  entries: TimelineEntry[];
  nextCursor: string | null;
}

export const TimelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});

/**
 * Keyset pagination on `(occurred_at, entry_id)`. Offsets drift when a
 * concurrent write lands mid-scroll — a doctor paging through a history would
 * silently skip or repeat entries. A keyset cursor cannot.
 *
 * The cursor carries Postgres' own full-precision rendering of the timestamp,
 * not the millisecond ISO form in the response body: `timestamptz` keeps
 * microseconds, and a cursor rounded to milliseconds would silently skip every
 * entry recorded in the truncated remainder of that millisecond.
 */
function encodeCursor(cursorTs: string, id: string): string {
  return Buffer.from(`${cursorTs}|${id}`, 'utf8').toString('base64url');
}

/** Postgres `timestamptz` text output, e.g. `2026-09-16 05:02:15.773123+00`. */
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;

function decodeCursor(cursor: string): { occurredAt: string; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new ValidationError('Invalid timeline cursor');
  }
  const sep = decoded.lastIndexOf('|');
  if (sep <= 0) throw new ValidationError('Invalid timeline cursor');
  const occurredAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  // Reject anything that is not a timestamp + uuid before it reaches the query.
  if (!PG_TIMESTAMP.test(occurredAt)) throw new ValidationError('Invalid timeline cursor');
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ValidationError('Invalid timeline cursor');
  }
  return { occurredAt, id };
}

interface TimelineRow {
  entry_id: string;
  kind: string;
  // `pg` hydrates timestamptz into a Date; normalized to ISO on the way out so
  // the cursor round-trips through Postgres as a parseable literal.
  occurred_at: Date | string;
  /** Full-precision timestamp text, used only to build the page cursor. */
  cursor_ts: string;
  encounter_id: string | null;
  summary: string | null;
  detail: Record<string, unknown> | null;
}

export async function getPatientTimeline(
  principal: Principal,
  patientId: string,
  rawQuery: unknown,
): Promise<TimelinePage> {
  requirePermission(principal, Permission.TIMELINE_READ);

  const parsed = TimelineQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    throw new ValidationError('Invalid timeline query', parsed.error.flatten());
  }
  const { limit, cursor } = parsed.data;

  // Cross-clinic and unknown are indistinguishable to the caller.
  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const after = cursor ? decodeCursor(cursor) : null;
  const union = TIMELINE_SOURCES.join('\n    UNION ALL\n    ');

  // One extra row tells us whether a further page exists without a count query.
  const { rows } = await getPool().query<TimelineRow>(
    `WITH timeline AS (
       ${union}
     )
     SELECT *, occurred_at::text AS cursor_ts FROM timeline
      WHERE ($3::timestamptz IS NULL
             OR (occurred_at, entry_id) < ($3::timestamptz, $4::text))
      ORDER BY occurred_at DESC, entry_id DESC
      LIMIT $5`,
    [principal.clinicId, patient.id, after?.occurredAt ?? null, after?.id ?? null, limit + 1],
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const entries: TimelineEntry[] = page.map((r) => ({
    id: r.entry_id,
    kind: r.kind,
    occurredAt: new Date(r.occurred_at).toISOString(),
    encounterId: r.encounter_id,
    summary: r.summary,
    detail: r.detail ?? {},
  }));

  // Reading a full clinical history is a high-value access: record who read
  // whose record, with no clinical content in the metadata.
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'patient.timeline.read',
    outcome: 'success',
    targetType: 'patient',
    targetId: patient.id,
    metadata: { entries: entries.length, paged: !!cursor },
  });

  const last = page[page.length - 1];
  return {
    entries,
    nextCursor: hasMore && last ? encodeCursor(last.cursor_ts, last.entry_id) : null,
  };
}
