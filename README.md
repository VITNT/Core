# Core

Core is a focused SvelteKit app for converting Khmer PDFs, documents, and images into editable Unicode text. The UI directly adapts VERT's panels, uploader, navigation layout, theme tokens, Host Grotesk body font, and Radio Canada Big heading font. It starts directly at the tool.

## About and search metadata

The About tab in the OCR workspace describes Core’s supported files, Khmer and English OCR, conversion steps, privacy, and limitations. Switching tabs preserves queued files and results. `/#about` opens this view directly, and the former `/about` route redirects there. About content is included in the server-rendered main page, which has a title, description, canonical URL, social-sharing metadata, and structured data. `/sitemap.xml` lists the main page; `/robots.txt` advertises it. Set `APP_ORIGIN` to the public HTTPS origin when building so these URLs use the production domain.

## Run

Requires Node.js 22.17+ (Node 24 recommended).

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. Installation downloads the official Khmer and English Tesseract `best` and `fast` models and copies the OCR/PDF runtime into `static/`. After installation, conversion does not depend on external CDNs or OCR services. Model downloads require internet during setup. The generated assets are ignored by Git; `npm run assets` restores them.

For DOC, DOCX, ODT, and RTF, install LibreOffice on the app server. PDF/image OCR works without it.

```sh
# macOS
brew install --cask libreoffice
# Debian / Ubuntu
sudo apt-get install libreoffice-writer fonts-khmeros fonts-noto-core
```

The app discovers `soffice` in PATH and standard macOS/Linux install locations. Set `SOFFICE_PATH` in `.env` if needed. A bundled Noto Sans Khmer font and per-conversion font configuration cover Unicode Khmer, including headless builds that miss system fonts. Install the original document's fonts on the server for faithful Office rendering. Missing fonts or legacy Khmer font encodings can affect the rendered result.

## Conversion

Paste a copied image or screenshot with **Ctrl+V** (Windows/Linux) or **⌘V** (macOS) while on Upload or Extract. It joins the same queue as dropped files, with the same format, size, and queue limits. Pasting inside the text editor continues to edit text.

- **PDF → complete PNG image batch → OCR.** PDF.js renders every page at 300 DPI by default and stores the lossless PNGs in a temporary browser IndexedDB batch. Only after the entire batch is ready does Tesseract.js read the images, in page order, using Khmer + English and the `tessdata_best` LSTM models. Images are decoded one at a time and deleted after reading; the batch database is removed on completion, failure, or cancellation. The app deliberately does not trust PDF text extraction for Khmer.
- **DOC / DOCX / ODT / RTF → PDF → page images → OCR.** A SvelteKit endpoint uses headless LibreOffice with a fresh temporary profile and directory per conversion. The PDF goes back to the browser for rendering and OCR. Temporary server files are removed when conversion finishes or fails.
- **PNG / JPEG / WebP / BMP → prepared image → OCR.** Images are decoded locally and composited on white. Scan enhancement is enabled by default: small images are enlarged up to 2×, faint scans receive percentile-based grayscale normalization, dark backgrounds are inverted, and clearly detected skew up to 5 degrees is straightened. A small white margin keeps tightly cropped characters away from the image edge. The original image is retained for the page preview.

OCR output joins visual line wraps inside each detected paragraph and separates paragraphs with a blank line. Paragraph boundaries come from Tesseract’s structured layout; when layout text cannot be matched safely, existing blank-line paragraph breaks are used instead. Copy and downloads use the same paragraph formatting.

Each file keeps page previews, editable text, and OCR confidence. Copy/download uses your edits. Downloads contain UTF-8 text with a BOM for compatibility. Files and results stay in memory; refreshing clears the workspace. PDF page-image batches temporarily use browser storage during conversion; an abruptly closed/crashed tab can leave a batch until browser site data is cleared. OCR language data may be cached in browser IndexedDB, separately for each model quality.

OCR output receives conservative symbol cleanup for isolated artifacts such as `#10#$`. Ordinary punctuation, numbers, prices, and Khmer marks are preserved. Changed pages offer **Restore original OCR** for reviewing any cleanup against the page preview; your subsequent edits are kept as entered.

Khmer modes also check uncertain isolated Latin words in Khmer lines, such as a Khmer word misread as “Hein”. Up to 12 candidate words per page are re-read from enlarged source-image crops using the selected language model. A candidate is replaced only when the second read produces a substantially stronger Khmer result; unresolved candidates are listed for review. Confident English words and English phrases are retained. This is a recognition heuristic, not a guarantee of transcription accuracy.

Accurate mode normalizes oversized glyphs for its initial layout reading before removing any layout marks. Repeated list gutters are detected from the pixels; labels are read without a character whitelist, and only confidently recognized numbers are isolated from the body and attached to their matching question. Unrecognized gutters remain in the source reading. Tiny duplicate fragments fully covered by a Khmer word are suppressed conservatively. It then tries long repeated dotted-leader and thin intersecting table-rule removal on a separate image, retaining the first reading unless the alternative improves confidence and preserves text coverage. Word rechecks use the image before layout removal. It routinely recognizes text regions separately, keeping headings, body rows, and footers apart; detected side-by-side columns use independent block regions in engine reading order. Each region is resized from its measured full glyph height toward 48 pixels for Khmer or 32 pixels for English, with bounded scaling and white padding. This normalization runs in Accurate mode even when scan enhancement is off. Dense lines are split using an adaptive projection threshold; detached Khmer marks are reattached before recognition. Very uncertain Khmer rows also receive bounded italic-slant retries; a transformed reading must be substantially more confident and retain the text before it can replace the original. Repaired rows are grouped back into paragraphs, with page-coordinate word boxes retained for visual rechecks. Contents entries remain separate. Visible list item starts remain paragraph boundaries even when the whole-page OCR text is retained; wrapped lines continue within their own question. This prevents PDF lists from collapsing into one long paragraph. A repair must cover the detected rows and retain substantial text, Khmer characters, numbers, and confident English passages, including on contents pages. When a whole-page repair is rejected, an improved normalized region or strong slant correction can still replace one unambiguously matching line, subject to text-coverage checks. Word boxes, baselines, symbols, and line heights are mapped back through scaling and slant transforms to the original page for subsequent rechecks. Fast mode retains the single-page path; region recognition adds processing time in Accurate mode.

Accurate Khmer modes also recheck up to six short, low-confidence Khmer lines per page with the official `tessdata_best` Khmer script model. The model loads locally only when needed. A replacement requires agreement at 2× and 2.5× crop sizes, a confidence gain of at least 15 points with a score of at least 50, similar text length, and retained numbers. This targets difficult headings without changing confident text or relying on hardcoded word corrections. The extra model and bounded retries add memory and processing time on affected pages.

If no row repair is accepted and the first reading is empty or below 75 confidence, Accurate mode tries an additional Sauvola-thresholded reading. Confidence is a heuristic, not measured transcription accuracy. Fast mode skips these extra layout/recognition passes.

Controls include accurate/fast models, Khmer/Khmer + English/English, 200/300 DPI PDF rendering, automatic/single-column layout, scan enhancement (on by default), batch queueing, cancellation, retry, page navigation, and light/dark themes.

Limits: 20 queued files, 50 MB per file, 200 pages per PDF, 20 megapixels per rendered page. Oversized images/pages are scaled down. The renderer accepts two concurrent conversions per Node process and has a 60-second conversion timeout. Password-protected PDFs need to be unlocked first.

## Privacy and hosting

PDFs/images are processed in the browser. Office documents are uploaded to **your app server** for rendering; the interface states this explicitly. There are no accounts, analytics, or third-party OCR calls.

Use a Node host/container for full document support; static/serverless hosts cannot launch LibreOffice. The included Dockerfile installs LibreOffice and Khmer fonts and runs the app as an unprivileged user. For an internet-facing document service, put the Office renderer in a separately restricted container with appropriate process/memory limits and outbound network restrictions. File size, extension validation, and temporary profiles are not an operating-system sandbox.

```sh
npm run check
APP_ORIGIN=http://localhost:3000 npm run build
BODY_SIZE_LIMIT=55M npm start
```

Production Node adapter uploads default to a smaller body limit, so set `BODY_SIZE_LIMIT=55M`. Set `APP_ORIGIN` to your public URL **when building** (SvelteKit 3's `paths.origin` is build configuration). The adapter assumes HTTPS when deriving an origin, so direct HTTP production previews also need this setting. Alternatively, configure the trusted reverse proxy headers according to the adapter-node documentation. Set upload limits at the reverse proxy as well.

```sh
docker build --build-arg APP_ORIGIN=http://localhost:3000 -t core .
docker run --rm -p 3000:3000 core
```

## Verification

`npm run check` checks Svelte/TypeScript; `npm run build` verifies the production build. `node --import tsx --test tests/ocr-*.test.ts` runs image-preparation, two-phase image batching, paragraph formatting, table/contents layout repair, conservative fallback, symbol-cleanup, and mixed-script review regression tests. With the dev server running, `npm test` also exercises the actual Office endpoint, including DOCX/RTF rendering and invalid upload handling. Set `TEST_BASE_URL` to test another local port. These are cleanup/rendering/smoke tests, not a Khmer accuracy benchmark.

For the scanned Khmer book stress test, run `npm run benchmark:book -- /path/to/book.pdf /path/to/results`. The script renders the complete PDF image batch before OCR and uses the same image preparation and recognition code as the browser. It measures character error against fixed manually transcribed samples on pages 2, 10, 30, 31 and 57, checking the source SHA-256 to prevent an accidental comparison with another file. It writes each page’s text and a report; a full-book accuracy claim requires a complete independently verified reference transcript. The PDF itself is not included in the repository.

See [OCR approaches](docs/ocr-approaches.md) for alternatives, tradeoffs, and primary sources.

## UI source and license

UI code is adapted from [VERT-sh/VERT](https://github.com/VERT-sh/VERT), revision `257bcb3b2bb6a501bae0faf9ffb05060ee00c3f7`. The application is distributed under AGPL-3.0; see `LICENSE`, `NOTICE`, and `THIRD_PARTY.md`. Fonts retain their respective SIL Open Font Licenses.

`npm run source` packages the corresponding source at `static/source.tar.gz`, linked in the UI. It runs automatically before development and production builds. The archive contains application sources, build scripts, dependency lockfile, fonts, tests, documentation, and license notices. It excludes environment secrets, user uploads, generated OCR models, and `node_modules`; setup scripts restore generated dependencies.
