import { describe, expect, it } from 'vitest';
import { renderPdf, textWidth, wrapText, type PdfDocument } from '../../src/modules/clinical/report/pdf.js';

const doc = (blocks: PdfDocument['blocks']): PdfDocument => ({
  title: 'Test Report',
  footer: 'Generated 2026-01-01 00:00 UTC',
  blocks,
});

describe('PDF renderer', () => {
  it('produces a structurally valid PDF', () => {
    const pdf = renderPdf(doc([{ kind: 'title', text: 'Hello' }]));
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
    expect(text).toContain('/BaseFont /Helvetica');
    expect(text).toContain('xref');
  });

  it('writes byte-accurate cross-reference offsets', () => {
    const pdf = renderPdf(doc([{ kind: 'paragraph', text: 'Offsets must be exact.' }]));
    const text = pdf.toString('latin1');

    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    // Every offset in the table must land on its own "N 0 obj" header.
    const table = text.slice(startxref);
    const entries = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThan(3);
    entries.forEach((offset, index) => {
      expect(text.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true);
    });
  });

  it('is deterministic: the same model always yields the same bytes', () => {
    const model = doc([
      { kind: 'title', text: 'Encounter Report' },
      { kind: 'field', label: 'MRN', value: 'MRN-000001' },
      { kind: 'paragraph', text: 'Patient reviewed and stable.' },
    ]);
    expect(renderPdf(model).equals(renderPdf(model))).toBe(true);
  });

  it('paginates long content and numbers every page', () => {
    const blocks = Array.from({ length: 200 }, (_, i) => ({
      kind: 'paragraph' as const,
      text: `Line number ${i} of a long clinical note.`,
    }));
    const text = renderPdf(doc(blocks)).toString('latin1');
    const pageCount = Number(/\/Count (\d+)/.exec(text)![1]);
    expect(pageCount).toBeGreaterThan(1);
    expect(text).toContain(`Page 1 of ${pageCount}`);
    expect(text).toContain(`Page ${pageCount} of ${pageCount}`);
  });

  it('escapes PDF string syntax so content cannot break the document', () => {
    const pdf = renderPdf(doc([{ kind: 'paragraph', text: 'Dose (2) \\ day) Tj ET' }]));
    const text = pdf.toString('latin1');
    expect(text).toContain('\\(2\\)');
    expect(text).toContain('\\\\');
    // The injected operators are inside an escaped literal, not loose commands.
    expect(text).toContain('day\\) Tj ET) Tj');
    // Structure survives.
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('substitutes characters the base-14 font cannot draw', () => {
    const text = renderPdf(doc([{ kind: 'paragraph', text: 'Name: أحمد' }])).toString('latin1');
    expect(text).toContain('Name: ????');
  });

  it('wraps text within the given width and never exceeds it', () => {
    const width = 200;
    const lines = wrapText(
      'The patient reports a persistent cough that has continued for five days without fever.',
      10,
      false,
      width,
    );
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, 10, false)).toBeLessThanOrEqual(width);
  });

  it('breaks a single word that is wider than the column', () => {
    const lines = wrapText('A'.repeat(300), 10, false, 100);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, 10, false)).toBeLessThanOrEqual(100);
    expect(lines.join('')).toBe('A'.repeat(300));
  });

  it('preserves explicit line breaks', () => {
    expect(wrapText('one\ntwo\nthree', 10, false, 400)).toEqual(['one', 'two', 'three']);
  });
});
