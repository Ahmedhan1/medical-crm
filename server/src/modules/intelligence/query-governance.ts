/**
 * PHASE 29 — QUERY GOVERNANCE.
 *
 * Disclosure control (`disclosure.ts`) blurs a single answer. This module
 * governs the *sequence* of questions, which is the other half of the problem:
 * an analyst who is allowed to ask many individually-legal questions can
 * subtract the answers from one another until an individual falls out.
 *
 * Two controls, both pure decision functions over the principal's recent query
 * history so they can be tested without a database:
 *
 *  1. **Budget.** A bounded number of runs per principal per rolling window.
 *     Differencing needs many queries; a bound makes it expensive and visible.
 *  2. **Narrowing detection.** A request whose slice is strictly contained in
 *     slices this principal already asked for is a narrowing step. A shallow
 *     depth is legitimate ("the region, then my territory"); a chain of them is
 *     how you walk down to one subject, so beyond `maxNarrowingDepth` it is
 *     refused.
 *
 * Both refusals are recorded. A principal probing the boundary leaves a trail.
 */

/** The shape of an intelligence request, independent of its result. */
export interface QuerySlice {
  signalType: string;
  jurisdiction: string;
  /** Sorted territory ids; an EMPTY array means unrestricted (the widest slice). */
  scopeKeys: string[];
  periodStart: string;
  periodEnd: string;
}

export interface QueryGovernancePolicy {
  maxQueriesPerWindow: number;
  queryWindowHours: number;
  maxNarrowingDepth: number;
}

export type QueryDecision =
  | { allowed: true; narrowingDepth: number }
  | {
      allowed: false;
      outcome: 'denied_budget' | 'denied_narrowing';
      narrowingDepth: number;
      reason: string;
    };

/** True when `inner` covers no more than `outer` (⊆ on both dimensions). */
function isContainedIn(inner: QuerySlice, outer: QuerySlice): boolean {
  if (inner.signalType !== outer.signalType) return false;
  if (inner.jurisdiction !== outer.jurisdiction) return false;
  // An empty scope set is "everything", so it contains any explicit set and is
  // contained only by another empty set.
  const scopeContained =
    outer.scopeKeys.length === 0 ||
    (inner.scopeKeys.length > 0 && inner.scopeKeys.every((k) => outer.scopeKeys.includes(k)));
  if (!scopeContained) return false;
  return inner.periodStart >= outer.periodStart && inner.periodEnd <= outer.periodEnd;
}

/** True when `inner` is contained in `outer` AND genuinely smaller. */
export function isStrictlyNarrowerThan(inner: QuerySlice, outer: QuerySlice): boolean {
  if (!isContainedIn(inner, outer)) return false;
  const narrowerScope =
    outer.scopeKeys.length === 0
      ? inner.scopeKeys.length > 0
      : inner.scopeKeys.length < outer.scopeKeys.length;
  const narrowerPeriod =
    inner.periodStart > outer.periodStart || inner.periodEnd < outer.periodEnd;
  return narrowerScope || narrowerPeriod;
}

/**
 * How many already-seen slices strictly contain this one.
 *
 * This is the depth of the narrowing chain the principal is walking down. Only
 * previously ALLOWED queries count: a refusal must not deepen the chain, or a
 * principal could be locked out by their own rejected attempts.
 */
export function narrowingDepth(slice: QuerySlice, history: QuerySlice[]): number {
  return history.filter((prior) => isStrictlyNarrowerThan(slice, prior)).length;
}

/**
 * Decide whether an intelligence run may proceed.
 *
 * `history` is the principal's ALLOWED runs inside the window, for this signal
 * type. Budget is checked first: an exhausted budget is a cheaper, less
 * informative refusal than one that reveals the shape of the narrowing rule.
 */
export function decideQuery(
  slice: QuerySlice,
  history: QuerySlice[],
  policy: QueryGovernancePolicy,
): QueryDecision {
  const depth = narrowingDepth(slice, history);

  if (history.length >= policy.maxQueriesPerWindow) {
    return {
      allowed: false,
      outcome: 'denied_budget',
      narrowingDepth: depth,
      reason:
        `Intelligence query budget exhausted: ${policy.maxQueriesPerWindow} runs per ` +
        `${policy.queryWindowHours}h. The budget limits how finely aggregates can be ` +
        'differenced; it resets as the window rolls forward.',
    };
  }

  if (depth > policy.maxNarrowingDepth) {
    return {
      allowed: false,
      outcome: 'denied_narrowing',
      narrowingDepth: depth,
      reason:
        `This request narrows ${depth} earlier queries, beyond the permitted depth of ` +
        `${policy.maxNarrowingDepth}. Repeatedly narrowing an aggregate can isolate an ` +
        'individual, so the narrower slice is refused rather than answered.',
    };
  }

  return { allowed: true, narrowingDepth: depth };
}
