import { z } from 'zod';

/**
 * Automation rule shape: Event → Conditions → Actions (blueprint §2, §16).
 *
 * Rules are DATA (stored as jsonb), not code, so a clinic administrator can
 * define deterministic automations without a deploy. Conditions and actions are
 * validated against these schemas at create time, so a rule that can never run
 * (unknown action type, malformed condition) is rejected up front.
 */

export const ConditionOp = z.enum(['eq', 'ne', 'in', 'nin', 'exists', 'absent', 'gt', 'lt', 'contains']);
export type ConditionOp = z.infer<typeof ConditionOp>;

export const ConditionSchema = z.object({
  /** Dot-path into the event context, e.g. 'payload.patientId', 'subjectType'. */
  field: z.string().min(1).max(200),
  op: ConditionOp,
  value: z.unknown().optional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

/** Action types the engine knows how to execute. Extend the registry to add more. */
export const ActionType = z.enum(['send_message', 'schedule_action', 'noop']);
export type ActionType = z.infer<typeof ActionType>;

export const ActionSchema = z.object({
  type: ActionType,
  params: z.record(z.unknown()).default({}),
});
export type Action = z.infer<typeof ActionSchema>;

export const TriggerType = z.enum(['event', 'schedule']);
export type TriggerType = z.infer<typeof TriggerType>;

export const CreateRuleSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    triggerType: TriggerType.default('event'),
    eventType: z.string().min(1).max(100).optional(),
    scheduleCron: z.string().min(1).max(100).optional(),
    conditions: z.array(ConditionSchema).max(50).default([]),
    actions: z.array(ActionSchema).min(1).max(20),
    isEnabled: z.boolean().default(true),
    /** Lower runs first when several rules match one event. */
    priority: z.number().int().min(0).max(10000).default(100),
  })
  .superRefine((val, ctx) => {
    if (val.triggerType === 'event' && !val.eventType) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['eventType'], message: 'eventType is required for event triggers' });
    }
    if (val.triggerType === 'schedule' && !val.scheduleCron) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleCron'], message: 'scheduleCron is required for schedule triggers' });
    }
  });
export type CreateRuleInput = z.infer<typeof CreateRuleSchema>;

export const UpdateRuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  conditions: z.array(ConditionSchema).max(50).optional(),
  actions: z.array(ActionSchema).min(1).max(20).optional(),
  isEnabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(10000).optional(),
});
export type UpdateRuleInput = z.infer<typeof UpdateRuleSchema>;

export interface AutomationRule {
  id: string;
  clinicId: string;
  name: string;
  description: string | null;
  triggerType: TriggerType;
  eventType: string | null;
  scheduleCron: string | null;
  conditions: Condition[];
  actions: Action[];
  isEnabled: boolean;
  priority: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledAction {
  id: string;
  clinicId: string;
  ruleId: string | null;
  sourceEventId: number | null;
  actionType: string;
  params: Record<string, unknown>;
  dedupeKey: string | null;
  status: 'pending' | 'executing' | 'done' | 'failed' | 'cancelled' | 'expired';
  scheduledFor: string;
  notBefore: string | null;
  expiresAt: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

export interface AutomationRun {
  id: string;
  clinicId: string;
  ruleId: string;
  triggerEventId: number | null;
  dedupeKey: string;
  status: RunStatus;
  matched: boolean;
  attempts: number;
  actionResults: ActionResult[];
  lastError: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ActionResult {
  type: string;
  status: 'ok' | 'error' | 'skipped';
  detail?: Record<string, unknown>;
  error?: string;
}

/** A stored event as read from the append-only event store. */
export interface StoredEvent {
  id: number;
  clinicId: string;
  type: string;
  subjectType: string;
  subjectId: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/** The context conditions/actions evaluate against. */
export interface EventContext {
  type: string;
  subjectType: string;
  subjectId: string;
  clinicId: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export function toEventContext(event: StoredEvent): EventContext {
  return {
    type: event.type,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    clinicId: event.clinicId,
    actorId: event.actorId,
    payload: event.payload,
    occurredAt: event.occurredAt,
  };
}
