import { arabicFontFaceCss, DOCUMENT_FONT_STACK } from './fonts.js';
import { renderHtmlToPdf } from './chromium.js';

/**
 * Platform RTL/LTR document builder (Agent 1). Produces a self-contained HTML
 * document (embedded Amiri font, inline CSS) and renders it to PDF via Chromium.
 * Directive §36 lists PDF as a platform primitive; Agent 2's report layer can
 * call this instead of maintaining its own Arabic renderer. It never fetches a
 * remote resource and never emits PHI to logs.
 *
 * Bidi handling: the page is `dir="rtl"` for Arabic-first layout; each field
 * value is `dir="auto"` so a Latin name/drug/number inside Arabic text is
 * ordered correctly by the browser's Unicode Bidi Algorithm.
 */
export interface DocField {
  label: string;
  value: string;
}
export interface DocTable {
  caption?: string;
  headers: string[];
  rows: string[][];
}
export interface ClinicalDocument {
  /** 'rtl' (Arabic-first) or 'ltr'. Default 'rtl'. */
  direction?: 'rtl' | 'ltr';
  lang?: string; // e.g. 'ar' | 'en'
  title: string;
  subtitle?: string;
  fields?: DocField[];
  body?: string;
  table?: DocTable;
  footer?: string;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildClinicalDocumentHtml(doc: ClinicalDocument): string {
  const dir = doc.direction ?? 'rtl';
  const lang = doc.lang ?? (dir === 'rtl' ? 'ar' : 'en');

  const fields = (doc.fields ?? [])
    .map(
      (f) => `<div class="field">
        <div class="label">${esc(f.label)}</div>
        <div class="value" dir="auto">${esc(f.value)}</div>
      </div>`,
    )
    .join('');

  const table = doc.table
    ? `<table>
        ${doc.table.caption ? `<caption dir="auto">${esc(doc.table.caption)}</caption>` : ''}
        <thead><tr>${doc.table.headers.map((h) => `<th dir="auto">${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${doc.table.rows
          .map((r) => `<tr>${r.map((c) => `<td dir="auto">${esc(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody>
      </table>`
    : '';

  return `<!doctype html>
<html dir="${dir}" lang="${esc(lang)}">
<head><meta charset="utf-8">
<style>
${arabicFontFaceCss()}
* { box-sizing: border-box; }
body { font-family: ${DOCUMENT_FONT_STACK}; font-size: 13px; color: #111; line-height: 1.6; }
header { border-bottom: 2px solid #0b5; padding-bottom: 8px; margin-bottom: 16px; }
h1 { font-size: 20px; margin: 0; }
.subtitle { color: #555; font-size: 12px; margin-top: 4px; }
.field { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px dotted #ddd; }
.field .label { min-width: 140px; color: #444; font-weight: 700; }
.field .value { flex: 1; }
.body { margin: 12px 0; white-space: pre-wrap; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
caption { text-align: ${dir === 'rtl' ? 'right' : 'left'}; font-weight: 700; padding-bottom: 6px; }
th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: ${dir === 'rtl' ? 'right' : 'left'}; }
th { background: #f2f7f4; }
footer { margin-top: 24px; border-top: 1px solid #ccc; padding-top: 8px; color: #666; font-size: 11px; }
</style></head>
<body>
<header><h1 dir="auto">${esc(doc.title)}</h1>${
    doc.subtitle ? `<div class="subtitle" dir="auto">${esc(doc.subtitle)}</div>` : ''
  }</header>
${fields ? `<section class="fields">${fields}</section>` : ''}
${doc.body ? `<section class="body" dir="auto">${esc(doc.body)}</section>` : ''}
${table}
${doc.footer ? `<footer dir="auto">${esc(doc.footer)}</footer>` : ''}
</body></html>`;
}

export function renderClinicalDocumentPdf(doc: ClinicalDocument): Promise<Buffer> {
  return renderHtmlToPdf(buildClinicalDocumentHtml(doc));
}
