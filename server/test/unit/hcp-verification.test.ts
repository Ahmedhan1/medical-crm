import { describe, expect, it } from 'vitest';
import {
  allowedTransitionsFrom,
  assertTransition,
  canTransition,
  DEFAULT_VERIFICATION_VALIDITY_DAYS,
  isMaterialChange,
  MATERIAL_ATTRIBUTES,
  stateAfterMaterialChange,
  verificationExpiryFrom,
  VerificationState,
} from '../../src/modules/hcp/verification.js';

describe('verification lifecycle — the graph', () => {
  it('never allows a jump straight to verified', () => {
    // The single most important property: only review confers verification.
    for (const from of Object.values(VerificationState)) {
      if (from === VerificationState.PENDING_REVIEW) continue;
      expect(
        canTransition(from, VerificationState.VERIFIED),
        `${from} must not reach verified directly`,
      ).toBe(false);
    }
    expect(canTransition(VerificationState.PENDING_REVIEW, VerificationState.VERIFIED)).toBe(true);
  });

  it('lets a verified record lapse, be suspended, be disputed or be re-reviewed', () => {
    const from = VerificationState.VERIFIED;
    for (const to of [
      VerificationState.EXPIRED,
      VerificationState.SUSPENDED,
      VerificationState.DISPUTED,
      VerificationState.PENDING_REVIEW,
    ]) {
      expect(canTransition(from, to), `verified -> ${to}`).toBe(true);
    }
  });

  it('routes every recovery path back through review', () => {
    for (const from of [
      VerificationState.REJECTED,
      VerificationState.SUSPENDED,
      VerificationState.EXPIRED,
      VerificationState.DISPUTED,
    ]) {
      expect(allowedTransitionsFrom(from)).toContain(VerificationState.PENDING_REVIEW);
    }
  });

  it('refuses a transition to the same state', () => {
    expect(() =>
      assertTransition(VerificationState.VERIFIED, VerificationState.VERIFIED, null),
    ).toThrow(/already "verified"/);
  });

  it('refuses an illegal edge and says what is allowed', () => {
    expect(() =>
      assertTransition(VerificationState.UNVERIFIED, VerificationState.VERIFIED, null),
    ).toThrow(/Cannot move verification/);
  });

  it('requires a reason for rejection and suspension, but not for other moves', () => {
    expect(() =>
      assertTransition(VerificationState.PENDING_REVIEW, VerificationState.REJECTED, null),
    ).toThrow(/requires a reason/);
    expect(() =>
      assertTransition(VerificationState.PENDING_REVIEW, VerificationState.SUSPENDED, null),
    ).toThrow(/requires a reason/);

    expect(() =>
      assertTransition(VerificationState.PENDING_REVIEW, VerificationState.REJECTED, 'no licence'),
    ).not.toThrow();
    expect(() =>
      assertTransition(VerificationState.PENDING_REVIEW, VerificationState.VERIFIED, null),
    ).not.toThrow();
  });
});

describe('verification lifecycle — material change', () => {
  it('treats professional identity as material', () => {
    for (const attribute of ['fullName', 'professionalCategory', 'primarySpecialtyId', 'jurisdiction']) {
      expect(MATERIAL_ATTRIBUTES.has(attribute), attribute).toBe(true);
    }
    expect(isMaterialChange(['notes', 'fullName'])).toBe(true);
  });

  it('does NOT treat annotations or provenance re-citation as material', () => {
    // Improving provenance for unchanged facts must not cost a record its
    // review, or stewards are punished for doing the right thing.
    expect(isMaterialChange(['notes'])).toBe(false);
    expect(isMaterialChange(['preferredLanguage'])).toBe(false);
    expect(isMaterialChange(['source', 'sourceVersion', 'sourceRef', 'confidence'])).toBe(false);
    expect(isMaterialChange([])).toBe(false);
  });

  it('downgrades only states that carry a completed judgement', () => {
    expect(stateAfterMaterialChange(VerificationState.VERIFIED)).toBe(
      VerificationState.PENDING_REVIEW,
    );
    expect(stateAfterMaterialChange(VerificationState.SUSPENDED)).toBe(
      VerificationState.PENDING_REVIEW,
    );
    expect(stateAfterMaterialChange(VerificationState.EXPIRED)).toBe(
      VerificationState.PENDING_REVIEW,
    );
    // An edit is not an appeal: a rejected record stays rejected.
    expect(stateAfterMaterialChange(VerificationState.REJECTED)).toBeNull();
    expect(stateAfterMaterialChange(VerificationState.UNVERIFIED)).toBeNull();
    expect(stateAfterMaterialChange(VerificationState.PENDING_REVIEW)).toBeNull();
  });
});

describe('verification lifecycle — expiry', () => {
  it('defaults to a one-year shelf life', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expiry = new Date(verificationExpiryFrom(undefined, now));
    const days = Math.round((expiry.getTime() - now.getTime()) / 86_400_000);
    expect(days).toBe(DEFAULT_VERIFICATION_VALIDITY_DAYS);
  });

  it('honours an explicit shorter validity', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expiry = new Date(verificationExpiryFrom(30, now));
    expect(Math.round((expiry.getTime() - now.getTime()) / 86_400_000)).toBe(30);
  });
});
