# OCR regression fixtures

These fixtures are generated test documents, not user uploads.

- `ocr-small-skew.png`: a low-contrast Khmer/English image, 1000 × 650 pixels, tilted 3 degrees.
- `ocr-batch.pdf`: two raster-only pages containing the clean document and the tilted document. There is no PDF text layer to copy.
- `ocr-expected.txt`: the intended text on each page (line and paragraph spacing may vary in OCR output).

Manual browser check:

1. Upload the PDF with Accurate, Khmer + English, 300 DPI, and Enhance scans enabled.
2. Start extraction. Preparing the image batch precedes reading its two images.
3. Check both pages in order, their original previews, and editable text/download.
4. Check cancellation and retry; incomplete batches must not continue into OCR.
5. Upload the PNG separately to compare the image path with PDF processing.

On this synthetic PNG, the former raw-image pipeline produced 26 character edits against 172 reference characters. The enhanced image produced 1 character edit, with the same official `tessdata_best` models. Both comparisons normalize whitespace before computing Levenshtein distance. Separate clean and dark versions of the same text retained zero character errors. This is a targeted regression check, not a representative Khmer accuracy benchmark or a guarantee for other fonts/scans.
