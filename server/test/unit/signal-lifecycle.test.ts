import { describe, expect, it } from 'vitest';
import {
  allowedTransitionsFrom,
  assertNotSelfApproval,
  assertTransition,
  canTransition,
  DEFAULT_SIGNAL_VALIDITY_DAYS,
  effectiveStatus,
  isApprovalDecision,
  isConsumerReadable,
  isSelfApproval,
  SIGNAL_LIFECYCLE_STATES,
  SignalDecision,
  SignalLifecycle,
  signalExpiryFrom,
  targetStateFor,
} from '../../src/modules/intelligence/signal-lifecycle.js';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';

/**
 * The signal lifecycle is a pure rule set. What it REFUSES is the point: the
 * firewall says a number is safe, disclosure control says what it may say, and
 * this says whether anyone has agreed the claim is true.
 */

describe('signal lifecycle — nothing publishes itself', () => {
  it('a draft has exactly one way forward: review', () => {
    expect([...allowedTransitionsFrom(SignalLifecycle.DRAFT)]).toEqual([
      SignalLifecycle.IN_REVIEW,
    ]);
  });

  it('NO state reaches published without passing through approved', () => {
    for (const from of SIGNAL_LIFECYCLE_STATES) {
      if (from === SignalLifecycle.APPROVED) continue;
      expect(
        canTransition(from, SignalLifecycle.PUBLISHED),
        `${from} must not publish directly`,
      ).toBe(false);
    }
    expect(canTransition(SignalLifecycle.APPROVED, SignalLifecycle.PUBLISHED)).toBe(true);
  });

  it('a rejected or withdrawn claim re-enters at review, never at approved', () => {
    for (const from of [SignalLifecycle.REJECTED, SignalLifecycle.WITHDRAWN]) {
      expect([...allowedTransitionsFrom(from)]).toEqual([SignalLifecycle.IN_REVIEW]);
    }
  });

  it('an expired claim is not automatically true again', () => {
    expect([...allowedTransitionsFrom(SignalLifecycle.EXPIRED)]).toEqual([
      SignalLifecycle.IN_REVIEW,
    ]);
  });

  it('an approved claim can be withdrawn without first being shown to anyone', () => {
    expect(canTransition(SignalLifecycle.APPROVED, SignalLifecycle.WITHDRAWN)).toBe(true);
  });

  it('refuses re-asserting the current state', () => {
    for (const state of SIGNAL_LIFECYCLE_STATES) {
      expect(() => assertTransition(state, state, 'x')).toThrow(ConflictError);
    }
  });

  it('a refusal or a retraction must say why', () => {
    expect(() =>
      assertTransition(SignalLifecycle.IN_REVIEW, SignalLifecycle.REJECTED, null),
    ).toThrow(ValidationError);
    expect(() =>
      assertTransition(SignalLifecycle.PUBLISHED, SignalLifecycle.WITHDRAWN, null),
    ).toThrow(ValidationError);
    expect(() =>
      assertTransition(SignalLifecycle.IN_REVIEW, SignalLifecycle.REJECTED, 'wrong denominator'),
    ).not.toThrow();
  });
});

describe('signal lifecycle — separation of duties', () => {
  it('the producer of a signal is not its approver', () => {
    expect(isSelfApproval('user-1', 'user-1')).toBe(true);
    expect(() => assertNotSelfApproval('user-1', 'user-1')).toThrow(ConflictError);
    expect(() => assertNotSelfApproval('user-1', 'user-2')).not.toThrow();
  });

  it('a signal with no recorded producer is not treated as self-approved', () => {
    expect(isSelfApproval(null, 'user-1')).toBe(false);
  });

  it('only APPROVE is an act of approval; publishing an approved claim is not', () => {
    expect(isApprovalDecision(SignalDecision.APPROVE)).toBe(true);
    expect(isApprovalDecision(SignalDecision.PUBLISH)).toBe(false);
  });

  it('every decision maps to exactly one target state', () => {
    for (const decision of Object.values(SignalDecision)) {
      expect(SIGNAL_LIFECYCLE_STATES).toContain(targetStateFor(decision));
    }
  });
});

describe('signal lifecycle — expiry is derived', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();

  it('a published claim past its window reads as expired', () => {
    expect(effectiveStatus(SignalLifecycle.PUBLISHED, past)).toBe(SignalLifecycle.EXPIRED);
  });

  it('a published claim inside its window is unchanged', () => {
    expect(effectiveStatus(SignalLifecycle.PUBLISHED, future)).toBe(SignalLifecycle.PUBLISHED);
  });

  it('no expiry recorded is not an expiry', () => {
    expect(effectiveStatus(SignalLifecycle.PUBLISHED, null)).toBe(SignalLifecycle.PUBLISHED);
  });

  it('expiry belongs to a LIVE claim: a stale draft is still a draft', () => {
    for (const state of SIGNAL_LIFECYCLE_STATES) {
      if (state === SignalLifecycle.PUBLISHED) continue;
      expect(effectiveStatus(state, past)).toBe(state);
    }
  });

  it('computes the shelf life from the default quarter when none is chosen', () => {
    const now = new Date('2026-09-16T00:00:00.000Z');
    const expected = new Date(now);
    expected.setDate(expected.getDate() + DEFAULT_SIGNAL_VALIDITY_DAYS);
    expect(signalExpiryFrom(undefined, now)).toBe(expected.toISOString());
  });
});

describe('signal lifecycle — what a consumer may read', () => {
  it('exactly one state is consumer-readable', () => {
    const readable = SIGNAL_LIFECYCLE_STATES.filter(isConsumerReadable);
    expect(readable).toEqual([SignalLifecycle.PUBLISHED]);
  });

  it('a lapsed claim is not readable, because readability is asked of the EFFECTIVE status', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(isConsumerReadable(effectiveStatus(SignalLifecycle.PUBLISHED, past))).toBe(false);
  });
});
