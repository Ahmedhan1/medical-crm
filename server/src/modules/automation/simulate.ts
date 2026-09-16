import type { AutomationRule, EventContext } from './automation.types.js';
import { evaluateCondition, evaluateConditions } from './conditions.js';

/**
 * Pure dry-run simulator for automation rules (blueprint §2, §16).
 *
 * Answers "what WOULD this rule do for this event?" without touching the world:
 * it NEVER executes actions, sends messages, schedules future work, or performs
 * any side effect. It only inspects the rule against a single event context and
 * reports the trigger verdict, per-condition verdicts, and a plan of which
 * actions would run (and why not, when they would not).
 *
 * Because it is pure, it deliberately imports ONLY the shared types and the
 * (also pure) condition evaluator — never the engine, messaging, scheduler,
 * repositories, kernel, or db/pool.
 */

export interface SimulatedConditionResult {
  field: string;
  op: string;
  value?: unknown;
  passed: boolean;
}

export interface SimulatedAction {
  index: number;
  type: string;
  wouldExecute: boolean;
  reason: string;
}

export interface RuleSimulation {
  ruleId: string;
  ruleName: string;
  isEnabled: boolean;
  triggerMatched: boolean;
  triggerReason: string;
  conditionsPassed: boolean;
  conditions: SimulatedConditionResult[];
  actions: SimulatedAction[];
}

/**
 * Simulate one rule against one event. Pure: returns a report only.
 */
export function simulateRule(rule: AutomationRule, event: EventContext): RuleSimulation {
  const triggerMatched = rule.triggerType === 'event' && rule.eventType === event.type;
  const triggerReason = triggerMatched
    ? `event ${event.type} matches`
    : `rule triggers on ${rule.eventType ?? rule.triggerType}, event is ${event.type}`;

  const conditions: SimulatedConditionResult[] = rule.conditions.map((condition) => {
    const result: SimulatedConditionResult = {
      field: condition.field,
      op: condition.op,
      passed: evaluateCondition(condition, event),
    };
    if (condition.value !== undefined) {
      result.value = condition.value;
    }
    return result;
  });

  const conditionsPassed = evaluateConditions(rule.conditions, event);

  const actions: SimulatedAction[] = rule.actions.map((action, index) => {
    const wouldExecute = triggerMatched && rule.isEnabled && conditionsPassed;
    const reason = reasonFor(action.type, triggerMatched, rule.isEnabled, conditionsPassed);
    return { index, type: action.type, wouldExecute, reason };
  });

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    isEnabled: rule.isEnabled,
    triggerMatched,
    triggerReason,
    conditionsPassed,
    conditions,
    actions,
  };
}

function reasonFor(
  actionType: string,
  triggerMatched: boolean,
  isEnabled: boolean,
  conditionsPassed: boolean,
): string {
  if (!triggerMatched) return 'trigger_mismatch';
  if (!isEnabled) return 'rule_disabled';
  if (!conditionsPassed) return 'conditions_not_met';
  switch (actionType) {
    case 'send_message':
      return 'would_send (subject to consent, quiet-hours and frequency caps at delivery time)';
    case 'schedule_action':
      return 'would_schedule a future action';
    case 'noop':
      return 'would_noop';
    default:
      return 'would_run';
  }
}
