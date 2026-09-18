/**
 * Strict, versioned zod schemas for AI structured output.
 *
 * These validate what an AI provider returns BEFORE it enters the platform as a
 * review-first draft. They are the last line of defence against malformed or
 * hostile model output, so they are STRICT (unknown keys are rejected, never
 * silently dropped).
 *
 * PHI-SAFETY (blueprint §9 — never put PHI in logs): validation failures return
 * ONLY the offending path and the rule message. The offending VALUE is never
 * echoed back, because that value may be patient-identifiable free text. Callers
 * can safely log or surface `issues` without leaking PHI.
 *
 * This module is PURE: no I/O, no DB, no logging.
 */

import { z } from 'zod';
import type {
  IntakeField,
  IntakeExtraction,
  Citation,
  SummaryResult,
} from '../ai.types.js';
import { SCHEMA_VERSIONS } from './versions.js';

/** Allowed intake field names — a closed vocabulary, no free-form keys. */
export const IntakeFieldSchema = z
  .object({
    name: z.enum([
      'chiefComplaint',
      'duration',
      'history',
      'allergies',
      'medications',
      'symptoms',
      'onset',
      'severity',
      'notes',
    ]),
    value: z.string().min(1).max(2000),
    sourceSpan: z.tuple([z.number(), z.number()]).optional(),
  })
  .strict();

export const CitationSchema = z
  .object({
    ref: z.string().min(1),
    kind: z.string().min(1),
    quote: z.string().optional(),
  })
  .strict();

export const IntakeExtractionOutputSchema = z
  .object({
    fields: z.array(IntakeFieldSchema).max(50),
    citations: z.array(CitationSchema).max(100),
  })
  .strict();

export const SummaryOutputSchema = z
  .object({
    summary: z.string().max(20000),
    citations: z.array(CitationSchema).max(200),
  })
  .strict();

// Compile-time guarantees that the schemas stay in step with the AI contract.
// If ai.types.ts changes shape, these assignments fail typecheck.
type _AssertIntakeField = z.infer<typeof IntakeFieldSchema> extends IntakeField
  ? true
  : never;
type _AssertCitation = z.infer<typeof CitationSchema> extends Citation
  ? true
  : never;
type _AssertIntakeExtraction = z.infer<
  typeof IntakeExtractionOutputSchema
> extends IntakeExtraction
  ? true
  : never;
type _AssertSummary = z.infer<typeof SummaryOutputSchema> extends SummaryResult
  ? true
  : never;
// Reference the assertions so they are not reported as unused.
export type _SchemaContractChecks = [
  _AssertIntakeField,
  _AssertCitation,
  _AssertIntakeExtraction,
  _AssertSummary,
];

export type AiOutputKind = 'intake_extraction' | 'summary';

export interface ValidationOk<T> {
  ok: true;
  value: T;
  schemaVersion: string;
}

export interface ValidationErr {
  ok: false;
  issues: string[];
  schemaVersion: string;
}

const SCHEMAS = {
  intake_extraction: IntakeExtractionOutputSchema,
  summary: SummaryOutputSchema,
} as const;

/**
 * Return a rule message that never echoes model-provided input. For the two zod
 * codes whose default message interpolates input content, substitute a fixed,
 * received-free description; every other code's default message only references
 * schema-defined constants (expected types, size limits), so it is passed
 * through unchanged.
 */
function phiSafeMessage(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'invalid_enum_value':
      // Default message appends `received '<value>'`; expose only the allowed
      // options, which are our schema constants.
      return `Invalid enum value. Expected ${issue.options
        .map((o) => JSON.stringify(o))
        .join(' | ')}`;
    case 'unrecognized_keys':
      // Default message lists the offending (model-provided) key names.
      return 'Unrecognized key(s) in object';
    default:
      return issue.message;
  }
}

/**
 * Validate raw AI output against the strict schema for `kind`.
 *
 * On success returns the parsed value and the schema version it satisfied.
 * On failure returns PHI-SAFE issues: each is `<path>: <message>` where path is
 * the zod issue path joined with '.' — NEVER the offending input value.
 */
export function validateAiOutput(
  kind: AiOutputKind,
  data: unknown,
): ValidationOk<any> | ValidationErr {
  const schemaVersion = SCHEMA_VERSIONS[kind];
  const schema = SCHEMAS[kind];
  const result = schema.safeParse(data);

  if (result.success) {
    return { ok: true, value: result.data, schemaVersion };
  }

  // PHI-safe: expose only the path (schema-defined field names/indices) and a
  // rule message. A couple of zod default messages interpolate model-provided
  // content (the received enum token; the offending extra key names) which could
  // in the worst case be PHI, so those are replaced with a received-free rule
  // description. The offending input VALUE is never included by any code path.
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    const message = phiSafeMessage(issue);
    return path.length > 0 ? `${path}: ${message}` : message;
  });

  return { ok: false, issues, schemaVersion };
}
