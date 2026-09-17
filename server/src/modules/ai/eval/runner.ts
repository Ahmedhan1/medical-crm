import type { AIProvider } from '../ai.types.js';
import { LocalAIProvider } from '../providers/local.provider.js';
import { INTAKE_FIXTURES, SUMMARY_FIXTURES } from './fixtures.js';
import { scoreIntake, scoreSummary } from './score.js';

/**
 * Eval runner: exercises an AIProvider against the deterministic fixtures and
 * reports pass/fail plus latency. It records ONLY fixture ids and numbers —
 * never fixture text, extracted values, or summaries — so reports are safe to
 * persist. No DB, no network, no content logging.
 */

export interface EvalCaseResult {
  fixtureId: string;
  passed: boolean;
  latencyMs: number;
}

export interface EvalReport {
  suite: 'intake' | 'summary';
  provider: string;
  model?: string;
  total: number;
  passed: number;
  failed: number;
  avgLatencyMs: number;
  results: EvalCaseResult[];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function buildReport(
  suite: 'intake' | 'summary',
  provider: AIProvider,
  results: EvalCaseResult[],
): EvalReport {
  const passed = results.filter((r) => r.passed).length;
  const report: EvalReport = {
    suite,
    provider: provider.id,
    total: results.length,
    passed,
    failed: results.length - passed,
    avgLatencyMs: avg(results.map((r) => r.latencyMs)),
    results,
  };
  if (provider.model !== undefined) report.model = provider.model;
  return report;
}

/**
 * Run the intake extraction suite. Passes only when recall AND precision are
 * perfect and no citation is hallucinated. Precision is required so a provider
 * that emits EXTRA/incorrect fields cannot game a recall-only metric into a
 * misleading "pass".
 */
export async function runIntakeEval(provider: AIProvider = new LocalAIProvider()): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const fixture of INTAKE_FIXTURES) {
    const started = performance.now();
    const output = await provider.extractIntake({ text: fixture.text });
    const latencyMs = performance.now() - started;
    const score = scoreIntake(fixture.id, fixture.expected, output);
    const passed = score.recall >= 0.99 && score.precision >= 0.99 && score.hallucinatedCitations === 0;
    results.push({ fixtureId: fixture.id, passed, latencyMs });
  }
  return buildReport('intake', provider, results);
}

/** Run the summary suite. Passes when all citations are grounded and meet the min-citation bar. */
export async function runSummaryEval(provider: AIProvider = new LocalAIProvider()): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const fixture of SUMMARY_FIXTURES) {
    const started = performance.now();
    const output = await provider.summarize({ sources: fixture.sources, kind: 'summary' });
    const latencyMs = performance.now() - started;
    const score = scoreSummary(fixture.id, fixture.sources, output);
    const passed =
      score.grounded === score.citations &&
      score.hallucinated === 0 &&
      score.citations >= fixture.expectMinCitations;
    results.push({ fixtureId: fixture.id, passed, latencyMs });
  }
  return buildReport('summary', provider, results);
}
