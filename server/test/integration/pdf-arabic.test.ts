import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import {
  buildClinicalDocumentHtml,
  renderClinicalDocumentPdf,
  type ClinicalDocument,
} from '../../src/modules/platform/pdf/document.js';
import { resolveExecutablePath, closePdfEngine } from '../../src/modules/platform/pdf/chromium.js';

/**
 * Platform Phase 3 — Arabic/RTL PDF. Proves Arabic renders as real glyphs (ink)
 * rather than `?`/tofu, that the pipeline preserves Arabic Unicode, and that a
 * valid (multi-page) PDF is produced. Verification is entirely in-browser
 * (canvas ink measurement) — no external tools needed. NOTE: pixel-perfect
 * glyph-shape/ligature correctness still needs the human sign-off recorded in
 * docs/platform/PDF-ARABIC.md; these tests prove non-regression of the `????`
 * defect and the render pipeline.
 */
let browser: Browser;

// Portability: if no Chromium can be resolved (e.g. a runner without a browser),
// SKIP rather than fail — the PDF path is an optional platform capability. CI
// provisions Chromium so the regression is gated there; see MEDCORE-BOX.md.
const CHROMIUM = resolveExecutablePath();
const suite = CHROMIUM ? describe : describe.skip;

beforeAll(async () => {
  if (!CHROMIUM) return;
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
});

afterAll(async () => {
  if (browser) await browser.close();
  await closePdfEngine();
});

interface Inspection {
  innerText: string;
  pdf: Buffer;
  pageCount: number;
  arabicInk: number;
  fontOk: boolean;
}

async function renderAndInspect(html: string, arabicProbe: string): Promise<Inspection> {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const dom = await page.evaluate(async (probe: string) => {
      const d: any = (globalThis as any).document;
      await d.fonts.ready;
      const fontOk = probe ? d.fonts.check('16px Amiri', probe) : true;
      const innerText: string = d.body.innerText;
      let ink = 0;
      if (probe) {
        const c: any = d.createElement('canvas');
        c.width = 800;
        c.height = 100;
        const ctx = c.getContext('2d');
        ctx.font = '40px Amiri';
        ctx.direction = 'rtl';
        ctx.fillText(probe, 780, 60);
        const data = ctx.getImageData(0, 0, 800, 100).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) ink++;
      }
      return { fontOk, innerText, ink };
    }, arabicProbe);
    const pdf = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }));
    const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    return { innerText: dom.innerText, pdf, pageCount, arabicInk: dom.ink, fontOk: dom.fontOk };
  } finally {
    await page.close();
  }
}

function isValidPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === '%PDF-' && buf.length > 2000;
}

suite('Arabic / RTL PDF (Platform Phase 3)', () => {
  it('renders Arabic-only text as real glyphs (no ???? / tofu)', async () => {
    const arabic = 'اسم المريض أحمد هاني والتشخيص حب الشباب';
    const html = buildClinicalDocumentHtml({ title: 'تقرير طبي', body: arabic });
    const r = await renderAndInspect(html, arabic);
    expect(isValidPdf(r.pdf)).toBe(true);
    expect(r.fontOk).toBe(true);
    expect(r.arabicInk).toBeGreaterThan(500); // glyphs actually drew ink
    expect(r.innerText).toContain('أحمد هاني'); // Unicode preserved
    expect(r.innerText).not.toContain('?'); // the defect is gone
  });

  it('renders English-only text (regression: Latin still works)', async () => {
    const html = buildClinicalDocumentHtml({
      direction: 'ltr',
      lang: 'en',
      title: 'Medical Report',
      fields: [{ label: 'Patient', value: 'Ahmed Hani' }],
    });
    const r = await renderAndInspect(html, '');
    expect(isValidPdf(r.pdf)).toBe(true);
    expect(r.innerText).toContain('Ahmed Hani');
  });

  it('renders a mixed Arabic + English clinical document with a table', async () => {
    const doc: ClinicalDocument = {
      title: 'التقرير الطبي — MEDCORE',
      subtitle: 'عيادة الجلدية',
      fields: [
        { label: 'اسم المريض', value: 'Ahmed Hani' }, // Latin name inside RTL
        { label: 'التشخيص', value: 'Acne Vulgaris — حب الشباب' }, // mixed
        { label: 'التاريخ', value: '2026-09-16' }, // numbers/date
      ],
      table: {
        caption: 'الأدوية الموصوفة',
        headers: ['الدواء', 'الجرعة', 'المدة'],
        rows: [
          ['Isotretinoin 20mg', 'مرة يومياً', '3 أشهر'],
          ['Benzoyl Peroxide 5%', 'مرتين يومياً', 'شهر'],
        ],
      },
      footer: 'MEDCORE — نظام إدارة العيادات',
    };
    const r = await renderAndInspect(buildClinicalDocumentHtml(doc), 'حب الشباب');
    expect(isValidPdf(r.pdf)).toBe(true);
    expect(r.arabicInk).toBeGreaterThan(500);
    expect(r.innerText).toContain('Ahmed Hani'); // LTR segment inside RTL
    expect(r.innerText).toContain('Isotretinoin'); // Latin drug name
    expect(r.innerText).toContain('حب الشباب'); // Arabic diagnosis
    expect(r.innerText).not.toContain('?');
  });

  it('produces a multi-page PDF for long content', async () => {
    const longArabic = Array.from({ length: 120 }, (_, i) => `سطر رقم ${i + 1}: ملاحظة سريرية طويلة عن حالة المريض.`).join('\n');
    const html = buildClinicalDocumentHtml({ title: 'ملاحظات', body: longArabic });
    const r = await renderAndInspect(html, 'ملاحظة');
    expect(isValidPdf(r.pdf)).toBe(true);
    expect(r.pageCount).toBeGreaterThanOrEqual(2);
  });

  it('handles empty fields without producing "?"', async () => {
    const html = buildClinicalDocumentHtml({
      title: 'تقرير',
      fields: [{ label: 'ملاحظات', value: '' }],
    });
    const r = await renderAndInspect(html, '');
    expect(isValidPdf(r.pdf)).toBe(true);
    expect(r.innerText).not.toContain('?');
  });

  it('escapes HTML in values (no template injection / PHI-driven markup)', () => {
    const html = buildClinicalDocumentHtml({
      title: 'T',
      fields: [{ label: 'x', value: '<script>alert(1)</script>' }],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders deterministically: same input → same content twice (Task 5)', async () => {
    const doc: ClinicalDocument = {
      title: 'تقرير طبي',
      fields: [
        { label: 'اسم المريض', value: 'Ahmed Hani' },
        { label: 'التشخيص', value: 'حب الشباب' },
      ],
      body: 'ملاحظة سريرية للاختبار الحتمي.',
    };
    const html = buildClinicalDocumentHtml(doc);
    const a = await renderAndInspect(html, 'حب الشباب');
    const b = await renderAndInspect(html, 'حب الشباب');
    // Content is identical across renders (both bundled fonts → cross-run stable).
    // (PDF bytes carry a per-render /ID + timestamp, so byte-equality is not
    // asserted; content-level determinism is what matters for a report.)
    expect(a.innerText).toBe(b.innerText);
    expect(a.arabicInk).toBe(b.arabicInk);
    expect(a.innerText).toContain('Ahmed Hani'); // Latin via bundled DejaVu
    expect(a.innerText).toContain('حب الشباب'); // Arabic via bundled Amiri
  });

  it('the platform entry point renderClinicalDocumentPdf works end-to-end', async () => {
    const pdf = await renderClinicalDocumentPdf({
      title: 'تقرير طبي',
      fields: [{ label: 'اسم المريض', value: 'Ahmed Hani' }],
    });
    expect(isValidPdf(pdf)).toBe(true);
  });
});
