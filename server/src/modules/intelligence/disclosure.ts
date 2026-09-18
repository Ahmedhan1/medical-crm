import type { AllowedSignal, SuppressedCohort } from './firewall.js';

/**
 * PHASE 28 — STATISTICAL DISCLOSURE CONTROL.
 *
 * The minimum-cohort threshold in `firewall.ts` decides *whether* a cohort may
 * be published. This module decides *what a published cohort is allowed to say*,
 * which is a separate problem: a set of individually-legal aggregates can still
 * disclose an individual when they are compared with each other.
 *
 * Three controls, all pure functions so they can be exhaustively tested:
 *
 *  1. **Complementary suppression.** If exactly one cohort in a run is
 *     suppressed, its value is recoverable from the published siblings whenever
 *     the total is known or guessable. A second cohort is therefore suppressed
 *     with it — the standard fix in official statistics.
 *  2. **Banding.** Exact cohort sizes are the raw material of a differencing
 *     attack: `10` here and `8` there recovers a hidden `2`. Published output
 *     carries a band ("5–9") instead. The exact count is still stored, because
 *     the operator's own audit trail must be truthful.
 *  3. **Rounding.** The measurement itself is rounded to a policy base, so
 *     narrowing a query by one day cannot reveal a single subject's
 *     contribution as a clean delta of one.
 *
 * None of this is a substitute for the threshold; it is the layer that stops the
 * threshold from being walked around.
 */

/** Cohort-size bands. Open-ended at the top so large cohorts stay useful. */
const BAND_UPPER_BOUNDS = [9, 19, 49, 99, 249, 499] as const;

/**
 * The published form of a cohort size.
 *
 * Bands never start below the threshold that admitted the cohort, so a band can
 * never hint that a cohort was close to being suppressed.
 */
export function cohortBand(cohortSize: number, minCohortSize: number): string {
  let lower = minCohortSize;
  for (const upper of BAND_UPPER_BOUNDS) {
    if (cohortSize <= upper) {
      // Never advertise a lower bound beneath the governing threshold.
      return `${Math.max(lower, minCohortSize)}-${upper}`;
    }
    lower = upper + 1;
  }
  return `${BAND_UPPER_BOUNDS[BAND_UPPER_BOUNDS.length - 1]! + 1}+`;
}

/**
 * Round a measurement to a multiple of `base`, away from zero at the midpoint.
 *
 * A rounded value is deliberately never rounded down to zero: publishing `0` for
 * a cohort that passed the threshold would itself be a disclosure (it would say
 * "this group exists but did nothing"), so the smallest rounded value is `base`.
 */
export function roundValue(value: number, base: number): number {
  if (base <= 1) return value;
  const rounded = Math.round(value / base) * base;
  return rounded === 0 && value > 0 ? base : rounded;
}

export interface DisclosurePolicy {
  valueRoundingBase: number;
  complementarySuppression: boolean;
}

/** An allowed signal after disclosure control: banded, rounded, ready to store. */
export type PublishedSignal = AllowedSignal & {
  cohortBand: string;
  valueRoundingBase: number;
};

export interface DisclosureResult {
  signals: PublishedSignal[];
  suppressed: SuppressedCohort[];
  /** Cohorts withheld purely to protect another suppressed cohort. */
  complementarySuppressed: number;
}

/**
 * Apply disclosure control to the firewall's output.
 *
 * Runs AFTER the threshold stage: everything arriving in `signals` has already
 * passed the minimum cohort. This step can only ever remove or blur — it never
 * admits a cohort the firewall rejected.
 */
export function applyDisclosureControl(
  signals: AllowedSignal[],
  suppressed: SuppressedCohort[],
  policy: DisclosurePolicy,
): DisclosureResult {
  let published = [...signals];
  const withheld = [...suppressed];
  let complementarySuppressed = 0;

  // 1. Complementary suppression. With a single hidden cohort among published
  //    siblings, the hidden value is the difference between the total and the
  //    visible ones. Withhold the smallest published cohort as well — smallest
  //    because it costs the least utility and is itself the most sensitive.
  if (
    policy.complementarySuppression &&
    withheld.length === 1 &&
    published.length > 0
  ) {
    const smallest = published.reduce((a, b) => (b.cohortSize < a.cohortSize ? b : a));
    published = published.filter((s) => s !== smallest);
    withheld.push({
      signalKey: smallest.signalKey,
      scopeId: smallest.scopeId,
      cohortSize: smallest.cohortSize,
      reason: 'complementary_suppression',
    });
    complementarySuppressed = 1;
  }

  // 2 & 3. Band the cohort size and round the measurement on what survives.
  const banded = published.map((signal) => ({
    ...signal,
    value: roundValue(signal.value, policy.valueRoundingBase),
    valueRoundingBase: policy.valueRoundingBase,
    cohortBand: cohortBand(signal.cohortSize, signal.minCohortSize),
    provenance: {
      ...signal.provenance,
      disclosureControl: {
        cohortSizeBanded: true,
        valueRoundedToBase: policy.valueRoundingBase,
        complementarySuppression: policy.complementarySuppression,
      },
    },
  }));

  return { signals: banded, suppressed: withheld, complementarySuppressed };
}
