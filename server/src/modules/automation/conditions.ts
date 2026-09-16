import type { Condition, EventContext } from './automation.types.js';

/**
 * Deterministic condition evaluation. Pure and side-effect-free so it is
 * trivially testable and always produces the same verdict for the same input.
 *
 * All conditions must pass (AND semantics) for a rule to fire. A `field` is a
 * dot-path resolved against the event context; a path that does not resolve is
 * treated as `undefined` (so `exists` is false, `eq` is false, etc.).
 */
export function resolvePath(context: EventContext, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return null;
}

export function evaluateCondition(condition: Condition, context: EventContext): boolean {
  const actual = resolvePath(context, condition.field);
  const expected = condition.value;

  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'absent':
      return actual === undefined || actual === null;
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual as never);
    case 'nin':
      return Array.isArray(expected) && !expected.includes(actual as never);
    case 'contains':
      if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected);
      if (Array.isArray(actual)) return actual.includes(expected as never);
      return false;
    case 'gt': {
      const a = asNumber(actual);
      const b = asNumber(expected);
      return a !== null && b !== null && a > b;
    }
    case 'lt': {
      const a = asNumber(actual);
      const b = asNumber(expected);
      return a !== null && b !== null && a < b;
    }
    default:
      return false;
  }
}

/** True only if every condition passes (empty list ⇒ always matches). */
export function evaluateConditions(conditions: Condition[], context: EventContext): boolean {
  return conditions.every((c) => evaluateCondition(c, context));
}
