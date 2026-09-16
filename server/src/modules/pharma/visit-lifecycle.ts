import { ConflictError, ValidationError } from '../../domain/errors.js';

/**
 * PHASE 9 — the field-visit lifecycle.
 *
 * A visit is the unit of field work, and its status is the unit of field
 * reporting. Before this module the status was whatever the last UPDATE said,
 * which made two things possible that must not be: an arbitrary jump between
 * states, and a completed call quietly becoming something else.
 *
 * The whole rule set lives here as pure functions so every edge is testable
 * without a database and no caller can invent a path between states.
 *
 *   planned ──► confirmed ──► completed  (terminal)
 *      │            │
 *      ├────────────┴──► cancelled  (terminal, reason required)
 *      └────────────┬──► no_access  (terminal, reason required)
 *      └──────────► completed
 *
 * Two rules matter more than the graph:
 *
 *  1. **`completed` is terminal.** A completed visit carries a call report and
 *     has already fed aggregation; reverting it would rewrite history. If a
 *     completed call was reported in error the report is corrected, not erased.
 *  2. **A negative outcome must say why.** `cancelled` and `no_access` are the
 *     two states that explain away field work, so neither may be recorded
 *     without a reason. An unexplained no-access is not reviewable.
 */
export const VisitStatus = {
  PLANNED: 'planned',
  CONFIRMED: 'confirmed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  NO_ACCESS: 'no_access',
} as const;
export type VisitStatus = (typeof VisitStatus)[keyof typeof VisitStatus];

/**
 * Allowed transitions. Absence of an edge is a deliberate refusal:
 * `completed`, `cancelled` and `no_access` have no outgoing edge at all, so a
 * closed visit is closed. Re-planning is done by planning a NEW visit, which
 * leaves both the abandoned attempt and the retry visible.
 */
const ALLOWED: Record<VisitStatus, readonly VisitStatus[]> = {
  [VisitStatus.PLANNED]: [
    VisitStatus.CONFIRMED,
    // A rep may complete an unconfirmed call — confirmation is the HCP's
    // office agreeing to the slot, which often never happens explicitly.
    VisitStatus.COMPLETED,
    VisitStatus.CANCELLED,
    VisitStatus.NO_ACCESS,
  ],
  [VisitStatus.CONFIRMED]: [
    VisitStatus.COMPLETED,
    VisitStatus.CANCELLED,
    VisitStatus.NO_ACCESS,
  ],
  [VisitStatus.COMPLETED]: [],
  [VisitStatus.CANCELLED]: [],
  [VisitStatus.NO_ACCESS]: [],
};

/** Outcomes that must carry a recorded reason. */
const REQUIRES_REASON: ReadonlySet<VisitStatus> = new Set([
  VisitStatus.CANCELLED,
  VisitStatus.NO_ACCESS,
]);

export function canTransition(from: VisitStatus, to: VisitStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function allowedTransitionsFrom(from: VisitStatus): readonly VisitStatus[] {
  return ALLOWED[from] ?? [];
}

export function isTerminal(status: VisitStatus): boolean {
  return allowedTransitionsFrom(status).length === 0;
}

export function requiresReason(to: VisitStatus): boolean {
  return REQUIRES_REASON.has(to);
}

/**
 * Assert a transition is legal and adequately evidenced.
 *
 * `ConflictError` for an illegal edge (the visit is not in a state from which
 * this is possible) and `ValidationError` for a legal edge missing its
 * evidence — two different problems deserving two different answers.
 */
export function assertVisitTransition(
  from: VisitStatus,
  to: VisitStatus,
  reason: string | null,
): void {
  if (from === to) {
    throw new ConflictError(`This visit is already "${to}"`, { from, to });
  }
  if (isTerminal(from)) {
    throw new ConflictError(
      `A "${from}" visit is closed and cannot change status; plan a new visit instead.`,
      { from, to },
    );
  }
  if (!canTransition(from, to)) {
    throw new ConflictError(`Cannot move a visit from "${from}" to "${to}".`, {
      from,
      to,
      allowed: allowedTransitionsFrom(from),
    });
  }
  if (REQUIRES_REASON.has(to) && !reason) {
    throw new ValidationError(
      `Recording a visit as "${to}" requires a reason; an unexplained outcome is not reviewable.`,
      { field: 'reason' },
    );
  }
}

/**
 * Visit modality — HOW the interaction happened, which is independent of WHY
 * (`visit_type`) and of its outcome (`status`). A virtual detail and a
 * face-to-face detail are the same purpose through different channels, and
 * compliance reporting has to tell them apart.
 */
export const VisitModality = {
  FACE_TO_FACE: 'face_to_face',
  VIRTUAL: 'virtual',
  PHONE: 'phone',
  CONFERENCE: 'conference',
  SCIENTIFIC_MEETING: 'scientific_meeting',
  INSTITUTIONAL: 'institutional',
} as const;
export type VisitModality = (typeof VisitModality)[keyof typeof VisitModality];

export const VISIT_MODALITIES = Object.values(VisitModality) as readonly VisitModality[];
