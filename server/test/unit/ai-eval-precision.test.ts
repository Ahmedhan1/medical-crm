import { describe, expect, it } from 'vitest';
import { LocalAIProvider } from '../../src/modules/ai/providers/local.provider.js';
import { runIntakeEval } from '../../src/modules/ai/eval/runner.js';
import { scoreIntake } from '../../src/modules/ai/eval/score.js';

/**
 * GAP-AUDIT regression: the intake eval pass criterion must include PRECISION so
 * a provider that emits EXTRA/incorrect fields cannot game a recall-only metric
 * into a misleading "pass".
 */

// Extends the deterministic provider to also emit a spurious extra field —
// recall stays perfect but precision drops.
class ExtraFieldProvider extends LocalAIProvider {
  override async extractIntake(input: { text: string }) {
    const base = await super.extractIntake(input);
    return { fields: [...base.fields, { name: 'notes', value: 'SPURIOUS_EXTRA' }], citations: base.citations };
  }
}

describe('eval precision guard', () => {
  it('scoreIntake reports precision < 1 when the output has an extra field', () => {
    const score = scoreIntake('t', { chiefComplaint: 'fever' }, {
      fields: [{ name: 'chiefComplaint', value: 'fever' }, { name: 'notes', value: 'extra' }],
      citations: [{ ref: 'input-text', kind: 'transcript' }],
    });
    expect(score.recall).toBe(1);
    expect(score.precision).toBeLessThan(1);
  });

  it('a provider that emits extra fields FAILS the intake eval (recall alone would have passed)', async () => {
    const report = await runIntakeEval(new ExtraFieldProvider());
    expect(report.total).toBeGreaterThan(0);
    expect(report.failed).toBe(report.total); // every case fails on precision
  });

  it('the honest local provider still passes every case', async () => {
    const report = await runIntakeEval(new LocalAIProvider());
    expect(report.passed).toBe(report.total);
  });
});
