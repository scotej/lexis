# Word bank export implementation plan

**Goal:** Full printable PDF export with shared standard and semantic ordering.

**Architecture:** Keep bank ordering pure, add a bounded embeddings client and
local semantic path, build PDF bytes with a bundled generator/font, and connect
both through a small bank toolbar/dialog module and platform save adapters.

**Tech stack:** Native JavaScript modules, jsPDF, Node tests, Tauri/Rust.

**Spec:** ../specs/2026-09-11-bank-export-design.md

## Tasks

- [x] Add meaningful failing tests for semantic adjacency, exact coverage across
  batches, invalid vectors, privacy, cancellation, and nonmutation. Implement
  `aiEmbedWords(settings, inputs, { signal })` in core/ai.js and
  `relatedWords(words, settings, { signal, onProgress })` in core/related.js.
- [x] Test and extend core/bank.js standard sorting with last-reviewed and length
  orders. Publish one option catalogue for bank and export UI.
- [x] Test complete text export (including IPA, long entries, metadata and
  multi-page banks). Implement core/pdf.js with injectable jsPDF/font bytes;
  bundle licensed assets in src/vendor and src/fonts for offline use.
- [x] Add bank-tools.js with the export dialog and cancellable AI ordering;
  wire main.js/index.html/styles.css, and platform PDF saving. Test real DOM
  interactions including single/empty banks, errors and stale requests.
- [x] Document usage and data sent to OpenRouter in README. Parse and visually
  inspect an actual PDF, run all JS tests and available Rust checks, review the
  full diff against every spec requirement, and fix any findings.

## Verification commands

`node --test test/related.test.js test/pdf.test.js test/bank-tools.test.js`

`npm test`

`cargo check --manifest-path src-tauri/Cargo.toml`

Browser smoke: seed a representative bank, export a PDF, switch standard/AI
orders using intercepted embeddings, verify all entry text and a readable
multi-page document, then exercise failure and cancellation.

## Verification results — 2026-09-11

- Clean locked dependency installation succeeded; `npm test` passed all 24 test
  files, including the full PDF, ordering, UI, and existing application suites.
- `cargo check --manifest-path src-tauri/Cargo.toml` passed on Linux.
- `cargo test --lib --manifest-path src-tauri/Cargo.toml --offline -j 2` passed
  all 18 Rust unit tests, with debug symbols and incremental compilation disabled
  to fit the temporary build quota. These are all Rust tests in this repository.
  The unrestricted target selection also tried building static library artifacts
  and exhausted the temporary disk quota; the library test target completed.
- Chromium smoke exercised the full app with synthetic desktop storage: all five
  fixture words exported, alphabetical order rendered correctly, AI-related words
  became adjacent, and export reused the cached AI order (one embeddings request).
  The real web adapter downloaded a valid PDF. No browser page errors occurred.
- Parsed both the standard and AI-order browser PDFs: all fixture words and
  sources were present across three pages. Visually inspected the export dialog
  and rendered PDF: white paper, dark text, restrained blue headings, readable
  pagination, and no clipping.
- Regression coverage includes all senses/examples and stored metadata, IPA and
  CJK, long entries and URLs, explicit notation for unsupported code points,
  asset-load retry and first export offline after preload, invalid AI vectors,
  cross-batch adjacency/coverage, cancellation, stale responses and cache changes.
- Independent review findings were fixed: CI dependency installation, Unicode
  fallback, and preloading for offline exports. Follow-up review found no further
  important issues.
- OpenRouter responses were simulated for automated and browser verification;
  no live request was billed to a user's key. Native save-dialog interaction was
  compile-checked; the browser smoke exercised its IPC boundary with a test host.

Generated inspection artifacts were kept outside the repository:
`/tmp/lexis-bank-sample.pdf`, `/tmp/lexis-browser-download.pdf`,
`/tmp/lexis-export-dialog.png`, and `/tmp/lexis-pdf-page-1.png`.
