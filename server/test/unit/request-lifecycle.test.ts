import { describe, expect, it } from 'vitest';
import {
  allowedTransitionsFrom,
  assertAnswerable,
  assertEscalatable,
  assertRequestTransition,
  canTransition,
  isBreached,
  isTerminal,
  RequestStatus,
  SLA_HOURS,
  slaDueAt,
} from '../../src/modules/pharma/request-lifecycle.js';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';

const ALL = Object.values(RequestStatus);
const HOUR = 60 * 60 * 1000;

describe('scientific request — the transition graph', () => {
  it('closed is terminal: a finished medical interaction is not reopened', () => {
    expect(isTerminal(RequestStatus.CLOSED)).toBe(true);
    for (const to of ALL) expect(canTransition(RequestStatus.CLOSED, to)).toBe(false);
  });

  it('a rejection can be closed out but never becomes an answer', () => {
    expect(canTransition(RequestStatus.REJECTED, RequestStatus.CLOSED)).toBe(true);
    expect(canTransition(RequestStatus.REJECTED, RequestStatus.ANSWERED)).toBe(false);
    expect(canTransition(RequestStatus.REJECTED, RequestStatus.OPEN)).toBe(false);
  });

  it('an answered request can only be closed', () => {
    expect([...allowedTransitionsFrom(RequestStatus.ANSWERED)]).toEqual([RequestStatus.CLOSED]);
  });

  it('handing a request back to the queue is the only backwards edge', () => {
    expect(canTransition(RequestStatus.IN_REVIEW, RequestStatus.OPEN)).toBe(true);
    expect(canTransition(RequestStatus.ANSWERED, RequestStatus.IN_REVIEW)).toBe(false);
    expect(canTransition(RequestStatus.CLOSED, RequestStatus.OPEN)).toBe(false);
  });

  it('refuses re-asserting the current status', () => {
    for (const status of ALL) {
      expect(() => assertRequestTransition(status, status, 'x')).toThrow(ConflictError);
    }
  });

  it('a rejection without a reason is a validation problem', () => {
    expect(() =>
      assertRequestTransition(RequestStatus.OPEN, RequestStatus.REJECTED, null),
    ).toThrow(ValidationError);
    expect(() =>
      assertRequestTransition(RequestStatus.OPEN, RequestStatus.REJECTED, 'Off-label enquiry'),
    ).not.toThrow();
  });
});

describe('scientific request — separation of duties', () => {
  it('the person who asked can never be the person who answers', () => {
    expect(() => assertAnswerable(RequestStatus.OPEN, 'user-1', 'user-1')).toThrow(ConflictError);
  });

  it('anyone else with the permission may answer', () => {
    expect(() => assertAnswerable(RequestStatus.OPEN, 'user-1', 'user-2')).not.toThrow();
  });

  it('an already-answered request is not answered twice', () => {
    expect(() => assertAnswerable(RequestStatus.ANSWERED, 'user-1', 'user-2')).toThrow(
      ConflictError,
    );
    expect(() => assertAnswerable(RequestStatus.CLOSED, 'user-1', 'user-2')).toThrow(ConflictError);
  });
});

describe('scientific request — service level', () => {
  it('a more urgent question gets a shorter commitment', () => {
    expect(SLA_HOURS.critical).toBeLessThan(SLA_HOURS.high);
    expect(SLA_HOURS.high).toBeLessThan(SLA_HOURS.routine);
  });

  it('computes the deadline from when the question was asked', () => {
    const asked = new Date('2026-09-16T08:00:00.000Z');
    expect(slaDueAt('critical', asked)).toBe(
      new Date(asked.getTime() + SLA_HOURS.critical * HOUR).toISOString(),
    );
  });

  it('a live request past its deadline is breached', () => {
    const past = new Date(Date.now() - HOUR).toISOString();
    expect(isBreached(RequestStatus.OPEN, past)).toBe(true);
    expect(isBreached(RequestStatus.IN_REVIEW, past)).toBe(true);
  });

  it('a finished request is never breached, however old', () => {
    const past = new Date(Date.now() - 1000 * HOUR).toISOString();
    for (const status of [RequestStatus.ANSWERED, RequestStatus.CLOSED, RequestStatus.REJECTED]) {
      expect(isBreached(status, past)).toBe(false);
    }
  });

  it('a request with no recorded deadline is not breached by default', () => {
    expect(isBreached(RequestStatus.OPEN, null)).toBe(false);
  });
});

describe('scientific request — escalation', () => {
  const past = () => new Date(Date.now() - HOUR).toISOString();
  const future = () => new Date(Date.now() + HOUR).toISOString();

  it('a live, breached request may be escalated', () => {
    expect(() => assertEscalatable(RequestStatus.OPEN, past())).not.toThrow();
  });

  it('an in-window request may not — escalating early empties the signal', () => {
    expect(() => assertEscalatable(RequestStatus.OPEN, future())).toThrow(ConflictError);
  });

  it('a finished request may not be escalated', () => {
    expect(() => assertEscalatable(RequestStatus.ANSWERED, past())).toThrow(ConflictError);
    expect(() => assertEscalatable(RequestStatus.CLOSED, past())).toThrow(ConflictError);
  });

  it('a request with no service level has nothing to have breached', () => {
    expect(() => assertEscalatable(RequestStatus.OPEN, null)).toThrow(ConflictError);
  });
});
