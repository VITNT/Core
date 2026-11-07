# Third-party assets

- `server-assets/fonts/NotoSansKhmer-Regular.ttf` comes from [Noto Fonts](https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSansKhmer), under the SIL Open Font License 1.1. The license is included beside the font.
- Host Grotesk browser font files are copied from VERT at revision `257bcb3b2bb6a501bae0faf9ffb05060ee00c3f7`. The SIL Open Font License is included in `src/lib/vert/fonts/OFL.txt`.
- Radio Canada Big headings and Noto Sans Khmer browser fonts use the corresponding Fontsource packages; their font licenses are included in the npm packages.
- OCR models are the official `khm` and `eng` files from [tessdata_best](https://github.com/tesseract-ocr/tessdata_best) and [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast), under Apache 2.0. They are downloaded during setup and are not tracked in the repository.
- The OCR runtime is [Tesseract.js](https://github.com/naptha/tesseract.js) / [Tesseract.js-core](https://github.com/naptha/tesseract.js-core), under Apache 2.0. Generated runtime assets are copied from the installed npm packages.
- PDF rendering uses [PDF.js](https://github.com/mozilla/pdf.js), under Apache 2.0. Its bundled font and codec licenses are copied alongside those assets.
- Icons use [Lucide](https://lucide.dev), under the ISC license.

The app incorporates and adapts VERT UI code, theme styles, and assets under AGPL-3.0. See `NOTICE` for the exact revision and modifications, and `LICENSE` for the full license. The app's Source code link provides its corresponding source archive.
