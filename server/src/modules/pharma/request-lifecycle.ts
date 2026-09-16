import { ConflictError, ValidationError } from '../../domain/errors.js';

/**
 * PHASE 9 — the medical-information (scientific request) lifecycle.
 *
 * Medical affairs answers questions from the field. That work is governed:
 * every state a request passes through has to be legal, evidenced and
 * remembered. This module is the whole of the rule set, as pure functions.
 *
 *   open ⇄ in_review ──► answered ──► closed
 *     │        │
 *     └────────┴──► rejected ──► closed
 *
 * Rules that matter more than the graph:
 *
 *  1. **`closed` is terminal.** A closed request is a finished medical
 *     interaction; re-opening one would let an answer be replaced without the
 *     original ever having existed. A new question is a new request.
 *  2. **A refusal must say why.** `rejected` requires a reason, because
 *     declining to answer a clinician is a decision someone must be able to
 *     review.
 *  3. **An answer is not a state change alone.** `assertAnswerable` is what the
 *     service consults before writing an answer, so "who may answer" is decided
 *     in one place rather than at each call site.
 */
export const RequestStatus = {
  OPEN: 'open',
  IN_REVIEW: 'in_review',
  ANSWERED: 'answered',
  CLOSED: 'closed',
  REJECTED: 'rejected',
} as const;
export type RequestStatus = (typeof RequestStatus)[keyof typeof RequestStatus];

const ALLOWED: Record<RequestStatus, readonly RequestStatus[]> = {
  [RequestStatus.OPEN]: [
    RequestStatus.IN_REVIEW,
    RequestStatus.ANSWERED,
    RequestStatus.REJECTED,
    RequestStatus.CLOSED,
  ],
  [RequestStatus.IN_REVIEW]: [
    // Back to `open` when triage hands it back to the queue — a legitimate
    // un-assignment, and the only backwards edge in the graph.
    RequestStatus.OPEN,
    RequestStatus.ANSWERED,
    RequestStatus.REJECTED,
    RequestStatus.CLOSED,
  ],
  // An answered request is complete; the only thing left is to close it.
  [RequestStatus.ANSWERED]: [RequestStatus.CLOSED],
  // A rejection can be closed out, but it can never become an answer: the
  // refusal is the decision of record.
  [RequestStatus.REJECTED]: [RequestStatus.CLOSED],
  [RequestStatus.CLOSED]: [],
};

const REQUIRES_REASON: ReadonlySet<RequestStatus> = new Set([RequestStatus.REJECTED]);

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function allowedTransitionsFrom(from: RequestStatus): readonly RequestStatus[] {
  return ALLOWED[from] ?? [];
}

export function isTerminal(status: RequestStatus): boolean {
  return allowedTransitionsFrom(status).length === 0;
}

export function assertRequestTransition(
  from: RequestStatus,
  to: RequestStatus,
  reason: string | null,
): void {
  if (from === to) {
    throw new ConflictError(`This request is already "${to}"`, { from, to });
  }
  if (!canTransition(from, to)) {
    throw new ConflictError(
      `Cannot move a scientific request from "${from}" to "${to}".`,
      { from, to, allowed: allowedTransitionsFrom(from) },
    );
  }
  if (REQUIRES_REASON.has(to) && !reason) {
    throw new ValidationError(
      `Moving a scientific request to "${to}" requires a reason; an unexplained refusal is not reviewable.`,
      { field: 'reason' },
    );
  }
}

/**
 * Whether an answer may be written at all, by this actor.
 *
 * SEPARATION OF DUTIES: the person who raised the question is never the person
 * who answers it, even if they happen to hold `scientificrequest:fulfill`. A
 * field representative who could answer their own question would be making an
 * unreviewed medical claim on the company's behalf — the whole point of routing
 * it to medical affairs.
 */
export function assertAnswerable(
  from: RequestStatus,
  requestedBy: string,
  actorId: string,
): void {
  if (requestedBy === actorId) {
    throw new ConflictError(
      'The person who raised a scientific request cannot answer it; medical affairs must.',
      { requestId: undefined },
    );
  }
  if (from === RequestStatus.ANSWERED || from === RequestStatus.CLOSED) {
    throw new ConflictError(`This request is already ${from}`);
  }
}

/**
 * Service-level commitment, in hours, by priority.
 *
 * These are the DEFAULTS applied when nobody states an SLA explicitly. They are
 * deliberately short for `critical`: a question a clinician is waiting on at the
 * bedside of their own patient is not a routine enquiry. (No patient data ever
 * reaches this system — the urgency does.)
 */
export const SLA_HOURS: Record<'routine' | 'high' | 'critical', number> = {
  routine: 120, // five working-ish days
  high: 48,
  critical: 8,
};

export type RequestPriority = keyof typeof SLA_HOURS;

/** The instant an SLA expires, from when the request was raised. */
export function slaDueAt(priority: RequestPriority, from: Date = new Date()): string {
  const due = new Date(from.getTime() + SLA_HOURS[priority] * 60 * 60 * 1000);
  return due.toISOString();
}

/** Whether a request has passed its service level and is not yet resolved. */
export function isBreached(
  status: RequestStatus,
  slaDueAtIso: string | null,
  now: Date = new Date(),
): boolean {
  if (!slaDueAtIso) return false;
  if (status !== RequestStatus.OPEN && status !== RequestStatus.IN_REVIEW) return false;
  return new Date(slaDueAtIso).getTime() < now.getTime();
}

/**
 * Whether an escalation is permitted right now.
 *
 * Escalation is not a mood: a request may only be escalated while it is still
 * live AND its service level has actually been missed. Escalating an in-window
 * request would make the signal meaningless, and escalating a finished one
 * would be noise.
 */
export function assertEscalatable(
  status: RequestStatus,
  slaDueAtIso: string | null,
  now: Date = new Date(),
): void {
  if (status !== RequestStatus.OPEN && status !== RequestStatus.IN_REVIEW) {
    throw new ConflictError(
      `A "${status}" scientific request is no longer live and cannot be escalated.`,
      { status },
    );
  }
  if (!slaDueAtIso) {
    throw new ConflictError(
      'This request has no service level recorded, so there is nothing to have breached.',
    );
  }
  if (!isBreached(status, slaDueAtIso, now)) {
    throw new ConflictError(
      'This request is still inside its service level; escalate it once the SLA has been missed.',
      { slaDueAt: slaDueAtIso },
    );
  }
}
