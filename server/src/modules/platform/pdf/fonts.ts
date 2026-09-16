import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Vendored fonts for the Arabic/RTL PDF renderer.
 *
 * Amiri (SIL Open Font License 1.1) provides high-quality Naskh Arabic shaping.
 * The file is a Google Fonts / Fontsource Arabic subset (~80 KB, woff2), so the
 * renderer is fully OFFLINE and DETERMINISTIC — no runtime font download, no
 * dependence on whatever fonts happen to be installed on the box. License text
 * ships alongside at `assets/fonts/Amiri-LICENSE.txt`.
 *
 * Latin text falls back to a system sans (DejaVu/Liberation are present on a
 * typical Linux box and in the bundled Chromium); bundling a Latin subset too
 * is a later refinement, tracked in PDF-ARABIC.md.
 */
const here = dirname(fileURLToPath(import.meta.url));
// src/modules/platform/pdf  → up 4 → server/ ; identical depth from dist/, so
// this resolves in both tsx (tests/dev) and the compiled build without a copy step.
const ASSETS = join(here, '..', '..', '..', '..', 'assets', 'fonts');

let cachedFace: string | null = null;

/** An `@font-face` CSS block with the Amiri woff2 embedded as a data URI. */
export function arabicFontFaceCss(): string {
  if (cachedFace) return cachedFace;
  const b64 = readFileSync(join(ASSETS, 'Amiri-Arabic.woff2')).toString('base64');
  cachedFace = `@font-face{
  font-family:'Amiri';
  font-style:normal;
  font-weight:400;
  font-display:block;
  src:url(data:font/woff2;base64,${b64}) format('woff2');
}`;
  return cachedFace;
}

/** The font stack documents put Arabic-capable Amiri first, Latin fallback after. */
export const DOCUMENT_FONT_STACK = `'Amiri','DejaVu Sans','Liberation Sans',sans-serif`;
