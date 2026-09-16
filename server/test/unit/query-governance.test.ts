import { describe, expect, it } from 'vitest';
import {
  decideQuery,
  isStrictlyNarrowerThan,
  narrowingDepth,
  type QueryGovernancePolicy,
  type QuerySlice,
} from '../../src/modules/intelligence/query-governance.js';
import {
  applyDisclosureControl,
  cohortBand,
  roundValue,
} from '../../src/modules/intelligence/disclosure.js';
import type { AllowedSignal, SuppressedCohort } from '../../src/modules/intelligence/firewall.js';

const policy: QueryGovernancePolicy = {
  maxQueriesPerWindow: 30,
  queryWindowHours: 24,
  maxNarrowingDepth: 2,
};

function slice(overrides: Partial<QuerySlice> = {}): QuerySlice {
  return {
    signalType: 'hcp_feedback_theme',
    jurisdiction: 'EG',
    scopeKeys: ['t-a', 't-b'],
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    ...overrides,
  };
}

describe('query governance — narrowing detection', () => {
  it('sees a smaller territory set inside a larger one', () => {
    expect(isStrictlyNarrowerThan(slice({ scopeKeys: ['t-a'] }), slice())).toBe(true);
  });

  it('sees a shorter period inside a longer one', () => {
    expect(isStrictlyNarrowerThan(slice({ periodEnd: '2026-01-30' }), slice())).toBe(true);
  });

  it('treats an unrestricted slice as containing every explicit slice', () => {
    const everything = slice({ scopeKeys: [] });
    expect(isStrictlyNarrowerThan(slice({ scopeKeys: ['t-a'] }), everything)).toBe(true);
    // …and nothing is narrower than an unrestricted slice over the same period.
    expect(isStrictlyNarrowerThan(everything, everything)).toBe(false);
  });

  it('does not treat an identical slice as narrowing (a re-run is not an attack)', () => {
    expect(isStrictlyNarrowerThan(slice(), slice())).toBe(false);
  });

  it('does not treat a WIDER or disjoint slice as narrowing', () => {
    expect(isStrictlyNarrowerThan(slice(), slice({ scopeKeys: ['t-a'] }))).toBe(false);
    expect(isStrictlyNarrowerThan(slice({ scopeKeys: ['t-z'] }), slice())).toBe(false);
  });

  it('does not connect slices across different signal types or jurisdictions', () => {
    expect(isStrictlyNarrowerThan(slice({ scopeKeys: ['t-a'] }), slice({ signalType: 'other' }))).toBe(
      false,
    );
    expect(
      isStrictlyNarrowerThan(slice({ scopeKeys: ['t-a'] }), slice({ jurisdiction: 'US' })),
    ).toBe(false);
  });

  it('counts the depth of a narrowing chain', () => {
    const history = [
      slice({ scopeKeys: [] }),
      slice(),
      slice({ scopeKeys: ['t-a'] }),
    ];
    // The final, narrowest slice sits inside all three earlier ones.
    expect(narrowingDepth(slice({ scopeKeys: ['t-a'], periodEnd: '2026-01-15' }), history)).toBe(3);
  });
});

describe('query governance — decisions', () => {
  it('allows a first query', () => {
    expect(decideQuery(slice(), [], policy)).toEqual({ allowed: true, narrowingDepth: 0 });
  });

  it('allows shallow narrowing', () => {
    const history = [slice({ scopeKeys: [] }), slice()];
    const decision = decideQuery(slice({ scopeKeys: ['t-a'] }), history, policy);
    expect(decision.allowed).toBe(true);
  });

  it('REFUSES narrowing past the permitted depth', () => {
    const history = [
      slice({ scopeKeys: [] }),
      slice(),
      slice({ scopeKeys: ['t-a'] }),
    ];
    const decision = decideQuery(
      slice({ scopeKeys: ['t-a'], periodEnd: '2026-01-15' }),
      history,
      policy,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.outcome).toBe('denied_narrowing');
    expect(decision.narrowingDepth).toBe(3);
  });

  it('a depth-0 policy refuses any narrowing at all', () => {
    const strict = { ...policy, maxNarrowingDepth: 0 };
    const decision = decideQuery(slice({ scopeKeys: ['t-a'] }), [slice()], strict);
    expect(decision.allowed).toBe(false);
  });

  it('REFUSES once the budget is exhausted', () => {
    const history = Array.from({ length: 30 }, () => slice({ scopeKeys: ['t-z'] }));
    const decision = decideQuery(slice(), history, policy);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.outcome).toBe('denied_budget');
  });

  it('checks the budget before the narrowing rule (cheaper, less informative refusal)', () => {
    const history = Array.from({ length: 30 }, () => slice({ scopeKeys: [] }));
    const decision = decideQuery(slice({ scopeKeys: ['t-a'] }), history, policy);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.outcome).toBe('denied_budget');
  });
});

describe('disclosure control — banding and rounding', () => {
  it('bands a cohort size and never advertises a bound below the threshold', () => {
    expect(cohortBand(7, 5)).toBe('5-9');
    expect(cohortBand(12, 5)).toBe('10-19');
    expect(cohortBand(300, 5)).toBe('250-499');
    expect(cohortBand(5000, 5)).toBe('500+');
    // A stricter policy raises the visible floor with it.
    expect(cohortBand(22, 20)).toBe('20-49');
  });

  it('rounds a measurement to the policy base', () => {
    expect(roundValue(7, 5)).toBe(5);
    expect(roundValue(8, 5)).toBe(10);
    expect(roundValue(13, 1)).toBe(13);
  });

  it('never rounds a non-zero measurement down to zero', () => {
    // Publishing 0 for a cohort that passed the threshold would itself disclose
    // that the group exists but did nothing.
    expect(roundValue(1, 5)).toBe(5);
    expect(roundValue(2, 10)).toBe(10);
  });
});

function signal(key: string, cohortSize: number, value = cohortSize): AllowedSignal {
  return {
    signalType: 'hcp_feedback_theme',
    signalKey: key,
    signalLabel: key,
    scopeType: 'territory',
    scopeId: 't-a',
    scopeLabel: 'Cairo',
    jurisdiction: 'EG',
    aggregationLevel: 'territory',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    value,
    valueUnit: 'count',
    cohortSize,
    minCohortSize: 5,
    confidence: 0.5,
    source: 'pharma_field',
    sourceVersion: null,
    method: 'test',
    provenance: {},
    policyKey: 'default',
  };
}

const disclosurePolicy = { valueRoundingBase: 5, complementarySuppression: true };

describe('disclosure control — complementary suppression', () => {
  const suppressedOne: SuppressedCohort[] = [
    { signalKey: 'cost', scopeId: 't-a', cohortSize: 2, reason: 'below_min_cohort' },
  ];

  it('withholds a second cohort when exactly one was suppressed', () => {
    // With one hidden cell among published siblings, the hidden value is
    // recoverable by subtraction, so the smallest published cell goes too.
    const result = applyDisclosureControl(
      [signal('safety', 20), signal('efficacy', 6)],
      suppressedOne,
      disclosurePolicy,
    );
    expect(result.complementarySuppressed).toBe(1);
    expect(result.signals.map((s) => s.signalKey)).toEqual(['safety']);
    expect(result.suppressed.map((s) => s.reason)).toContain('complementary_suppression');
  });

  it('suppresses the SMALLEST published cohort, not an arbitrary one', () => {
    const result = applyDisclosureControl(
      [signal('a', 30), signal('b', 6), signal('c', 50)],
      suppressedOne,
      disclosurePolicy,
    );
    expect(result.signals.map((s) => s.signalKey).sort()).toEqual(['a', 'c']);
  });

  it('does nothing when several cohorts were already suppressed', () => {
    const many: SuppressedCohort[] = [
      { signalKey: 'cost', scopeId: 't-a', cohortSize: 2, reason: 'below_min_cohort' },
      { signalKey: 'guideline', scopeId: 't-a', cohortSize: 3, reason: 'below_min_cohort' },
    ];
    const result = applyDisclosureControl([signal('safety', 20)], many, disclosurePolicy);
    expect(result.complementarySuppressed).toBe(0);
    expect(result.signals).toHaveLength(1);
  });

  it('does nothing when nothing was suppressed', () => {
    const result = applyDisclosureControl([signal('safety', 20)], [], disclosurePolicy);
    expect(result.complementarySuppressed).toBe(0);
    expect(result.signals).toHaveLength(1);
  });

  it('bands, rounds and records what it did in provenance', () => {
    const result = applyDisclosureControl([signal('safety', 7, 7)], [], disclosurePolicy);
    const published = result.signals[0]!;
    expect(published.cohortBand).toBe('5-9');
    expect(published.value).toBe(5);
    expect(published.valueRoundingBase).toBe(5);
    expect(published.provenance.disclosureControl).toMatchObject({
      cohortSizeBanded: true,
      valueRoundedToBase: 5,
    });
  });

  it('can only remove or blur — it never admits a new cohort', () => {
    const result = applyDisclosureControl([], suppressedOne, disclosurePolicy);
    expect(result.signals).toEqual([]);
  });
});
