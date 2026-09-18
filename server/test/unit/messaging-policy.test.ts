import { describe, expect, it } from 'vitest';
import {
  hourInTimeZone,
  isQuietHour,
  inQuietHours,
  nextAllowedTime,
  type MessagingPolicy,
} from '../../src/modules/messaging/policy.js';

function policy(over: Partial<MessagingPolicy> = {}): MessagingPolicy {
  return {
    clinicId: 'c1',
    channel: 'whatsapp',
    quietHoursEnabled: true,
    quietStartHour: 21,
    quietEndHour: 8,
    dailyCap: null,
    minGapMinutes: 0,
    timeZone: 'UTC',
    ...over,
  };
}

describe('quiet-hours math (deterministic, timezone-aware)', () => {
  it('reads the hour-of-day in a timezone', () => {
    expect(hourInTimeZone(new Date('2026-01-01T20:00:00Z'), 'UTC')).toBe(20);
    // Cairo is UTC+2 in January.
    expect(hourInTimeZone(new Date('2026-01-01T20:00:00Z'), 'Africa/Cairo')).toBe(22);
  });

  it('evaluates a window that wraps midnight (21:00–08:00)', () => {
    expect(isQuietHour(20, 21, 8)).toBe(false);
    expect(isQuietHour(21, 21, 8)).toBe(true);
    expect(isQuietHour(3, 21, 8)).toBe(true);
    expect(isQuietHour(8, 21, 8)).toBe(false); // end is exclusive
  });

  it('evaluates a same-day window (12:00–14:00)', () => {
    expect(isQuietHour(13, 12, 14)).toBe(true);
    expect(isQuietHour(14, 12, 14)).toBe(false);
    expect(isQuietHour(11, 12, 14)).toBe(false);
  });

  it('inQuietHours is false when disabled', () => {
    expect(inQuietHours(policy({ quietHoursEnabled: false }), new Date('2026-01-01T23:00:00Z'))).toBe(false);
    expect(inQuietHours(policy(), new Date('2026-01-01T23:00:00Z'))).toBe(true);
  });

  it('nextAllowedTime advances past the quiet window, preserving minutes', () => {
    const from = new Date('2026-01-01T22:30:00Z'); // inside 21–08 quiet
    const allowed = nextAllowedTime(policy(), from);
    expect(hourInTimeZone(allowed, 'UTC')).toBe(8);
    expect(allowed.getUTCMinutes()).toBe(30); // minute preserved
    expect(inQuietHours(policy(), allowed)).toBe(false);
  });

  it('nextAllowedTime is a no-op outside quiet hours', () => {
    const from = new Date('2026-01-01T10:00:00Z');
    expect(nextAllowedTime(policy(), from).getTime()).toBe(from.getTime());
  });
});
