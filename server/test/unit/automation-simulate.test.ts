import { describe, expect, it } from 'vitest';
import { simulateRule } from '../../src/modules/automation/simulate.js';
import type { AutomationRule, EventContext } from '../../src/modules/automation/automation.types.js';

/**
 * Unit tests for the pure dry-run rule simulator. Everything is in-memory: no
 * DB, no network, no message sending. The simulator must only ever return a
 * report structure — there is nothing to execute or deliver.
 */

function makeRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule-1',
    clinicId: 'clinic-1',
    name: 'Welcome message',
    description: null,
    triggerType: 'event',
    eventType: 'PATIENT_CHECKED_IN',
    scheduleCron: null,
    conditions: [{ field: 'payload.priority', op: 'gt', value: 3 }],
    actions: [
      { type: 'send_message', params: {} },
      { type: 'schedule_action', params: {} },
      { type: 'noop', params: {} },
    ],
    isEnabled: true,
    priority: 100,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventContext> = {}): EventContext {
  return {
    type: 'PATIENT_CHECKED_IN',
    subjectType: 'encounter',
    subjectId: 'enc-1',
    clinicId: 'clinic-1',
    actorId: 'user-1',
    payload: { patientId: 'pat-1', priority: 5 },
    occurredAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('simulateRule (pure dry-run, no side effects)', () => {
  it('matching event + passing conditions ⇒ every action would execute with the right reason', () => {
    const sim = simulateRule(makeRule(), makeEvent());

    expect(sim.ruleId).toBe('rule-1');
    expect(sim.ruleName).toBe('Welcome message');
    expect(sim.isEnabled).toBe(true);
    expect(sim.triggerMatched).toBe(true);
    expect(sim.triggerReason).toBe('event PATIENT_CHECKED_IN matches');
    expect(sim.conditionsPassed).toBe(true);

    expect(sim.conditions).toEqual([{ field: 'payload.priority', op: 'gt', value: 3, passed: true }]);

    expect(sim.actions).toEqual([
      {
        index: 0,
        type: 'send_message',
        wouldExecute: true,
        reason: 'would_send (subject to consent, quiet-hours and frequency caps at delivery time)',
      },
      { index: 1, type: 'schedule_action', wouldExecute: true, reason: 'would_schedule a future action' },
      { index: 2, type: 'noop', wouldExecute: true, reason: 'would_noop' },
    ]);

    // The send_message reason must surface the delivery-time safety gates.
    const send = sim.actions[0]!;
    expect(send.reason).toContain('consent');
    expect(send.reason).toContain('quiet-hours');
    expect(send.reason).toContain('frequency');
  });

  it('non-matching event ⇒ trigger_mismatch and nothing would execute', () => {
    const sim = simulateRule(makeRule(), makeEvent({ type: 'PATIENT_DISCHARGED' }));

    expect(sim.triggerMatched).toBe(false);
    expect(sim.triggerReason).toBe('rule triggers on PATIENT_CHECKED_IN, event is PATIENT_DISCHARGED');
    for (const action of sim.actions) {
      expect(action.wouldExecute).toBe(false);
      expect(action.reason).toBe('trigger_mismatch');
    }
  });

  it('a failing condition ⇒ conditions_not_met and nothing would execute', () => {
    const sim = simulateRule(makeRule(), makeEvent({ payload: { priority: 1 } }));

    expect(sim.triggerMatched).toBe(true);
    expect(sim.conditionsPassed).toBe(false);
    expect(sim.conditions[0]!.passed).toBe(false);
    for (const action of sim.actions) {
      expect(action.wouldExecute).toBe(false);
      expect(action.reason).toBe('conditions_not_met');
    }
  });

  it('a disabled rule ⇒ rule_disabled even when trigger and conditions match', () => {
    const sim = simulateRule(makeRule({ isEnabled: false }), makeEvent());

    expect(sim.triggerMatched).toBe(true);
    expect(sim.conditionsPassed).toBe(true);
    expect(sim.isEnabled).toBe(false);
    for (const action of sim.actions) {
      expect(action.wouldExecute).toBe(false);
      expect(action.reason).toBe('rule_disabled');
    }
  });

  it('returns a report structure only — it is pure, there is nothing to send', () => {
    const rule = makeRule();
    const event = makeEvent();
    const sim = simulateRule(rule, event);

    // Report shape only; no execution surface leaked.
    expect(Object.keys(sim).sort()).toEqual(
      ['actions', 'conditionsPassed', 'conditions', 'isEnabled', 'ruleId', 'ruleName', 'triggerMatched', 'triggerReason'].sort(),
    );
    // Inputs are not mutated by the pure simulation.
    expect(rule.isEnabled).toBe(true);
    expect(event.type).toBe('PATIENT_CHECKED_IN');
  });

  it('omits value for conditions that carry none (e.g. exists/absent)', () => {
    const sim = simulateRule(
      makeRule({ conditions: [{ field: 'payload.patientId', op: 'exists' }] }),
      makeEvent(),
    );
    expect(sim.conditions[0]).toEqual({ field: 'payload.patientId', op: 'exists', passed: true });
    expect('value' in sim.conditions[0]!).toBe(false);
  });
});
