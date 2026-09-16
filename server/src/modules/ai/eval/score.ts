import type { IntakeExtraction, SourceRecord, SummaryResult } from '../ai.types.js';

/**
 * Pure scoring functions for AI eval. No I/O, no logging of content — they take
 * expected values plus provider output and return only numeric verdicts, so
 * they never surface fixture text or PHI.
 */

/** Citation refs an intake extraction is allowed to ground on. Anything else is a hallucination. */
const ALLOWED_INTAKE_REFS = new Set<string>(['input-text']);

export interface IntakeScore {
  fixtureId: string;
  /** exactFieldMatches / (# output fields); 0 when there are no output fields. */
  precision: number;
  /** exactFieldMatches / expectedCount; 0 when nothing is expected. */
  recall: number;
  /** Output fields whose name AND value exactly match an expected pair. */
  exactFieldMatches: number;
  expectedCount: number;
  /** Output citations whose ref is not in the allowed set. */
  hallucinatedCitations: number;
}

/** Score an intake extraction: precision/recall over field name+value pairs plus citation grounding. */
export function scoreIntake(
  fixtureId: string,
  expected: Record<string, string>,
  output: IntakeExtraction,
): IntakeScore {
  const expectedEntries = Object.entries(expected);
  const expectedCount = expectedEntries.length;
  const outputCount = output.fields.length;

  let exactFieldMatches = 0;
  for (const field of output.fields) {
    if (Object.prototype.hasOwnProperty.call(expected, field.name) && expected[field.name] === field.value) {
      exactFieldMatches += 1;
    }
  }

  const precision = outputCount === 0 ? 0 : exactFieldMatches / outputCount;
  const recall = expectedCount === 0 ? 0 : exactFieldMatches / expectedCount;

  let hallucinatedCitations = 0;
  for (const citation of output.citations) {
    if (!ALLOWED_INTAKE_REFS.has(citation.ref)) hallucinatedCitations += 1;
  }

  return { fixtureId, precision, recall, exactFieldMatches, expectedCount, hallucinatedCitations };
}

export interface SummaryScore {
  fixtureId: string;
  /** Total citations the summary returned. */
  citations: number;
  /** Citations whose ref matches some provided source ref. */
  grounded: number;
  /** Citations whose ref matches no provided source (fabricated). */
  hallucinated: number;
  /** True iff nothing was hallucinated. */
  ok: boolean;
}

/** Score a summary: every citation must ground on one of the supplied source refs. */
export function scoreSummary(
  fixtureId: string,
  sources: SourceRecord[],
  output: SummaryResult,
): SummaryScore {
  const sourceRefs = new Set<string>(sources.map((s) => s.ref));
  const citations = output.citations.length;

  let grounded = 0;
  for (const citation of output.citations) {
    if (sourceRefs.has(citation.ref)) grounded += 1;
  }
  const hallucinated = citations - grounded;

  return { fixtureId, citations, grounded, hallucinated, ok: hallucinated === 0 };
}
