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

/**
 * `@font-face` blocks with BOTH bundled faces embedded as data URIs, so PDF
 * rendering is deterministic and offline regardless of the host's installed
 * fonts: Amiri (Arabic) + DejaVu Sans (Latin, since the Amiri subset carries no
 * Latin glyphs). Cached after first read.
 */
export function arabicFontFaceCss(): string {
  if (cachedFace) return cachedFace;
  const amiri = readFileSync(join(ASSETS, 'Amiri-Arabic.woff2')).toString('base64');
  const dejavu = readFileSync(join(ASSETS, 'DejaVuSans.ttf')).toString('base64');
  cachedFace = `@font-face{
  font-family:'Amiri';
  font-style:normal;font-weight:400;font-display:block;
  src:url(data:font/woff2;base64,${amiri}) format('woff2');
}
@font-face{
  font-family:'MedcoreLatin';
  font-style:normal;font-weight:400;font-display:block;
  src:url(data:font/ttf;base64,${dejavu}) format('truetype');
}`;
  return cachedFace;
}

/**
 * Document font stack: Arabic resolves to the bundled Amiri, Latin to the
 * bundled DejaVu (MedcoreLatin); the generic `sans-serif` is only a last resort.
 * Both bundled faces make Latin AND Arabic deterministic across boxes.
 */
export const DOCUMENT_FONT_STACK = `'Amiri','MedcoreLatin',sans-serif`;
