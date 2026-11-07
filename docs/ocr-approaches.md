# OCR approaches considered

Reviewed October 29, 2026. No representative user documents were provided, so no claim of production Khmer accuracy is made. The sample is useful for checking the pipeline, not measuring general accuracy.

| Approach | Strength | Limitation | Decision |
| --- | --- | --- | --- |
| Extract embedded PDF text / parse document XML | Quick; no OCR errors when Unicode mappings are correct | Broken PDF character maps, legacy Khmer encodings, and scanned pages can produce unusable text | Do not use as the default |
| Render pages + browser Tesseract LSTM | Works from visible glyphs; no API key; files can remain local; explicit Khmer model | CPU intensive; printed fonts and scan quality affect accuracy; complex layouts and handwriting need review | Implemented, using accurate/fast official models |
| LibreOffice + raster OCR | Preserves rendered Office layout before recognition, including document images | Needs a Node server and installed fonts; cannot recover glyphs that LibreOffice itself renders incorrectly | Implemented for DOC/DOCX/ODT/RTF |
| Google Cloud Vision `DOCUMENT_TEXT_DETECTION` | Official Khmer (`km`) support; worth comparing on difficult scans and layouts | Paid external service, credentials, document upload, service dependency; accuracy must be measured | Documented alternative; no hidden cloud fallback |
| Khmer-specific neural recognizer such as Netra-OCR | Model authors report promising Khmer line-recognition results | A separate inference runtime and full-page detection/layout pipeline; author benchmarks are not independent validation; training-data terms need review | Candidate for a later local inference service |
| General vision language model | Can interpret layouts and mixed visual material | May invent or normalize text; Khmer support and transcription accuracy vary; compute/API costs | Not the default for faithful transcription |

## Implemented pipeline

1. Validate the file type, size, and queue limits.
2. For Office files, render to PDF in LibreOffice. Return that PDF to the browser and remove temporary server data.
3. Render each PDF page with PDF.js at 300 DPI, or decode an uploaded image. Cap individual canvases to avoid excessive browser memory.
4. Optionally apply gentle grayscale/contrast adjustment. This is off by default because aggressive thresholding can erase fine Khmer marks.
5. Recognize with Khmer + English `tessdata_best` using the LSTM engine. Reuse the worker across a batch. Fast mode uses `tessdata_fast`, with a separate browser cache.
6. In Khmer modes, request word boxes and confidences. For Khmer lines with at most two Latin tokens, re-read uncertain Latin words (confidence below 80) from enlarged source-image crops, retaining the selected language model. Check at most 12 words per page. Accept a Khmer alternative only at confidence 85 or greater and an improvement of at least 20 points; retain and flag unresolved candidates. These thresholds are conservative heuristics, not calibrated probabilities. English phrases, confident English, and short uppercase acronyms are preserved. Per-crop segmentation settings are restored before the next page.
7. Normalize output to NFC without rearranging Khmer combining marks. Remove isolated symbol/number tokens with three or more noise symbols of at least two different kinds (for example, `#10#$`). Preserve ordinary punctuation, prices, references, formulas, repeated separators, and tokens containing letters or combining marks. Keep the original OCR text on changed pages so it can be restored. This is a conservative heuristic, not recognition of the missing source text.
8. Keep pages separate for review and editing; join the edited text for export. Corrections run once when OCR finishes, so they do not alter subsequent edits.

Accurate mode explicitly detects ordinary WebAssembly SIMD support and selects the compatible SIMD or portable core. This avoids [Tesseract 7's relaxed-SIMD float-model crash](https://github.com/naptha/tesseract.js/issues/1080). Fast integer models can use the runtime's automatic core selection.

This bypasses bad PDF text mappings, but it cannot fix a page whose visible glyphs are already wrong. Image OCR also introduces recognition errors of its own. Tesseract confidence is a review signal, not a measured probability that the Khmer is correct.

## Next accuracy experiment

Build a small consented evaluation corpus of real Khmer PDFs, Office files, old fonts, clean print, and scans. Record corrected ground truth, then compare character error rate and page reading order across `best`, `fast`, Google Vision, and a Khmer-specific model. Test the same rendered images in every engine so rendering and recognition quality are measured separately. Use a held-out set before choosing a replacement default.

## Primary sources

- [Tesseract.js](https://github.com/naptha/tesseract.js): browser/Node WebAssembly OCR and supported API. Tesseract.js recognizes images; PDF rasterization belongs in the application.
- [Official Tesseract language data](https://tesseract-ocr.github.io/tessdoc/Data-Files): Khmer (`khm`) support; `best`/`fast` model differences and LSTM requirements.
- [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html): PDF loading and page rendering.
- [LibreOffice command-line conversion](https://help.libreoffice.org/latest/en-US/text/shared/guide/convertfilters.html): document input filters and PDF export.
- [Google Cloud Vision OCR languages](https://docs.cloud.google.com/vision/docs/languages): Khmer (`km`) is listed among supported languages.
- [Netra-OCR model card](https://huggingface.co/Darayut/khmer-text-recognition): model architecture, author-reported results, line-recognition scope, limitations, and training-data licensing notes. No Netra code or weights are included in this app.
- [An End-to-End Khmer Optical Character Recognition using Sequence-to-Sequence with Attention](https://arxiv.org/abs/2106.10875): published Khmer-specific OCR research; results refer to that paper's dataset and model.
- [VERT](https://github.com/VERT-sh/VERT): upstream UI source. Panels, uploader, navigation layout, theme styles, background vector, and typography are adapted from revision `257bcb3` under AGPL-3.0; see the project NOTICE.
