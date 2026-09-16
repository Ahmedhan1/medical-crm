import { getPool, withTransaction } from '../../db/pool.js';
import { NotFoundError } from '../../domain/errors.js';
import { auditTx } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import type { Channel } from './messaging.types.js';

/**
 * Communication-quality policy (blueprint §16 reliability; program Phase 38).
 *
 * Guards against spamming a patient: quiet hours (evaluated in the clinic's
 * timezone) and frequency caps (a minimum gap between messages and a rolling
 * 24-hour cap). Policy is per-clinic and optionally per-channel; with NO policy
 * configured the behaviour is fully permissive, so clinics that never set one
 * behave exactly as before.
 *
 * Enforced centrally in the send pipeline (immediate sends are suppressed) and
 * used by the scheduler to defer scheduled sends past quiet hours.
 */
export interface MessagingPolicy {
  clinicId: string;
  channel: Channel | 'all';
  quietHoursEnabled: boolean;
  quietStartHour: number;
  quietEndHour: number;
  dailyCap: number | null;
  minGapMinutes: number;
  timeZone: string;
}

interface PolicyRow {
  clinic_id: string;
  channel: Channel | 'all';
  quiet_hours_enabled: boolean;
  quiet_start_hour: number;
  quiet_end_hour: number;
  daily_cap: number | null;
  min_gap_minutes: number;
  time_zone: string;
}

function mapPolicy(r: PolicyRow): MessagingPolicy {
  return {
    clinicId: r.clinic_id,
    channel: r.channel,
    quietHoursEnabled: r.quiet_hours_enabled,
    quietStartHour: r.quiet_start_hour,
    quietEndHour: r.quiet_end_hour,
    dailyCap: r.daily_cap,
    minGapMinutes: r.min_gap_minutes,
    timeZone: r.time_zone,
  };
}

/**
 * Effective policy for a clinic+channel: the exact-channel row, else the 'all'
 * row, else permissive defaults. The clinic timezone is always resolved (for
 * quiet-hours evaluation) even when no policy row exists.
 */
export async function getEffectivePolicy(
  clinicId: string,
  channel: Channel,
): Promise<MessagingPolicy> {
  const { rows } = await getPool().query<PolicyRow>(
    `SELECT p.clinic_id, p.channel, p.quiet_hours_enabled, p.quiet_start_hour,
            p.quiet_end_hour, p.daily_cap, p.min_gap_minutes, c.timezone AS time_zone
       FROM clinic c
       LEFT JOIN messaging_policy p
         ON p.clinic_id = c.id AND p.channel IN ($2, 'all')
      WHERE c.id = $1
      ORDER BY (p.channel = $2) DESC NULLS LAST
      LIMIT 1`,
    [clinicId, channel],
  );
  const row = rows[0];
  if (!row) {
    // Clinic not found → permissive default with UTC (send path guards existence).
    return permissiveDefault(clinicId, channel, 'UTC');
  }
  if (row.channel === null || row.quiet_hours_enabled === null) {
    // Clinic exists but has no policy row (LEFT JOIN nulls) → permissive default.
    return permissiveDefault(clinicId, channel, row.time_zone ?? 'UTC');
  }
  return mapPolicy(row);
}

function permissiveDefault(clinicId: string, channel: Channel, timeZone: string): MessagingPolicy {
  return {
    clinicId,
    channel,
    quietHoursEnabled: false,
    quietStartHour: 21,
    quietEndHour: 8,
    dailyCap: null,
    minGapMinutes: 0,
    timeZone,
  };
}

// --- Quiet hours -----------------------------------------------------------

/** The hour-of-day (0–23) of `date` in the given IANA timezone. */
export function hourInTimeZone(date: Date, timeZone: string): number {
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(date);
    return Number(s) % 24;
  } catch {
    return date.getUTCHours(); // unknown tz → fall back to UTC
  }
}

/** Is `hour` within the [start, end) quiet window (which may wrap midnight)? */
export function isQuietHour(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false; // empty window
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // wraps midnight
}

export function inQuietHours(policy: MessagingPolicy, at: Date): boolean {
  if (!policy.quietHoursEnabled) return false;
  const hour = hourInTimeZone(at, policy.timeZone);
  return isQuietHour(hour, policy.quietStartHour, policy.quietEndHour);
}

/**
 * The next instant at/after `from` that is NOT within quiet hours. Steps forward
 * hour-by-hour (bounded to 24 iterations), preserving the original minute — no
 * fragile timezone date construction, no dependency.
 */
export function nextAllowedTime(policy: MessagingPolicy, from: Date): Date {
  if (!inQuietHours(policy, from)) return from;
  for (let k = 1; k <= 24; k++) {
    const candidate = new Date(from.getTime() + k * 3_600_000);
    if (!inQuietHours(policy, candidate)) return candidate;
  }
  return from; // window covers the whole day (shouldn't happen) → don't loop forever
}

// --- Frequency caps --------------------------------------------------------

export type FrequencyBlock = null | 'min_gap' | 'daily_cap';

/**
 * Whether a send to this patient+channel is currently blocked by frequency
 * limits. Counts only messages that actually went out or are in flight
 * (queued/sent/delivered) — suppressed/failed ones don't count against a patient.
 */
export async function frequencyBlock(
  policy: MessagingPolicy,
  patientId: string,
  channel: Channel,
): Promise<FrequencyBlock> {
  if (policy.minGapMinutes > 0) {
    const gap = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_log
        WHERE clinic_id = $1 AND patient_id = $2 AND channel = $3
          AND status IN ('queued','sent','delivered')
          AND created_at > now() - ($4 || ' minutes')::interval`,
      [policy.clinicId, patientId, channel, String(policy.minGapMinutes)],
    );
    if (Number(gap.rows[0]!.n) > 0) return 'min_gap';
  }
  if (policy.dailyCap !== null) {
    const day = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM message_log
        WHERE clinic_id = $1 AND patient_id = $2 AND channel = $3
          AND status IN ('queued','sent','delivered')
          AND created_at > now() - interval '24 hours'`,
      [policy.clinicId, patientId, channel],
    );
    if (Number(day.rows[0]!.n) >= policy.dailyCap) return 'daily_cap';
  }
  return null;
}

// --- Admin: set/read policy ------------------------------------------------

export interface SetPolicyInput {
  channel?: Channel | 'all';
  quietHoursEnabled?: boolean;
  quietStartHour?: number;
  quietEndHour?: number;
  dailyCap?: number | null;
  minGapMinutes?: number;
}

export async function setPolicy(principal: Principal, input: SetPolicyInput): Promise<MessagingPolicy> {
  requirePermission(principal, Permission.MESSAGING_MANAGE);
  const channel = input.channel ?? 'all';

  return withTransaction(async (client) => {
    const clinic = await client.query<{ timezone: string }>(
      `SELECT timezone FROM clinic WHERE id = $1`,
      [principal.clinicId],
    );
    if (clinic.rows.length === 0) throw new NotFoundError('Clinic');

    const { rows } = await client.query<Omit<PolicyRow, 'time_zone'>>(
      `INSERT INTO messaging_policy
         (clinic_id, channel, quiet_hours_enabled, quiet_start_hour, quiet_end_hour,
          daily_cap, min_gap_minutes, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (clinic_id, channel) DO UPDATE SET
          quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
          quiet_start_hour    = EXCLUDED.quiet_start_hour,
          quiet_end_hour      = EXCLUDED.quiet_end_hour,
          daily_cap           = EXCLUDED.daily_cap,
          min_gap_minutes     = EXCLUDED.min_gap_minutes,
          updated_by          = EXCLUDED.updated_by,
          updated_at          = now()
       RETURNING clinic_id, channel, quiet_hours_enabled, quiet_start_hour,
                 quiet_end_hour, daily_cap, min_gap_minutes`,
      [
        principal.clinicId,
        channel,
        input.quietHoursEnabled ?? false,
        input.quietStartHour ?? 21,
        input.quietEndHour ?? 8,
        input.dailyCap ?? null,
        input.minGapMinutes ?? 0,
        principal.userId,
      ],
    );
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'messaging.policy.set',
      outcome: 'success',
      targetType: 'messaging_policy',
      targetId: channel,
      metadata: { channel, quietHoursEnabled: input.quietHoursEnabled ?? false, dailyCap: input.dailyCap ?? null },
    });
    return mapPolicy({ ...rows[0]!, time_zone: clinic.rows[0]!.timezone });
  });
}

export async function listPolicies(principal: Principal): Promise<MessagingPolicy[]> {
  requirePermission(principal, Permission.MESSAGING_READ);
  const { rows } = await getPool().query<PolicyRow>(
    `SELECT p.clinic_id, p.channel, p.quiet_hours_enabled, p.quiet_start_hour,
            p.quiet_end_hour, p.daily_cap, p.min_gap_minutes, c.timezone AS time_zone
       FROM messaging_policy p JOIN clinic c ON c.id = p.clinic_id
      WHERE p.clinic_id = $1 ORDER BY p.channel`,
    [principal.clinicId],
  );
  return rows.map(mapPolicy);
}
