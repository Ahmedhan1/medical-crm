import type { Channel } from '../messaging/messaging.types.js';
import { getEffectivePolicy, nextAllowedTime } from '../messaging/policy.js';
import { insertScheduled, type InsertScheduledInput } from './scheduled.repo.js';
import type { ScheduledAction } from './automation.types.js';

/**
 * Scheduler — the SCHEDULE side of the time engine (blueprint §16; program
 * Phase 3). Enqueues an action to run at/after a future time. Idempotent via a
 * dedupe key. When the action is a patient message, quiet hours defer it (the
 * computed `not_before` pushes the due time past the clinic's quiet window) so
 * a reminder is delayed rather than dropped.
 *
 * This module deliberately does NOT import the action registry (the RUN side is
 * `scheduler.runner.ts`), so there is no import cycle.
 */
export interface ScheduleInput {
  clinicId: string;
  actionType: string;
  params: Record<string, unknown>;
  /** When the action becomes due (absolute). */
  scheduledFor: Date;
  /** Idempotency key — scheduling the same logical action twice is a no-op. */
  dedupeKey?: string | null;
  ruleId?: string | null;
  sourceEventId?: number | null;
  /** Drop the action instead of running it once this time passes. */
  expiresAt?: Date | null;
  maxAttempts?: number;
  createdBy?: string | null;
  /** If set, apply the clinic's quiet-hours policy for this channel via not_before. */
  quietHoursChannel?: Channel;
}

export async function scheduleAction(
  input: ScheduleInput,
): Promise<{ action: ScheduledAction; created: boolean }> {
  let notBefore: Date | null = null;
  if (input.quietHoursChannel) {
    const policy = await getEffectivePolicy(input.clinicId, input.quietHoursChannel);
    const allowed = nextAllowedTime(policy, input.scheduledFor);
    if (allowed.getTime() !== input.scheduledFor.getTime()) notBefore = allowed;
  }

  const repoInput: InsertScheduledInput = {
    clinicId: input.clinicId,
    ruleId: input.ruleId ?? null,
    sourceEventId: input.sourceEventId ?? null,
    actionType: input.actionType,
    params: input.params,
    dedupeKey: input.dedupeKey ?? null,
    scheduledFor: input.scheduledFor,
    notBefore,
    expiresAt: input.expiresAt ?? null,
    maxAttempts: input.maxAttempts,
    createdBy: input.createdBy ?? null,
  };
  return insertScheduled(repoInput);
}

/** Resolve a relative delay or absolute time into a due `Date`. */
export function resolveScheduledFor(opts: { delaySeconds?: number; at?: string }, now = new Date()): Date {
  if (typeof opts.delaySeconds === 'number') {
    return new Date(now.getTime() + Math.max(0, opts.delaySeconds) * 1000);
  }
  if (opts.at) {
    const d = new Date(opts.at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return now;
}
