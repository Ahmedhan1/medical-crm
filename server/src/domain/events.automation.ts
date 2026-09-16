/**
 * AI / AUTOMATION / WHATSAPP event types — owned by Agent 3.
 *
 * These are domain facts emitted into the shared append-only event store. They
 * are deliberately loop-safe: the automation engine READS the event store but
 * never emits into it, so emitting these here (from HTTP-initiated actions)
 * cannot create a processing cycle.
 *
 * Do not edit other workstreams' event files.
 */
export const AutomationEventType = {
  /** A review-first AI draft was created (pending human review). */
  AI_DRAFT_CREATED: 'AI_DRAFT_CREATED',
  /** A human confirmed an AI draft. Does NOT itself write clinical data. */
  AI_DRAFT_CONFIRMED: 'AI_DRAFT_CONFIRMED',
  /** A human rejected an AI draft. */
  AI_DRAFT_REJECTED: 'AI_DRAFT_REJECTED',
} as const;
