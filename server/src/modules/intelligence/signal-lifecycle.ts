import { ConflictError, ValidationError } from '../../domain/errors.js';

/**
 * THE AGGREGATE-SIGNAL LIFECYCLE (migration 0311).
 *
 * The firewall (`firewall.ts`) decides whether a number is *safe* to publish;
 * disclosure control (`disclosure.ts`) decides what that number is allowed to
 * *say*; query governance (`query-governance.ts`) decides how often it may be
 * *asked for*. None of them decides whether the claim is *true enough to
 * publish*. That is a human judgement, and this module is its rule set.
 *
 *     draft ──► in_review ──► approved ──► published ──► expired
 *                   │             │            │            │
 *                   └► rejected   └► withdrawn ┘            │
 *                          │            │                   │
 *                          └──────► in_review ◄─────────────┘
 *
 * Everything here is a pure function over in-memory values — no database, no
 * principal, no I/O — for the same reason as `firewall.ts` and
 * `hcp/verification.ts`: every transition can be exhaustively unit-tested, and
 * no caller can invent a path between states.
 *
 * Four rules matter more than the graph:
 *
 *  1. **A run produces a DRAFT.** Nothing is published by being computed. This
 *     is the behaviour change 0311 exists to make: previously the pipeline
 *     published its own output, so the arithmetic was reviewed but the claim
 *     never was.
 *  2. **Nothing reaches `published` except through review.** There is no edge
 *     from `draft`, `rejected`, `withdrawn` or `expired` straight to
 *     `published`; they all pass through `in_review` and `approved` first.
 *  3. **The generator is not the approver.** Enforced by
 *     `assertNotSelfApproval` here and by `signal_no_self_approval` in the
 *     schema, mirroring "Content cannot be approved by its own owner" in
 *     `pharma/content.service.ts`.
 *  4. **Expiry is derived, not swept.** `effectiveStatus` mirrors the SQL
 *     function `pharma_effective_signal_status` exactly, so a lapsed signal
 *     reads as `expired` whether the question is asked in Postgres or in
 *     TypeScript, and whether or not the sweep has ever run.
 */
export const SignalLifecycle = {
  /** Produced by a firewall run. Not readable by a consumer. */
  DRAFT: 'draft',
  /** Submitted by its producer; awaiting a reviewer's decision. */
  IN_REVIEW: 'in_review',
  /** A reviewer has accepted the claim. Still not readable by a consumer. */
  APPROVED: 'approved',
  /** The ONLY state a consumer may read. */
  PUBLISHED: 'published',
  /** A reviewer refused the claim. Requires a recorded note. */
  REJECTED: 'rejected',
  /** Retracted after publication (or after approval). Requires a reason. */
  WITHDRAWN: 'withdrawn',
  /** Past its shelf life. Derived on read; also persisted by the sweep. */
  EXPIRED: 'expired',
} as const;
export type SignalLifecycle = (typeof SignalLifecycle)[keyof typeof SignalLifecycle];

export const SIGNAL_LIFECYCLE_STATES: readonly SignalLifecycle[] =
  Object.values(SignalLifecycle);

/**
 * Allowed transitions. The absence of an edge is a deliberate refusal, not an
 * oversight — notably, no state reaches `published` without passing through
 * `in_review` and then `approved`.
 */
const ALLOWED: Record<SignalLifecycle, readonly SignalLifecycle[]> = {
  // A draft has exactly one way forward: review. It cannot be published, it
  // cannot be "approved" without first being put in front of a reviewer, and it
  // cannot be rejected either — a draft nobody submitted needs no refusal, and
  // it is unreadable by consumers wherever it sits.
  [SignalLifecycle.DRAFT]: [SignalLifecycle.IN_REVIEW],
  [SignalLifecycle.IN_REVIEW]: [SignalLifecycle.APPROVED, SignalLifecycle.REJECTED],
  // Approval is permission to publish, not publication itself: the two are
  // separate acts by separate permissions. `approved -> withdrawn` is an edge
  // the headline diagram does not draw, and it is here on purpose: without it,
  // an approved claim later found to be wrong could only be retracted by first
  // publishing it, which would mean showing consumers something already known
  // to be false.
  [SignalLifecycle.APPROVED]: [SignalLifecycle.PUBLISHED, SignalLifecycle.WITHDRAWN],
  // A live claim can be retracted or can lapse. It can never be re-approved in
  // place — a fresh review is required, which means going back through the top.
  [SignalLifecycle.PUBLISHED]: [SignalLifecycle.WITHDRAWN, SignalLifecycle.EXPIRED],
  // A refused or retracted claim may be revised and re-submitted. It re-enters
  // at `in_review`, never at `approved`.
  [SignalLifecycle.REJECTED]: [SignalLifecycle.IN_REVIEW],
  [SignalLifecycle.WITHDRAWN]: [SignalLifecycle.IN_REVIEW],
  // A lapsed claim is not automatically true again; re-publishing it is a new
  // review of a now-older number.
  [SignalLifecycle.EXPIRED]: [SignalLifecycle.IN_REVIEW],
};

/**
 * States that require a recorded reason, mirrored by the CHECK constraints
 * `signal_rejection_has_note` and `signal_withdrawal_has_reason` in 0311.
 */
const REQUIRES_REASON: ReadonlySet<SignalLifecycle> = new Set([
  SignalLifecycle.REJECTED,
  SignalLifecycle.WITHDRAWN,
]);

export function requiresReason(to: SignalLifecycle): boolean {
  return REQUIRES_REASON.has(to);
}

export function canTransition(from: SignalLifecycle, to: SignalLifecycle): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function allowedTransitionsFrom(from: SignalLifecycle): readonly SignalLifecycle[] {
  return ALLOWED[from] ?? [];
}

/**
 * Assert a transition is legal and adequately evidenced.
 *
 * `ConflictError` for an illegal edge (the signal is not in a state from which
 * this is possible) and `ValidationError` for a legal edge missing its evidence
 * — two different problems that deserve two different answers, exactly as in
 * `hcp/verification.ts`.
 */
export function assertTransition(
  from: SignalLifecycle,
  to: SignalLifecycle,
  reason: string | null,
): void {
  if (from === to) {
    throw new ConflictError(`This signal is already "${to}"`);
  }
  if (!canTransition(from, to)) {
    throw new ConflictError(`Cannot move a signal from "${from}" to "${to}".`, {
      from,
      to,
      allowed: allowedTransitionsFrom(from),
    });
  }
  if (REQUIRES_REASON.has(to) && !reason) {
    throw new ValidationError(
      `Moving a signal to "${to}" requires a reason; an unexplained refusal or ` +
        'retraction is not reviewable.',
      { field: 'reason' },
    );
  }
}

/**
 * SEPARATION OF DUTIES.
 *
 * The principal whose run produced a signal may not be the one who accepts it.
 * Self-approval defeats the whole point of the review step: it would make the
 * lifecycle a formality that the producer walks through alone.
 *
 * Mirrored by the `signal_no_self_approval` CHECK in 0311, so this cannot be
 * bypassed by writing to the table directly.
 */
export function isSelfApproval(generatedBy: string | null, approverId: string): boolean {
  return generatedBy !== null && generatedBy === approverId;
}

export function assertNotSelfApproval(generatedBy: string | null, approverId: string): void {
  if (isSelfApproval(generatedBy, approverId)) {
    throw new ConflictError(
      'A signal cannot be approved by the principal who generated it; approval is a ' +
        'separate accountability from production.',
      { control: 'self_approval' },
    );
  }
}

/**
 * The status a consumer actually sees.
 *
 * Mirrors `pharma_effective_signal_status` in 0311 term for term: only a
 * PUBLISHED signal with a PASSED expiry reads as expired. A missing `expiresAt`
 * is not an expiry, and a draft with a passed `expiresAt` is still a draft —
 * expiry is a property of a live claim, not of an unreviewed one.
 */
export function effectiveStatus(
  status: SignalLifecycle,
  expiresAt: string | Date | null,
  now: Date = new Date(),
): SignalLifecycle {
  if (status !== SignalLifecycle.PUBLISHED || expiresAt === null) return status;
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return expiry.getTime() < now.getTime() ? SignalLifecycle.EXPIRED : status;
}

/**
 * The ONLY state a principal holding just `intelligence:signal-read` may see.
 *
 * Stated as a function of the EFFECTIVE status, so it is impossible to answer
 * "readable?" without having applied expiry first.
 */
export function isConsumerReadable(effective: SignalLifecycle): boolean {
  return effective === SignalLifecycle.PUBLISHED;
}

/**
 * Default shelf life of a published signal, in days, when the publisher names
 * none.
 *
 * A field-derived aggregate over a period is a statement about that period, and
 * it decays: 90 days is one commercial quarter, after which the claim should be
 * re-derived rather than re-asserted. A publisher may set a shorter window; the
 * lifecycle does not permit an unbounded one to be *implied*, only chosen.
 */
export const DEFAULT_SIGNAL_VALIDITY_DAYS = 90;

export function signalExpiryFrom(
  validForDays: number = DEFAULT_SIGNAL_VALIDITY_DAYS,
  now: Date = new Date(),
): string {
  const expiry = new Date(now);
  expiry.setDate(expiry.getDate() + validForDays);
  return expiry.toISOString();
}

/**
 * The decisions a principal can ask for, and the transition each one means.
 *
 * Naming the decision rather than the target state keeps the API intent-shaped
 * ("withdraw this"), while the map keeps the state machine the single authority
 * on what that intent is allowed to do.
 */
export const SignalDecision = {
  SUBMIT_REVIEW: 'submit_review',
  APPROVE: 'approve',
  REJECT: 'reject',
  PUBLISH: 'publish',
  WITHDRAW: 'withdraw',
} as const;
export type SignalDecision = (typeof SignalDecision)[keyof typeof SignalDecision];

const DECISION_TARGET: Record<SignalDecision, SignalLifecycle> = {
  [SignalDecision.SUBMIT_REVIEW]: SignalLifecycle.IN_REVIEW,
  [SignalDecision.APPROVE]: SignalLifecycle.APPROVED,
  [SignalDecision.REJECT]: SignalLifecycle.REJECTED,
  [SignalDecision.PUBLISH]: SignalLifecycle.PUBLISHED,
  [SignalDecision.WITHDRAW]: SignalLifecycle.WITHDRAWN,
};

export function targetStateFor(decision: SignalDecision): SignalLifecycle {
  return DECISION_TARGET[decision];
}

/**
 * Decisions that are an ACT OF APPROVAL rather than of production.
 *
 * `approve` is the accountability the self-approval rule protects. `publish` is
 * deliberately NOT on this list: publishing an already-approved claim is an
 * operational act, and the claim it puts live was accepted by someone other than
 * its producer — which the `approve` step has already guaranteed.
 */
export function isApprovalDecision(decision: SignalDecision): boolean {
  return decision === SignalDecision.APPROVE;
}
