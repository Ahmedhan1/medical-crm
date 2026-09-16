# MEDCORE BOX — packaging notes (PDF / Chromium audit)

Scoped audit for this batch: what the **optional Arabic/RTL PDF renderer** needs
to ship on a MEDCORE BOX. Full BOX packaging is a later phase (roadmap §11);
this records the Chromium/Playwright + font requirements so the decision is
explicit and reproducible.

## Chromium / Playwright
- **Driver:** `playwright-core` (runtime dep, Apache-2.0). It contains **no
  browser binary** — the Chromium build is provided by the environment. This is
  deliberate: the BOX controls the browser, not npm.
- **Browser resolution** (`modules/platform/pdf/chromium.ts`): `PDF_CHROMIUM_PATH`
  env → playwright-core managed path → scan of `PLAYWRIGHT_BROWSERS_PATH`. This
  tolerates a build-number mismatch between the library and the installed browser.
- **Footprint:** a headless Chromium is ~150–300 MB installed. For a minimal
  Latin-only BOX this is avoidable (the default Latin PDF renderer needs no
  browser). Ship Chromium **only on boxes that need Arabic/RTL documents.**
- **Sandbox:** rendering runs `--no-sandbox` because the input is trusted,
  server-built HTML with **no remote content and no navigation**. Do not point
  the renderer at untrusted/remote HTML.
- **Offline:** no network is used at render time (fonts are embedded as data
  URIs; templates are local). The BOX needs no internet for PDF generation.
- **Version pinning:** pin the Chromium build to one validated against the
  installed `playwright-core`. CI uses `mcr.microsoft.com/playwright:v1.49.1-jammy`
  (Chromium matched to playwright-core 1.49.x) so the PDF regression runs there.

## Fonts (deterministic, offline, licensed)
- **Amiri** (SIL OFL 1.1) — Arabic Naskh; vendored `assets/fonts/Amiri-Arabic.woff2`.
- **DejaVu Sans** (Bitstream Vera / DejaVu license, freely redistributable) —
  Latin; vendored `assets/fonts/DejaVuSans.ttf`.
- Both are embedded as data URIs at render time, so output does **not** depend on
  host-installed fonts → deterministic across boxes. Licenses ship alongside.

## Determinism
- **Content determinism is validated** (test: same input → identical extracted
  text + identical Arabic ink, twice) and guaranteed cross-box by the embedded
  fonts.
- **Byte-level determinism is NOT claimed:** Chromium writes a per-render PDF
  `/ID` and `CreationDate`, so two runs differ in bytes. If byte-identical output
  is ever required (e.g. content-hash archival), normalize/strip those metadata
  fields in a post-process step — deferred, not needed for clinical reports.
- **Human visual sign-off** of Arabic glyph shaping/ligatures remains the one
  check automation cannot self-certify (see `PDF-ARABIC.md`); a sample PDF was
  delivered for that. Arabic/RTL stays "implemented — pending visual sign-off"
  until confirmed.

## Local / cloud boundary
PDF generation is **fully local** (Chromium + fonts on the box, no egress); no
PHI leaves the box. It is an optional local capability, not a cloud dependency.
