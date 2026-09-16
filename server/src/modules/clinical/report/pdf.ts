/**
 * A minimal, dependency-free PDF 1.4 writer for clinical reports (blueprint §31).
 *
 * Written rather than pulled in because the report needs are narrow — flowed
 * text in two standard fonts — and a PDF library is a large dependency in a
 * system that must stay auditable. It uses the base-14 Helvetica faces, so no
 * font is embedded and the output stays small.
 *
 * Output is BYTE-DETERMINISTIC: the same document model always produces the
 * same bytes. Nothing here reads the clock, so any timestamp on a report is
 * supplied by the caller and is part of the model, which makes a report
 * reproducible and therefore verifiable.
 *
 * Text is encoded as WinAnsi (Latin-1). Characters outside it — Arabic patient
 * names, for instance — cannot be drawn by a non-embedded base-14 font and are
 * replaced by '?'. See `docs/agent-state/agent-2.md` for this limitation.
 */

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** Helvetica glyph widths (units per 1000) for ASCII 32–126. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Helvetica-Bold glyph widths (units per 1000) for ASCII 32–126. */
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

function glyphWidth(ch: string, bold: boolean): number {
  const code = ch.charCodeAt(0);
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  if (code >= 32 && code <= 126) return table[code - 32]!;
  return bold ? 556 : 556;
}

/** Width of a string in points at a given size. */
export function textWidth(text: string, size: number, bold = false): number {
  let total = 0;
  for (const ch of text) total += glyphWidth(ch, bold);
  return (total * size) / 1000;
}

/** Latin-1 only: anything a non-embedded base-14 font cannot draw becomes '?'. */
function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code >= 32 && code <= 255 ? ch : code === 9 ? ' ' : '?';
  }
  return out;
}

/** Escape the three characters that are syntax inside a PDF string literal. */
function escapeString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Greedy wrap to the content width, breaking an over-long word if it must. */
export function wrapText(text: string, size: number, bold: boolean, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, size, bold) <= width) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (textWidth(word, size, bold) <= width) {
        current = word;
        continue;
      }
      // A single word wider than the column: break it at the last glyph that fits.
      let chunk = '';
      for (const ch of word) {
        if (textWidth(chunk + ch, size, bold) > width) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      current = chunk;
    }
    if (current) lines.push(current);
  }
  return lines;
}

export type PdfBlock =
  | { kind: 'title'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'field'; label: string; value: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'rule' }
  | { kind: 'spacer' };

export interface PdfDocument {
  /** Document title; also the running header on every page. */
  title: string;
  blocks: PdfBlock[];
  /** Footer text, e.g. a generation stamp. Supplied, never read from the clock. */
  footer?: string;
}

interface Line {
  text: string;
  size: number;
  bold: boolean;
  /** Indent from the left margin, in points. */
  indent: number;
  /** Vertical space consumed by this line. */
  leading: number;
  rule?: boolean;
}

const FIELD_LABEL_WIDTH = 150;

/** Flatten the block model into positioned lines, wrapping as it goes. */
function layout(blocks: readonly PdfBlock[]): Line[] {
  const lines: Line[] = [];
  const push = (
    text: string,
    size: number,
    bold: boolean,
    indent: number,
    leading: number,
    rule = false,
  ) => lines.push({ text, size, bold, indent, leading, rule });

  for (const block of blocks) {
    switch (block.kind) {
      case 'title':
        for (const l of wrapText(block.text, 18, true, CONTENT_WIDTH)) push(l, 18, true, 0, 24);
        push('', 10, false, 0, 8);
        break;
      case 'heading':
        push('', 10, false, 0, 8);
        for (const l of wrapText(block.text, 12, true, CONTENT_WIDTH)) push(l, 12, true, 0, 17);
        break;
      case 'field': {
        const valueWidth = CONTENT_WIDTH - FIELD_LABEL_WIDTH;
        const valueLines = wrapText(block.value || '—', 10, false, valueWidth);
        const labelLines = wrapText(block.label, 10, true, FIELD_LABEL_WIDTH - 8);
        const rows = Math.max(valueLines.length, labelLines.length);
        for (let i = 0; i < rows; i += 1) {
          if (labelLines[i]) push(labelLines[i]!, 10, true, 0, 0);
          push(valueLines[i] ?? '', 10, false, FIELD_LABEL_WIDTH, 14);
        }
        break;
      }
      case 'paragraph':
        for (const l of wrapText(block.text, 10, false, CONTENT_WIDTH)) push(l, 10, false, 0, 14);
        break;
      case 'bullet': {
        const wrapped = wrapText(block.text, 10, false, CONTENT_WIDTH - 14);
        wrapped.forEach((l, i) => {
          if (i === 0) push('-', 10, false, 0, 0);
          push(l, 10, false, 14, 14);
        });
        break;
      }
      case 'rule':
        push('', 10, false, 0, 10, true);
        break;
      case 'spacer':
        push('', 10, false, 0, 10);
        break;
    }
  }
  return lines;
}

const TOP = PAGE_HEIGHT - MARGIN;
const BOTTOM = MARGIN + 24;

/** Break laid-out lines into pages, keeping each page's drawing commands. */
function paginate(lines: readonly Line[]): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  let y = TOP;

  const newPage = () => {
    if (current.length > 0) pages.push(current);
    current = [];
    y = TOP;
  };

  for (const line of lines) {
    // A zero-leading line shares the baseline with the next one (label/value).
    if (y - line.leading < BOTTOM && line.leading > 0) newPage();
    if (line.rule) {
      current.push(
        `0.75 w 0.6 0.6 0.6 RG ${MARGIN} ${(y - 4).toFixed(2)} m ` +
          `${(PAGE_WIDTH - MARGIN).toFixed(2)} ${(y - 4).toFixed(2)} l S 0 0 0 RG`,
      );
    } else if (line.text) {
      const font = line.bold ? '/F2' : '/F1';
      current.push(
        `BT ${font} ${line.size} Tf ${(MARGIN + line.indent).toFixed(2)} ` +
          `${y.toFixed(2)} Td (${escapeString(toWinAnsi(line.text))}) Tj ET`,
      );
    }
    y -= line.leading;
  }
  if (current.length > 0) pages.push(current);
  return pages.length > 0 ? pages : [[]];
}

/** Render the document model to PDF bytes. Deterministic for a given model. */
export function renderPdf(doc: PdfDocument): Buffer {
  const pages = paginate(layout(doc.blocks));
  const total = pages.length;

  // Object ids: 1 catalog, 2 pages, 3 font F1, 4 font F2, then page/content pairs.
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '', // placeholder, filled once the page ids are known
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  const pageIds: number[] = [];
  pages.forEach((commands, index) => {
    const header = `BT /F1 8 Tf ${MARGIN} ${PAGE_HEIGHT - MARGIN + 18} Td ` +
      `(${escapeString(toWinAnsi(doc.title))}) Tj ET`;
    const footerText = `${doc.footer ? `${doc.footer}  ` : ''}Page ${index + 1} of ${total}`;
    const footer = `BT /F1 8 Tf ${MARGIN} ${MARGIN - 12} Td ` +
      `(${escapeString(toWinAnsi(footerText))}) Tj ET`;
    const stream = [header, ...commands, footer].join('\n');

    const contentId = objects.length + 2; // this page takes the next id, content the one after
    const pageId = objects.length + 1;
    pageIds.push(pageId);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
  });

  objects[1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${total} >>`;

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let position = 0;
  const write = (text: string) => {
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    position += buf.length;
  };

  write('%PDF-1.4\n');
  objects.forEach((body, index) => {
    offsets[index] = position;
    write(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefStart = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  write(xref);
  write(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.concat(chunks);
}
