import { z } from 'zod';
import type { Action, ActionResult, EventContext } from './automation.types.js';
import { resolvePath } from './conditions.js';
import { dispatchMessage } from '../messaging/messaging.service.js';
import { scheduleAction, resolveScheduledFor } from './scheduler.js';

/**
 * Action registry — the extensible half of the engine. Each action type has a
 * handler and a params schema; adding a capability means registering a new
 * handler, not editing the engine. Handlers are idempotent: they derive a
 * stable idempotency key from the run so a retried run never double-acts.
 */
export interface ActionContext {
  clinicId: string;
  /** The triggering event, when run from an event rule. Absent for scheduled actions. */
  event?: EventContext;
  ruleId: string;
  runId: string;
  /** The run's dedupe key (e.g. 'evt:<id>' or 'sched:<id>') — stable per trigger. */
  dedupeKey: string;
  actionIndex: number;
}

export interface ActionHandler {
  type: string;
  /** Validate params at rule-create time; throws on invalid config. */
  validate(params: Record<string, unknown>): void;
  execute(params: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult>;
}

const registry = new Map<string, ActionHandler>();

export function registerActionHandler(handler: ActionHandler): void {
  registry.set(handler.type, handler);
}

export function getActionHandler(type: string): ActionHandler | undefined {
  return registry.get(type);
}

export function knownActionTypes(): string[] {
  return [...registry.keys()];
}

/**
 * Resolve the target patient id from (in order): an explicit `patientId` param
 * (used by scheduled actions that captured it at schedule time), a dot-path into
 * the event, the event payload's `patientId`, or a patient-subject event.
 */
function resolvePatientId(
  params: { patientId?: string; patientIdField?: string },
  event: EventContext | undefined,
): string | null {
  if (typeof params.patientId === 'string') return params.patientId;
  if (!event) return null;
  if (params.patientIdField) {
    const v = resolvePath(event, params.patientIdField);
    return typeof v === 'string' ? v : null;
  }
  if (typeof event.payload.patientId === 'string') return event.payload.patientId;
  if (event.subjectType === 'patient') return event.subjectId;
  return null;
}

// --- send_message ----------------------------------------------------------

const SendMessageParams = z.object({
  channel: z.enum(['whatsapp', 'sms', 'email']),
  templateKey: z.string().min(1),
  locale: z.string().min(1).max(20).optional(),
  /** Explicit patient id (scheduled actions capture it at schedule time). */
  patientId: z.string().uuid().optional(),
  patientIdField: z.string().min(1).max(200).optional(),
  variables: z.record(z.string()).optional(),
});

const sendMessageHandler: ActionHandler = {
  type: 'send_message',
  validate(params) {
    SendMessageParams.parse(params);
  },
  async execute(params, ctx) {
    const p = SendMessageParams.parse(params);
    const patientId = resolvePatientId(p, ctx.event);
    if (!patientId) {
      return { type: 'send_message', status: 'skipped', detail: { reason: 'no_patient_in_event' } };
    }
    // Stable key: this rule+trigger+action sends at most once even across retries.
    const idempotencyKey = `auto:${ctx.ruleId}:${ctx.dedupeKey}:${ctx.actionIndex}`;
    const outcome = await dispatchMessage({
      clinicId: ctx.clinicId,
      channel: p.channel,
      patientId,
      templateKey: p.templateKey,
      locale: p.locale,
      variables: p.variables,
      idempotencyKey,
      actorId: null, // system-initiated
    });
    return {
      type: 'send_message',
      status: 'ok',
      detail: {
        messageId: outcome.messageId,
        messageStatus: outcome.status,
        suppressedReason: outcome.suppressedReason ?? undefined,
        deduped: outcome.deduped ?? false,
      },
    };
  },
};

// --- schedule_action -------------------------------------------------------
// Enqueue another action to run in the future (the time-engine bridge). Lets an
// event rule schedule a later reminder, e.g. "on FOLLOW_UP_SCHEDULED, send a
// WhatsApp reminder 24h from now". The inner action runs through this same
// registry when due.

const ScheduleActionParams = z
  .object({
    /** Relative delay OR absolute ISO time (delaySeconds wins if both given). */
    delaySeconds: z.number().int().min(0).max(315_360_000).optional(), // ≤10 years
    at: z.string().datetime().optional(),
    /** How long after due before the scheduled action is dropped as stale. */
    expiresInSeconds: z.number().int().min(60).max(315_360_000).optional(),
    /** The action to run when due. Cannot be another schedule_action (no nesting). */
    action: z.object({
      type: z.enum(['send_message', 'noop']),
      params: z.record(z.unknown()).default({}),
    }),
  })
  .refine((v) => v.delaySeconds !== undefined || v.at !== undefined, {
    message: 'schedule_action requires delaySeconds or at',
  });

const scheduleActionHandler: ActionHandler = {
  type: 'schedule_action',
  validate(params) {
    const p = ScheduleActionParams.parse(params);
    // The inner action must itself be a valid, known action.
    const inner = getActionHandler(p.action.type);
    if (!inner) throw new Error(`Unknown inner action type: ${p.action.type}`);
    inner.validate(p.action.params);
  },
  async execute(params, ctx) {
    const p = ScheduleActionParams.parse(params);
    const now = new Date();
    const scheduledFor = resolveScheduledFor({ delaySeconds: p.delaySeconds, at: p.at }, now);
    const expiresAt = p.expiresInSeconds
      ? new Date(scheduledFor.getTime() + p.expiresInSeconds * 1000)
      : null;

    // Carry the resolved patient id forward so the future send needs no event.
    const innerParams = { ...p.action.params };
    if (p.action.type === 'send_message' && innerParams.patientId === undefined) {
      const patientId = resolvePatientId(innerParams as { patientId?: string; patientIdField?: string }, ctx.event);
      if (patientId) innerParams.patientId = patientId;
    }
    const quietHoursChannel =
      p.action.type === 'send_message' && typeof innerParams.channel === 'string'
        ? (innerParams.channel as 'whatsapp' | 'sms' | 'email')
        : undefined;

    // Idempotent per (rule, trigger, action index): a retried run reschedules
    // the SAME action rather than enqueuing a duplicate.
    const dedupeKey = `sched:${ctx.ruleId}:${ctx.dedupeKey}:${ctx.actionIndex}`;
    const { action, created } = await scheduleAction({
      clinicId: ctx.clinicId,
      actionType: p.action.type,
      params: innerParams,
      scheduledFor,
      expiresAt,
      dedupeKey,
      ruleId: ctx.ruleId === 'scheduled' ? null : ctx.ruleId,
      quietHoursChannel,
    });
    return {
      type: 'schedule_action',
      status: 'ok',
      detail: { scheduledActionId: action.id, scheduledFor: action.scheduledFor, created },
    };
  },
};

// --- noop ------------------------------------------------------------------

const noopHandler: ActionHandler = {
  type: 'noop',
  validate() {
    /* no params */
  },
  async execute() {
    return { type: 'noop', status: 'ok' };
  },
};

registerActionHandler(sendMessageHandler);
registerActionHandler(scheduleActionHandler);
registerActionHandler(noopHandler);

/** Validate a rule's actions at create/update time. Throws on unknown/invalid. */
export function validateActions(actions: Action[]): void {
  for (const action of actions) {
    const handler = getActionHandler(action.type);
    if (!handler) throw new Error(`Unknown action type: ${action.type}`);
    handler.validate(action.params);
  }
}
