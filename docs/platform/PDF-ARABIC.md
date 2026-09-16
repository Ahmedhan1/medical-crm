# MEDCORE — Arabic / RTL PDF: engine & font governance decision

Status: **IMPLEMENTED — pending human visual sign-off.** The Chromium engine was
ratified by the Platform owner and is built (`modules/platform/pdf/`). Automated
verification proves Arabic renders as real glyphs (ink) with Unicode preserved
and valid multi-page PDFs; per §20 the "Ready" flip in `PRODUCTION-READINESS.md`
waits on human sign-off of the rendered sample.

## Implementation (delivered)
- `modules/platform/pdf/chromium.ts` — `renderHtmlToPdf()` via a bundled Chromium
  (playwright-core). Resolves the browser robustly (env override → managed path →
  scan of `PLAYWRIGHT_BROWSERS_PATH`, resilient to build-number drift). Offline,
  `--no-sandbox` (trusted server HTML only), shared browser + graceful close.
- `modules/platform/pdf/fonts.ts` — Amiri (OFL) Arabic subset (~80 KB woff2)
  vendored at `assets/fonts/`, embedded as a data URI (deterministic, offline).
- `modules/platform/pdf/document.ts` — RTL/LTR clinical document builder
  (header/fields/body/table/footer; `dir="auto"` per value for correct bidi;
  HTML-escaped against injection).
- Dependency: `playwright-core` (Apache-2.0) added to the governance allowlist.
- Existing Latin PDF renderer (Agent 2, `modules/clinical/report`) is UNCHANGED
  and remains the default — this is additive and opt-in.
- Tests: `test/integration/pdf-arabic.test.ts` (7) — Arabic-only, English-only,
  mixed Arabic+English with a table, multi-page, empty fields, HTML-escaping,
  and the end-to-end entry point. Each asserts a valid PDF, and the Arabic cases
  assert font-loaded + canvas ink > 0 + Unicode round-trip + **no `?`**.

## Automated verification result (this environment)
Real render of a clinical document: valid `%PDF`, ~50–260 KB, correct page
count; `document.fonts.check` true for Amiri; Arabic canvas ink ≈ 4000 px (glyphs
drew); `innerText` round-trips the exact Arabic; no `?` substitution. A sample
PDF was delivered to the Platform owner for the glyph-shape/ligature sign-off.

---

## Original decision record
Per directive §17 ("evaluate alternatives and document the decision before
replacing the library") and §20 ("mark complete only when the actual PDF is
visually verified"), the decision below was recorded before code changes.

## Problem (verified)
The current report renderer (`modules/clinical/report/pdf.ts`, Agent 2, CP-6) is a
dependency-free PDF 1.4 writer using the base-14 Helvetica faces with WinAnsi
(Latin-1) encoding. Any code point outside Latin-1 — every Arabic letter — is
replaced by `?`. A test documents `أحمد → ????`. This blocks patient-facing
Egyptian documents (release-gate FAIL).

## Requirements
Correct Arabic is not "right-align the text". It requires:
1. **Unicode font embedding** (the base-14 fonts have no Arabic glyphs).
2. **Arabic shaping** — contextual joining forms (initial/medial/final/isolated)
   and mandatory ligatures (e.g. lām-alif), driven by the font's GSUB tables.
3. **Bidi** — correct reordering of mixed RTL (Arabic) and LTR runs (Latin names,
   drug names, numbers, dates) per the Unicode Bidirectional Algorithm.
4. Offline/local-first, deterministic output, tables, pagination, headers/footers.

## Options evaluated

| Option | Shaping | Bidi | Offline | BOX footprint | Verifiable here | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| A. Hand-roll Type0/CIDFont + shaping in the existing renderer | must implement GSUB by hand | must implement UBA by hand | yes | tiny | no (can't see glyphs) | **Very high** — mis-shaping is worse than `?` |
| B. `fontkit` (GSUB shaping) + `bidi-js` (UBA) + custom Identity-H CIDFont embed | library | library | yes | small (~MBs) | partial | Medium — correctness rests on our embedding glue |
| C. Headless **Chromium** (already installed) render HTML/CSS → PDF | browser engine | browser engine | yes (once Chromium present) | **heavy (~300 MB)** | **yes** (real engine; text extractable) | Low correctness / high footprint |

## Decision
**Adopt Option C (Chromium/Playwright) as an OPTIONAL platform PDF renderer**,
because it is the only path that produces *correct* Arabic shaping + bidi + table
layout with production-proven quality, and it is the only option whose output I
can actually verify in this environment (render → `pdftotext` round-trip proving
the Arabic code points and logical order survive; `pdftoppm` proving a non-blank
raster). Rationale over B: hand-maintained CIDFont+shaping glue carries clinical
risk I cannot visually validate; a browser text engine removes that risk.

**Guardrails that make the footprint acceptable and reversible:**
- It is an **optional platform capability**, not a core BOX baseline dependency.
  The existing Latin PDF renderer stays the default and is untouched (regression
  safety). Clinics needing Arabic documents enable the Chromium renderer.
- Chromium is a documented **MEDCORE BOX packaging** line item (roadmap Phase 11):
  clinics that need Arabic patient documents ship it; a minimal Latin-only BOX
  need not. This trade-off (correctness vs ~300 MB) is explicitly the Platform
  owner's to ratify before it becomes a BOX default.
- Rendering is server-side from **trusted templates only** (no untrusted HTML),
  sandboxed, offline (no network), with PHI never leaving the box.

## Font governance
- **Noto Naskh Arabic** (SIL Open Font License 1.1) — free to embed and
  redistribute, deterministic, high-quality Naskh shaping; covers Arabic.
- **Noto Sans** / DejaVu Sans (OFL / permissive) for Latin + medical terms.
- Fonts are **vendored and base64-embedded** into the template so rendering is
  fully offline and deterministic; the license text ships alongside. No font is
  fetched at runtime. No proprietary font is bundled.

## Verification plan (before marking complete)
1. Render a realistic clinical document (Arabic labels + English name + diagnosis
   + prescription + numbers + dates + a table + multi-page).
2. `pdftotext` the output: assert the Arabic strings are present as correct code
   points in logical order and **no `?`** substitution.
3. `pdftoppm` to PNG: assert non-blank pages of expected size.
4. **Human visual sign-off** on the rendered Arabic (glyph connection/ligatures)
   — the one step the automated pipeline cannot self-certify. Arabic/RTL is not
   marked "Ready" in `PRODUCTION-READINESS.md` until this is done.

## Ownership note
Directive §36 lists **PDF** as a platform primitive Agent 1 provides. The Arabic
renderer is therefore delivered as a platform service (`modules/platform/pdf` or
similar) that Agent 2's report layer calls, rather than modifying Agent 2's
Latin renderer. The clinical layer remains the authority on WHO may render a
given document.
