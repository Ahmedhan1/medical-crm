import { describe, expect, it } from 'vitest';
import {
  allowedTransitionsFrom,
  assertVisitTransition,
  canTransition,
  isTerminal,
  requiresReason,
  VISIT_MODALITIES,
  VisitModality,
  VisitStatus,
} from '../../src/modules/pharma/visit-lifecycle.js';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';

/**
 * The visit lifecycle is a pure rule set, so every edge is asserted here without
 * a database. What the graph REFUSES matters as much as what it allows.
 */

const ALL = Object.values(VisitStatus);

describe('visit lifecycle — the transition graph', () => {
  it('a planned call can be confirmed, completed, cancelled or refused access', () => {
    expect([...allowedTransitionsFrom(VisitStatus.PLANNED)].sort()).toEqual(
      ['cancelled', 'completed', 'confirmed', 'no_access'].sort(),
    );
  });

  it('a confirmed call can no longer go back to planned', () => {
    expect(canTransition(VisitStatus.CONFIRMED, VisitStatus.PLANNED)).toBe(false);
  });

  it('completed is terminal: a reported call cannot be rewritten', () => {
    expect(isTerminal(VisitStatus.COMPLETED)).toBe(true);
    for (const to of ALL) {
      expect(canTransition(VisitStatus.COMPLETED, to)).toBe(false);
    }
  });

  it('cancelled and no_access are terminal too — a retry is a NEW visit', () => {
    for (const from of [VisitStatus.CANCELLED, VisitStatus.NO_ACCESS]) {
      expect(isTerminal(from)).toBe(true);
      for (const to of ALL) expect(canTransition(from, to)).toBe(false);
    }
  });

  it('no state transitions to itself', () => {
    for (const status of ALL) expect(canTransition(status, status)).toBe(false);
  });
});

describe('visit lifecycle — assertion behaviour', () => {
  it('refuses re-asserting the current status', () => {
    expect(() =>
      assertVisitTransition(VisitStatus.PLANNED, VisitStatus.PLANNED, null),
    ).toThrow(ConflictError);
  });

  it('refuses any change to a closed visit, naming the state it is in', () => {
    try {
      assertVisitTransition(VisitStatus.COMPLETED, VisitStatus.CANCELLED, 'changed my mind');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as Error).message).toContain('completed');
    }
  });

  it('refuses an illegal edge and says what WAS allowed', () => {
    try {
      assertVisitTransition(VisitStatus.CONFIRMED, VisitStatus.PLANNED, null);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError & { details?: { allowed: string[] } }).details?.allowed)
        .not.toContain('planned');
    }
  });

  it('a negative outcome without a reason is a VALIDATION problem, not a conflict', () => {
    for (const to of [VisitStatus.CANCELLED, VisitStatus.NO_ACCESS]) {
      expect(() => assertVisitTransition(VisitStatus.PLANNED, to, null)).toThrow(ValidationError);
      expect(() => assertVisitTransition(VisitStatus.PLANNED, to, 'clinic closed')).not.toThrow();
    }
  });

  it('a positive outcome needs no reason', () => {
    expect(requiresReason(VisitStatus.COMPLETED)).toBe(false);
    expect(() =>
      assertVisitTransition(VisitStatus.PLANNED, VisitStatus.COMPLETED, null),
    ).not.toThrow();
  });
});

describe('visit modality', () => {
  it('modality is independent of status and of visit type', () => {
    expect(VISIT_MODALITIES).toContain(VisitModality.VIRTUAL);
    expect(VISIT_MODALITIES).toContain(VisitModality.INSTITUTIONAL);
    // No modality is also a status — the two vocabularies must not overlap, or
    // a caller could pass one where the other is meant.
    for (const modality of VISIT_MODALITIES) {
      expect(ALL).not.toContain(modality as unknown as (typeof ALL)[number]);
    }
  });
});
