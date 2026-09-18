import { ConflictError, ValidationError } from '../../domain/errors.js';

/**
 * PHASE 6 — the HCP verification lifecycle.
 *
 * Verification is a claim with a shelf life, not a permanent label. This module
 * is the whole of the rule set, as pure functions, so every transition is
 * testable without a database and no caller can invent a path between states.
 *
 *   unverified ──► pending_review ──► verified ──► expired ──► pending_review
 *        │               │    │           │
 *        └──► rejected ◄─┘    │           ├──► suspended ──► pending_review
 *                             │           └──► disputed  ──► pending_review
 *                             └──► suspended
 *
 * Two rules matter more than the graph:
 *
 *  1. **Verification never survives a material change.** Editing a verified
 *     record's professional identity returns it to `pending_review`. Anything
 *     else would let an unreviewed value inherit a reviewed record's authority.
 *  2. **Nothing reaches `verified` except through review.** There is no edge
 *     from `unverified`, `rejected`, `suspended` or `expired` straight to
 *     `verified` — they all pass through `pending_review` first.
 */
export const VerificationState = {
  UNVERIFIED: 'unverified',
  PENDING_REVIEW: 'pending_review',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended',
  EXPIRED: 'expired',
  DISPUTED: 'disputed',
  RETIRED: 'retired',
} as const;
export type VerificationState = (typeof VerificationState)[keyof typeof VerificationState];

/**
 * Allowed transitions. Absence of an edge is a deliberate refusal, not an
 * oversight — notably, no state reaches `verified` without `pending_review`.
 */
const ALLOWED: Record<VerificationState, readonly VerificationState[]> = {
  [VerificationState.UNVERIFIED]: [
    VerificationState.PENDING_REVIEW,
    VerificationState.REJECTED,
    VerificationState.RETIRED,
  ],
  [VerificationState.PENDING_REVIEW]: [
    VerificationState.VERIFIED,
    VerificationState.REJECTED,
    VerificationState.SUSPENDED,
    VerificationState.DISPUTED,
    VerificationState.RETIRED,
  ],
  [VerificationState.VERIFIED]: [
    // A verified record can lapse, be challenged, be suspended, or be sent back
    // for review — but it can never be re-verified without a fresh review.
    VerificationState.PENDING_REVIEW,
    VerificationState.SUSPENDED,
    VerificationState.DISPUTED,
    VerificationState.EXPIRED,
    VerificationState.RETIRED,
  ],
  [VerificationState.REJECTED]: [VerificationState.PENDING_REVIEW, VerificationState.RETIRED],
  [VerificationState.SUSPENDED]: [
    VerificationState.PENDING_REVIEW,
    VerificationState.REJECTED,
    VerificationState.RETIRED,
  ],
  [VerificationState.EXPIRED]: [VerificationState.PENDING_REVIEW, VerificationState.RETIRED],
  [VerificationState.DISPUTED]: [
    VerificationState.PENDING_REVIEW,
    VerificationState.REJECTED,
    VerificationState.RETIRED,
  ],
  [VerificationState.RETIRED]: [VerificationState.PENDING_REVIEW],
};

/** States that require a recorded reason, mirrored by a CHECK in 0306. */
const REQUIRES_REASON: ReadonlySet<VerificationState> = new Set([
  VerificationState.REJECTED,
  VerificationState.SUSPENDED,
]);

export function canTransition(from: VerificationState, to: VerificationState): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function allowedTransitionsFrom(from: VerificationState): readonly VerificationState[] {
  return ALLOWED[from] ?? [];
}

/**
 * Assert a transition is legal and adequately evidenced.
 *
 * Throws `ConflictError` for an illegal edge (the record is not in a state from
 * which this is possible) and `ValidationError` for a legal edge missing its
 * evidence — two different problems that deserve two different answers.
 */
export function assertTransition(
  from: VerificationState,
  to: VerificationState,
  note: string | null,
): void {
  if (from === to) {
    throw new ConflictError(`This record is already "${to}"`);
  }
  if (!canTransition(from, to)) {
    throw new ConflictError(
      `Cannot move verification from "${from}" to "${to}".`,
      { from, to, allowed: allowedTransitionsFrom(from) },
    );
  }
  if (REQUIRES_REASON.has(to) && !note) {
    throw new ValidationError(
      `Moving verification to "${to}" requires a reason; an unexplained refusal is not reviewable.`,
      { field: 'note' },
    );
  }
}

/**
 * Attributes whose change invalidates a completed verification.
 *
 * These are the facts a reviewer actually attested to: who this professional is,
 * what they practise, how they are reached professionally, and under which
 * jurisdiction. Editing one of them means the previous review no longer covers
 * the record.
 *
 * Deliberately EXCLUDED: `notes` and `preferredLanguage` (annotations, not
 * claims), and the provenance/confidence fields themselves — re-citing a source
 * for unchanged facts is not a material change, and treating it as one would
 * punish stewards for improving provenance.
 */
export const MATERIAL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'fullName',
  'givenName',
  'familyName',
  'title',
  'professionalCategory',
  'primarySpecialtyId',
  'professionalEmail',
  'professionalPhone',
  'jurisdiction',
  'status',
  'effectiveFrom',
  'effectiveTo',
]);

export function isMaterialChange(changedAttributes: readonly string[]): boolean {
  return changedAttributes.some((attribute) => MATERIAL_ATTRIBUTES.has(attribute));
}

/**
 * The state a record should return to when a material change lands on it.
 *
 * Only states that carry a completed judgement are downgraded. A record that is
 * `unverified` or already `pending_review` simply stays where it is, and a
 * `rejected` one stays rejected — an edit is not an appeal.
 */
export function stateAfterMaterialChange(
  current: VerificationState,
): VerificationState | null {
  switch (current) {
    case VerificationState.VERIFIED:
    case VerificationState.SUSPENDED:
    case VerificationState.EXPIRED:
    case VerificationState.DISPUTED:
      return VerificationState.PENDING_REVIEW;
    default:
      return null;
  }
}

/** Default shelf life of a verification, in days, when the caller names none. */
export const DEFAULT_VERIFICATION_VALIDITY_DAYS = 365;

export function verificationExpiryFrom(
  validForDays: number = DEFAULT_VERIFICATION_VALIDITY_DAYS,
  now: Date = new Date(),
): string {
  const expiry = new Date(now);
  expiry.setDate(expiry.getDate() + validForDays);
  return expiry.toISOString();
}
