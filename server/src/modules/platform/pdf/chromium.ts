import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * Chromium-backed HTML→PDF renderer (platform, Agent 1). This is the engine
 * chosen in `docs/platform/PDF-ARABIC.md`: a full browser text engine gives
 * correct Arabic shaping + bidi + table layout that a from-scratch PDF writer
 * cannot. It is OPTIONAL — the existing Latin PDF renderer stays the default —
 * and OFFLINE (a bundled Chromium, no network; templates are trusted, no remote
 * resource loading).
 *
 * Security: renders only server-built templates (never untrusted HTML), runs
 * sandboxed and offline, and never navigates to a URL. PHI stays on the box.
 */

let browserPromise: Promise<Browser> | null = null;

export function resolveExecutablePath(): string | undefined {
  // 1) explicit override (deployment/BOX packaging can pin it).
  const override = process.env.PDF_CHROMIUM_PATH;
  if (override && existsSync(override)) return override;

  // 2) playwright-core's managed path, IF it actually exists (the bundled
  //    Chromium build number can differ from the library's expected revision).
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* fall through to scan */
  }

  // 3) scan PLAYWRIGHT_BROWSERS_PATH for any installed Chromium — resilient to
  //    a build-number mismatch between playwright-core and the bundled browser.
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    const candidates: string[] = [];
    for (const dir of readdirSync(root)) {
      if (!/^chromium/.test(dir)) continue;
      candidates.push(
        join(root, dir, 'chrome-linux', 'chrome'),
        join(root, dir, 'chrome-linux', 'headless_shell'),
      );
    }
    // Prefer full chrome over headless_shell; newest build dir first.
    candidates.sort((a, b) => (a.includes('headless') ? 1 : 0) - (b.includes('headless') ? 1 : 0));
    const found = candidates.find((c) => existsSync(c));
    if (found) return found;
  }
  return undefined;
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      executablePath: resolveExecutablePath(),
      // --no-sandbox is required to run as root in a container; the input is
      // trusted server-rendered HTML with no remote content, so the sandbox's
      // main threat (hostile web content) does not apply here.
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });
  }
  return browserPromise;
}

export interface RenderPdfOptions {
  /** Print background colors/borders (needed for headers/tables). Default true. */
  printBackground?: boolean;
  /** Page format. Default 'A4'. */
  format?: 'A4' | 'Letter';
  marginMm?: number;
}

/**
 * Render a complete HTML document to a PDF buffer. The HTML must be
 * self-contained (inline CSS + data-URI fonts); no network fetch occurs.
 */
export async function renderHtmlToPdf(html: string, opts: RenderPdfOptions = {}): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    // Ensure embedded fonts are parsed/ready before layout is measured/printed.
    await page.evaluate(async () => {
      // @ts-expect-error DOM types are not in the node tsconfig lib
      await document.fonts.ready;
    });
    const margin = `${opts.marginMm ?? 14}mm`;
    const pdf = await page.pdf({
      format: opts.format ?? 'A4',
      printBackground: opts.printBackground ?? true,
      margin: { top: margin, bottom: margin, left: margin, right: margin },
    });
    return Buffer.from(pdf);
  } finally {
    await context.close();
  }
}

/** Whether a usable Chromium is available (optional capability / readiness). */
export async function pdfEngineAvailable(): Promise<boolean> {
  try {
    const b = await getBrowser();
    return b.isConnected();
  } catch {
    return false;
  }
}

/** Close the shared browser (graceful shutdown / test teardown). */
export async function closePdfEngine(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close().catch(() => {});
  }
}
