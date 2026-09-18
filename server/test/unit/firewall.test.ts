import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_MIN_COHORT,
  aggregate,
  confidenceForCohort,
  deidentify,
  runFirewall,
  validatePolicy,
  type CohortContribution,
  type FirewallPolicy,
  type FirewallRequest,
} from '../../src/modules/intelligence/firewall.js';
import { DataClass } from '../../src/modules/intelligence/classification.js';

const policy: FirewallPolicy = {
  key: 'default',
  jurisdiction: 'EG',
  minCohortSize: ABSOLUTE_MIN_COHORT,
  maxPrecision: 'territory',
  requiresDeidentification: true,
  allowedSignalTypes: [],
};

const request: FirewallRequest = {
  signalType: 'hcp_feedback_theme',
  scopeType: 'territory',
  aggregationLevel: 'territory',
  jurisdiction: 'EG',
  periodStart: '2026-01-01',
  periodEnd: '2026-03-31',
  source: 'pharma_field',
  method: 'test',
};

function contributions(
  count: number,
  dimension = 'safety',
  scopeId = 'territory-1',
): CohortContribution[] {
  return Array.from({ length: count }, (_, i) => ({
    subjectKey: `hcp-${dimension}-${i}`,
    dataClass: DataClass.HCP_PROFESSIONAL,
    dimension,
    scopeId,
    scopeLabel: 'Cairo North',
  }));
}

describe('intelligence firewall — stage 1 classification', () => {
  it('refuses patient-identifiable data regardless of how much of it there is', () => {
    const rows: CohortContribution[] = [
      ...contributions(20),
      {
        subjectKey: 'patient-1',
        dataClass: DataClass.PATIENT_IDENTIFIABLE,
        dimension: 'safety',
        scopeId: 'territory-1',
        scopeLabel: 'Cairo North',
      },
    ];
    // A single patient-class row aborts the whole run — it is never quietly
    // dropped, because its presence means an upstream source is mis-wired.
    expect(() => runFirewall(rows, request, policy)).toThrow(/cannot enter a pharma intelligence/i);
  });

  it('refuses pseudonymous patient data too (pseudonymous is not anonymous)', () => {
    const rows: CohortContribution[] = [
      {
        subjectKey: 'pseudo-1',
        dataClass: DataClass.PATIENT_PSEUDONYMOUS,
        dimension: 'safety',
        scopeId: 'territory-1',
        scopeLabel: 'Cairo North',
      },
    ];
    expect(() => runFirewall(rows, request, policy)).toThrow(/cannot enter a pharma intelligence/i);
  });
});

describe('intelligence firewall — stage 3 de-identification', () => {
  it('replaces the subject key with an unlinkable hash', () => {
    const [row] = deidentify(contributions(1), 'salt-a');
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('hcp-safety-0');
    expect(row!.subjectHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes under different run salts (no cross-run linkage)', () => {
    const a = deidentify(contributions(1), 'salt-a')[0]!.subjectHash;
    const b = deidentify(contributions(1), 'salt-b')[0]!.subjectHash;
    expect(a).not.toBe(b);
  });

  it('is stable within a run so distinct subjects can still be counted', () => {
    const rows = deidentify([...contributions(1), ...contributions(1)], 'salt-a');
    expect(rows[0]!.subjectHash).toBe(rows[1]!.subjectHash);
  });
});

describe('intelligence firewall — stage 4 aggregation', () => {
  it('counts distinct subjects, not observations', () => {
    const repeated = [...contributions(3), ...contributions(3)]; // same 3 subjects twice
    const [cohort] = aggregate(deidentify(repeated, 'salt'));
    expect(cohort!.cohortSize).toBe(3);
    expect(cohort!.observations).toBe(6);
  });

  it('groups by dimension and scope', () => {
    const rows = [
      ...contributions(2, 'safety', 'territory-1'),
      ...contributions(2, 'cost', 'territory-1'),
      ...contributions(2, 'safety', 'territory-2'),
    ];
    expect(aggregate(deidentify(rows, 'salt'))).toHaveLength(3);
  });
});

describe('intelligence firewall — stage 5 minimum cohort threshold', () => {
  it('returns nothing for a cohort below the threshold', () => {
    const result = runFirewall(contributions(ABSOLUTE_MIN_COHORT - 1), request, policy);
    expect(result.signals).toEqual([]);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]!.reason).toBe('below_min_cohort');
  });

  it('publishes a cohort exactly at the threshold', () => {
    const result = runFirewall(contributions(ABSOLUTE_MIN_COHORT), request, policy);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.cohortSize).toBe(ABSOLUTE_MIN_COHORT);
  });

  it('suppresses only the small cohorts, publishing the large ones', () => {
    const rows = [
      ...contributions(8, 'safety', 'territory-1'),
      ...contributions(2, 'cost', 'territory-1'),
    ];
    const result = runFirewall(rows, request, policy);
    expect(result.signals.map((s) => s.signalKey)).toEqual(['safety']);
    expect(result.suppressed.map((s) => s.signalKey)).toEqual(['cost']);
  });

  it('cannot be weakened below the absolute floor by a permissive policy', () => {
    const weakened: FirewallPolicy = { ...policy, minCohortSize: 1 };
    const result = runFirewall(contributions(3), request, weakened);
    expect(result.signals).toEqual([]);
    // The floor, not the policy value, is what was applied.
    const atFloor = runFirewall(contributions(ABSOLUTE_MIN_COHORT), request, weakened);
    expect(atFloor.signals[0]!.minCohortSize).toBe(ABSOLUTE_MIN_COHORT);
  });

  it('honours a policy stricter than the floor', () => {
    const strict: FirewallPolicy = { ...policy, minCohortSize: 25 };
    expect(runFirewall(contributions(10), request, strict).signals).toEqual([]);
    expect(runFirewall(contributions(25), request, strict).signals).toHaveLength(1);
  });
});

describe('intelligence firewall — stage 6 policy validation', () => {
  it('rejects a scope finer than the policy allows', () => {
    const regional: FirewallPolicy = { ...policy, maxPrecision: 'region' };
    expect(validatePolicy(request, regional)).toBe('policy_precision');
    const result = runFirewall(contributions(50), request, regional);
    expect(result.signals).toEqual([]);
    expect(result.suppressed[0]!.reason).toBe('policy_precision');
  });

  it('allows a scope coarser than the policy limit', () => {
    const regional: FirewallPolicy = { ...policy, maxPrecision: 'region' };
    const countryRequest: FirewallRequest = { ...request, scopeType: 'country' };
    expect(validatePolicy(countryRequest, regional)).toBeNull();
  });

  it('rejects a signal type outside the policy allow-list', () => {
    const restricted: FirewallPolicy = { ...policy, allowedSignalTypes: ['product_interest'] };
    expect(validatePolicy(request, restricted)).toBe('policy_signal_type');
  });

  it('rejects a jurisdiction mismatch', () => {
    expect(validatePolicy({ ...request, jurisdiction: 'US' }, policy)).toBe('policy_jurisdiction');
  });

  it('refuses a policy that does not require de-identification', () => {
    const unsafe: FirewallPolicy = { ...policy, requiresDeidentification: false };
    expect(() => runFirewall(contributions(50), request, unsafe)).toThrow(/de-identification/i);
  });
});

describe('intelligence firewall — stage 7 signal envelope', () => {
  it('attaches the full governance envelope to every published signal', () => {
    const result = runFirewall(contributions(12), request, policy);
    const signal = result.signals[0]!;
    expect(signal).toMatchObject({
      signalType: 'hcp_feedback_theme',
      scopeType: 'territory',
      jurisdiction: 'EG',
      aggregationLevel: 'territory',
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      source: 'pharma_field',
      valueUnit: 'count',
      policyKey: 'default',
    });
    expect(signal.cohortSize).toBe(12);
    expect(signal.minCohortSize).toBe(ABSOLUTE_MIN_COHORT);
    expect(signal.confidence).toBeGreaterThan(0);
    expect(signal.method).toBeTruthy();
    expect(signal.provenance).toHaveProperty('pipeline');
  });

  it('never carries a subject identifier into the published signal', () => {
    const result = runFirewall(contributions(12), request, policy);
    expect(JSON.stringify(result.signals)).not.toContain('hcp-safety-');
  });

  it('scores confidence by cohort size and never reaches certainty', () => {
    expect(confidenceForCohort(5)).toBeLessThan(confidenceForCohort(50));
    expect(confidenceForCohort(10_000)).toBeLessThanOrEqual(0.95);
  });
});
