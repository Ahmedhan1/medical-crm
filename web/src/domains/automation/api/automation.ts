import { api } from '../../../lib/api/client.js';

/**
 * Automation + messaging API layer — thin typed wrappers over the EXISTING Agent-3
 * backend endpoints. No invented endpoints, no business logic: the backend is the
 * sole authority (it re-checks RBAC/tenant on every call); these types only mirror
 * what it returns.
 */

// --- Rules ---------------------------------------------------------------
export type ConditionOp = 'eq' | 'ne' | 'in' | 'nin' | 'exists' | 'absent' | 'gt' | 'lt' | 'contains';
export type ActionType = 'send_message' | 'schedule_action' | 'noop';
export type TriggerType = 'event' | 'schedule';

export interface Condition { field: string; op: ConditionOp; value?: unknown }
export interface Action { type: ActionType; params: Record<string, unknown> }

export interface AutomationRule {
  id: string;
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

export interface CreateRuleBody {
  name: string;
  description?: string;
  triggerType?: TriggerType;
  eventType?: string;
  scheduleCron?: string;
  conditions?: Condition[];
  actions: Action[];
  isEnabled?: boolean;
  priority?: number;
}

export function listRules(signal?: AbortSignal): Promise<AutomationRule[]> {
  return api.get<{ rules: AutomationRule[] }>('/automations', { signal }).then((r) => r.rules);
}
export function getRule(id: string, signal?: AbortSignal): Promise<AutomationRule> {
  return api.get<AutomationRule>(`/automations/${id}`, { signal });
}
export function createRule(body: CreateRuleBody): Promise<AutomationRule> {
  return api.post<AutomationRule>('/automations', body);
}
export function updateRule(id: string, body: Partial<CreateRuleBody>): Promise<AutomationRule> {
  return api.patch<AutomationRule>(`/automations/${id}`, body);
}
export function setRuleEnabled(id: string, isEnabled: boolean): Promise<AutomationRule> {
  return api.patch<AutomationRule>(`/automations/${id}`, { isEnabled });
}

// --- Runs (execution history) --------------------------------------------
export type RunStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';
export interface ActionResult { type: string; status: 'ok' | 'error' | 'skipped'; detail?: Record<string, unknown>; error?: string }
export interface AutomationRun {
  id: string;
  ruleId: string;
  status: RunStatus;
  matched: boolean;
  attempts: number;
  actionResults: ActionResult[];
  lastError: string | null;
  startedAt: string;
  finishedAt: string | null;
}
export function listRuns(ruleId: string, signal?: AbortSignal): Promise<AutomationRun[]> {
  return api.get<{ runs: AutomationRun[] }>(`/automations/${ruleId}/runs`, { signal }).then((r) => r.runs);
}

// --- Simulation (dry-run) ------------------------------------------------
export interface SimulatedCondition { field: string; op: string; value?: unknown; passed: boolean }
export interface SimulatedAction { index: number; type: string; wouldExecute: boolean; reason: string }
export interface RuleSimulation {
  ruleId: string;
  ruleName: string;
  isEnabled: boolean;
  triggerMatched: boolean;
  triggerReason: string;
  conditionsPassed: boolean;
  conditions: SimulatedCondition[];
  actions: SimulatedAction[];
}
export interface SimulateEvent { type: string; subjectType?: string; subjectId?: string; payload?: Record<string, unknown> }
export function simulateRule(id: string, event: SimulateEvent): Promise<RuleSimulation> {
  return api.post<RuleSimulation>(`/automations/${id}/simulate`, { event });
}

// --- Scheduled actions (time engine, incl. dead-letter) -------------------
export type ScheduledStatus = 'pending' | 'executing' | 'done' | 'failed' | 'cancelled' | 'expired';
export interface ScheduledAction {
  id: string;
  ruleId: string | null;
  actionType: string;
  status: ScheduledStatus;
  scheduledFor: string;
  expiresAt: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export function listScheduledActions(status: ScheduledStatus | undefined, signal?: AbortSignal): Promise<ScheduledAction[]> {
  return api
    .get<{ actions: ScheduledAction[] }>('/scheduled-actions', { query: status ? { status } : {}, signal })
    .then((r) => r.actions);
}
export function cancelScheduledAction(id: string): Promise<ScheduledAction> {
  return api.post<ScheduledAction>(`/scheduled-actions/${id}/cancel`);
}

// --- Messaging (delivery log + DLQ retry) --------------------------------
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'suppressed' | 'dead';
export interface MessageRecord {
  id: string;
  patientId: string | null;
  channel: 'whatsapp' | 'sms' | 'email';
  provider: string;
  templateKey: string | null;
  recipientMasked: string | null;
  status: MessageStatus;
  suppressedReason: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export function listMessages(signal?: AbortSignal): Promise<MessageRecord[]> {
  return api.get<{ messages: MessageRecord[] }>('/messages', { signal }).then((r) => r.messages);
}
export function retryMessage(id: string): Promise<{ messageId: string; status: MessageStatus }> {
  return api.post<{ messageId: string; status: MessageStatus }>(`/messages/${id}/retry`);
}

// --- Communication policy (quiet hours / caps visibility) -----------------
export interface MessagingPolicy {
  channel: 'all' | 'whatsapp' | 'sms' | 'email';
  quietHoursEnabled: boolean;
  quietStartHour: number;
  quietEndHour: number;
  dailyCap: number | null;
  minGapMinutes: number;
  timeZone: string;
}
export function listPolicies(signal?: AbortSignal): Promise<MessagingPolicy[]> {
  return api.get<{ policies: MessagingPolicy[] }>('/messaging-policy', { signal }).then((r) => r.policies);
}
