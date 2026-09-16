/**
 * Versioned identifiers for AI prompts and output schemas.
 *
 * Prompts and output schemas are production assets: they evolve, and every
 * stored/validated AI artifact is tagged with the exact version that produced
 * or validated it so drift is auditable. Bump the version string here (never
 * mutate an existing one in place) when a prompt or schema shape changes.
 */

export const SCHEMA_VERSIONS = {
  intake_extraction: 'intake-v1',
  summary: 'summary-v1',
} as const;

export const PROMPT_VERSIONS = {
  intake_extraction: 'intake-prompt-v1',
  summary: 'summary-prompt-v1',
} as const;
