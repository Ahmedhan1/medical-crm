import { describe, expect, it } from 'vitest';
import type { IntakeExtraction } from '../../src/modules/ai/ai.types.js';
import { runIntakeEval, runSummaryEval } from '../../src/modules/ai/eval/runner.js';
import { scoreIntake } from '../../src/modules/ai/eval/score.js';

describe('AI eval runner (default local provider)', () => {
  it('runs the intake suite with every fixture passing', async () => {
    const report = await runIntakeEval();
    expect(report.suite).toBe('intake');
    expect(report.total).toBeGreaterThan(0);
    expect(report.passed).toBe(report.total);
    expect(report.failed).toBe(0);
    expect(Number.isFinite(report.avgLatencyMs)).toBe(true);
    expect(report.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('runs the summary suite with every fixture passing', async () => {
    const report = await runSummaryEval();
    expect(report.suite).toBe('summary');
    expect(report.total).toBeGreaterThan(0);
    expect(report.passed).toBe(report.total);
    expect(report.failed).toBe(0);
    expect(Number.isFinite(report.avgLatencyMs)).toBe(true);
    expect(report.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('scoreIntake citation grounding', () => {
  it('flags a citation with a ref outside the allowed set as hallucinated', () => {
    const output: IntakeExtraction = {
      fields: [{ name: 'chiefComplaint', value: 'fever' }],
      citations: [
        { ref: 'input-text', kind: 'transcript', quote: 'fever' },
        { ref: 'made-up-ref', kind: 'transcript', quote: 'fever' },
      ],
    };
    const score = scoreIntake('unit-hallucination', { chiefComplaint: 'fever' }, output);
    expect(score.hallucinatedCitations).toBeGreaterThanOrEqual(1);
  });
});
