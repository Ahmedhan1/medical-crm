import { describe, expect, it } from 'vitest';
import { resolveScheduledFor } from '../../src/modules/automation/scheduler.js';

describe('resolveScheduledFor', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('applies a relative delay in seconds', () => {
    expect(resolveScheduledFor({ delaySeconds: 3600 }, now).toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });

  it('clamps a negative delay to now', () => {
    expect(resolveScheduledFor({ delaySeconds: -50 }, now).getTime()).toBe(now.getTime());
  });

  it('accepts an absolute ISO time', () => {
    expect(resolveScheduledFor({ at: '2026-02-01T09:00:00Z' }, now).toISOString()).toBe('2026-02-01T09:00:00.000Z');
  });

  it('prefers delaySeconds when both are given', () => {
    expect(resolveScheduledFor({ delaySeconds: 60, at: '2030-01-01T00:00:00Z' }, now).toISOString()).toBe(
      '2026-01-01T00:01:00.000Z',
    );
  });

  it('falls back to now on an invalid time', () => {
    expect(resolveScheduledFor({ at: 'not-a-date' }, now).getTime()).toBe(now.getTime());
  });
});
