import { z } from 'zod';
import type { Action, ActionResult, EventContext } from './automation.types.js';
import { resolvePath } from './conditions.js';
import { dispatchMessage } from '../messaging/messaging.service.js';
import { CHANNELS } from '../messaging/messaging.types.js';

/**
 * Action registry — the extensible half of the engine. Each action type has a
 * handler and a params schema; adding a capability means registering a new
 * handler, not editing the engine. Handlers are idempotent: they derive a
 * stable idempotency key from the run so a retried run never double-acts.
 */
export interface ActionContext {
  clinicId: string;
  event: EventContext;
  ruleId: string;
  runId: string;
  /** The run's dedupe key (e.g. 'evt:<id>') — stable per trigger. */
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

/** Resolve the target patient id from explicit field, payload, or subject. */
function resolvePatientId(params: { patientIdField?: string }, event: EventContext): string | null {
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
registerActionHandler(noopHandler);

/** Validate a rule's actions at create/update time. Throws on unknown/invalid. */
export function validateActions(actions: Action[]): void {
  for (const action of actions) {
    const handler = getActionHandler(action.type);
    if (!handler) throw new Error(`Unknown action type: ${action.type}`);
    handler.validate(action.params);
  }
}
