import { describe, expect, it } from 'vitest';
import { LocalAIProvider } from '../../src/modules/ai/providers/local.provider.js';
import type { SourceRecord } from '../../src/modules/ai/ai.types.js';

const provider = new LocalAIProvider();

describe('LocalAIProvider.extractIntake (grounded, deterministic)', () => {
  it('extracts labelled intake fields from free text', async () => {
    const text = 'Chief complaint: headache\nDuration: 3 days\nAllergies: penicillin';
    const result = await provider.extractIntake({ text });
    const byName = Object.fromEntries(result.fields.map((f) => [f.name, f.value]));
    expect(byName.chiefComplaint).toBe('headache');
    expect(byName.duration).toBe('3 days');
    expect(byName.allergies).toBe('penicillin');
    // Every field is grounded by a citation quoting the source value.
    expect(result.citations.length).toBe(result.fields.length);
  });

  it('is deterministic (same input ⇒ same output)', async () => {
    const text = 'Complaint: cough for 2 weeks';
    const a = await provider.extractIntake({ text });
    const b = await provider.extractIntake({ text });
    expect(a).toEqual(b);
  });

  it('invents nothing when the text has no recognisable intake content', async () => {
    const result = await provider.extractIntake({ text: 'the weather is nice today' });
    expect(result.fields).toEqual([]);
  });
});

describe('LocalAIProvider.summarize (no fabrication path)', () => {
  const sources: SourceRecord[] = [
    { ref: 'event:1', kind: 'event', text: 'Patient registered', occurredAt: '2026-01-01T09:00:00Z' },
    { ref: 'event:2', kind: 'event', text: 'Checked in for a visit', occurredAt: '2026-01-02T10:00:00Z' },
  ];

  it('cites only the provided sources', async () => {
    const result = await provider.summarize({ sources, kind: 'summary' });
    const citedRefs = result.citations.map((c) => c.ref).sort();
    expect(citedRefs).toEqual(['event:1', 'event:2']);
    // No citation references a source not supplied.
    const allowed = new Set(sources.map((s) => s.ref));
    expect(result.citations.every((c) => allowed.has(c.ref))).toBe(true);
  });

  it('refuses (empty summary, no citations) when given no sources', async () => {
    const result = await provider.summarize({ sources: [], kind: 'summary' });
    expect(result.summary).toBe('');
    expect(result.citations).toEqual([]);
  });
});
