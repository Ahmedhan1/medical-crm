/**
 * AI provider contract (blueprint §12–13, §27, §39).
 *
 * The platform depends only on these interfaces, never on a specific vendor, so
 * a local model, a self-hosted model, or a cloud API can back them
 * interchangeably. The default is a deterministic local provider so tests and
 * offline clinics work with no credentials and no network.
 *
 * SAFETY: every AI capability produces GROUNDED, REVIEW-FIRST output. Providers
 * return structured content plus explicit CITATIONS to the source records the
 * output is derived from. Nothing an AI produces is authoritative until a human
 * confirms it; AI never diagnoses, prescribes, or writes a clinical record.
 */

/** A source record supplied to a summariser; the AI may only ground on these. */
export interface SourceRecord {
  /** Stable id used in citations (e.g. an event id or encounter id). */
  ref: string;
  kind: string; // e.g. 'event', 'encounter'
  /** Human-readable, already-authorized fact text. */
  text: string;
  occurredAt?: string;
}

/** A citation back to a source record the output is grounded in. */
export interface Citation {
  ref: string;
  kind: string;
  quote?: string;
}

export interface TranscriptionInput {
  /** Raw text (already transcribed) OR a provider-resolvable audio reference. */
  text?: string;
  audioRef?: string;
  locale?: string;
}

export interface TranscriptionResult {
  text: string;
}

export interface IntakeField {
  name: string;
  value: string;
  /** Character offsets in the source text supporting this value (grounding). */
  sourceSpan?: [number, number];
}

export interface IntakeExtraction {
  fields: IntakeField[];
  citations: Citation[];
}

export interface SummaryResult {
  summary: string;
  citations: Citation[];
}

export interface AIProvider {
  readonly id: string;
  readonly model?: string;

  /** Optional: turn audio into text. Local provider echoes provided text. */
  transcribe?(input: TranscriptionInput): Promise<TranscriptionResult>;

  /** Extract structured intake fields from free text. Grounded, no invention. */
  extractIntake(input: { text: string }): Promise<IntakeExtraction>;

  /**
   * Summarise the supplied sources. MUST cite only the provided sources and
   * MUST NOT introduce facts not present in them. With no sources, it must
   * refuse (empty summary) rather than fabricate.
   */
  summarize(input: { sources: SourceRecord[]; kind: string }): Promise<SummaryResult>;
}
