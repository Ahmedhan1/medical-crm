import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateConditions, resolvePath } from '../../src/modules/automation/conditions.js';
import type { EventContext } from '../../src/modules/automation/automation.types.js';

const ctx: EventContext = {
  type: 'PATIENT_CHECKED_IN',
  subjectType: 'encounter',
  subjectId: 'enc-1',
  clinicId: 'clinic-1',
  actorId: 'user-1',
  payload: { patientId: 'pat-1', priority: 5, tags: ['vip', 'followup'] },
  occurredAt: '2026-01-01T00:00:00Z',
};

describe('automation condition evaluator (deterministic, pure)', () => {
  it('resolves dot-paths into the event context', () => {
    expect(resolvePath(ctx, 'type')).toBe('PATIENT_CHECKED_IN');
    expect(resolvePath(ctx, 'payload.patientId')).toBe('pat-1');
    expect(resolvePath(ctx, 'payload.missing')).toBeUndefined();
    expect(resolvePath(ctx, 'payload.patientId.nope')).toBeUndefined();
  });

  it('evaluates each operator correctly', () => {
    expect(evaluateCondition({ field: 'type', op: 'eq', value: 'PATIENT_CHECKED_IN' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'type', op: 'ne', value: 'OTHER' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'payload.patientId', op: 'exists' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'payload.missing', op: 'absent' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'subjectType', op: 'in', value: ['encounter', 'patient'] }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'subjectType', op: 'nin', value: ['patient'] }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'payload.priority', op: 'gt', value: 3 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'payload.priority', op: 'lt', value: 3 }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'payload.tags', op: 'contains', value: 'vip' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'type', op: 'contains', value: 'CHECKED' }, ctx)).toBe(true);
  });

  it('a missing field never throws and never spuriously matches', () => {
    expect(evaluateCondition({ field: 'payload.missing', op: 'eq', value: 'x' }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'payload.missing', op: 'exists' }, ctx)).toBe(false);
  });

  it('requires ALL conditions to pass (AND); empty list always matches', () => {
    expect(evaluateConditions([], ctx)).toBe(true);
    expect(
      evaluateConditions(
        [
          { field: 'type', op: 'eq', value: 'PATIENT_CHECKED_IN' },
          { field: 'payload.patientId', op: 'exists' },
        ],
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        [
          { field: 'type', op: 'eq', value: 'PATIENT_CHECKED_IN' },
          { field: 'payload.priority', op: 'gt', value: 100 },
        ],
        ctx,
      ),
    ).toBe(false);
  });
});
