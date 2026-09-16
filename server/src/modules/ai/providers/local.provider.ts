import type {
  AIProvider,
  IntakeExtraction,
  IntakeField,
  SourceRecord,
  SummaryResult,
  TranscriptionInput,
  TranscriptionResult,
} from '../ai.types.js';

/**
 * Local, deterministic AI provider — the offline/default implementation.
 *
 * It performs NO network calls and NEVER fabricates: it extracts only what is
 * literally present in the input and summarises strictly from the supplied,
 * already-authorized source records. This is the "clean adapter + deterministic
 * behaviour" the platform ships so it works without provider credentials; a
 * cloud/self-hosted model implementing `AIProvider` can be swapped in without
 * changing any caller.
 *
 * Because it is grounded and non-generative, its output is still handled
 * review-first: everything it returns becomes an AI draft a human must confirm.
 */
export class LocalAIProvider implements AIProvider {
  readonly id = 'local-deterministic';
  readonly model = 'rule-based-v1';
  readonly tier = 'local' as const;

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    // No real audio decoding offline; a provided transcript passes through. An
    // audioRef with no text cannot be decoded locally — surface that honestly.
    if (input.text) return { text: input.text };
    throw new Error('Local provider cannot decode audio; supply transcribed text');
  }

  async extractIntake(input: { text: string }): Promise<IntakeExtraction> {
    const text = input.text ?? '';
    const fields: IntakeField[] = [];

    // 1. Explicit "label: value" pairs for recognised intake labels.
    const labelMap: Record<string, string> = {
      'chief complaint': 'chiefComplaint',
      complaint: 'chiefComplaint',
      duration: 'duration',
      history: 'history',
      allergy: 'allergies',
      allergies: 'allergies',
      medication: 'medications',
      medications: 'medications',
    };
    const lineRegex = /^\s*([A-Za-z ]+?)\s*[:\-]\s*(.+?)\s*$/gm;
    for (const m of text.matchAll(lineRegex)) {
      const label = m[1]!.trim().toLowerCase();
      const canonical = labelMap[label];
      if (canonical && !fields.some((f) => f.name === canonical)) {
        const start = m.index! + m[0]!.indexOf(m[2]!);
        fields.push({ name: canonical, value: m[2]!.trim(), sourceSpan: [start, start + m[2]!.length] });
      }
    }

    // 2. A duration mentioned inline (e.g. "for 3 days") if not already found.
    if (!fields.some((f) => f.name === 'duration')) {
      const dur = /\bfor\s+(\d+\s*(?:day|days|week|weeks|month|months|hour|hours))\b/i.exec(text);
      if (dur) {
        const start = dur.index + dur[0].indexOf(dur[1]!);
        fields.push({ name: 'duration', value: dur[1]!.trim(), sourceSpan: [start, start + dur[1]!.length] });
      }
    }

    const citations = fields.map((f) => ({
      ref: 'input-text',
      kind: 'transcript',
      quote: f.value,
    }));

    return { fields, citations };
  }

  async summarize(input: { sources: SourceRecord[]; kind: string }): Promise<SummaryResult> {
    // No sources ⇒ refuse rather than invent. This closes the fabrication path.
    if (input.sources.length === 0) {
      return { summary: '', citations: [] };
    }

    const ordered = [...input.sources].sort((a, b) => {
      if (!a.occurredAt || !b.occurredAt) return 0;
      return String(a.occurredAt).localeCompare(String(b.occurredAt));
    });

    const lines = ordered.map((s) => {
      const when = s.occurredAt ? `${s.occurredAt.slice(0, 10)} — ` : '';
      return `• ${when}${s.text}`;
    });

    const header =
      input.kind === 'summary'
        ? `Longitudinal summary (${ordered.length} source${ordered.length === 1 ? '' : 's'}):`
        : `Summary (${ordered.length} source${ordered.length === 1 ? '' : 's'}):`;

    const summary = [header, ...lines].join('\n');
    const citations = ordered.map((s) => ({ ref: s.ref, kind: s.kind }));

    return { summary, citations };
  }
}
