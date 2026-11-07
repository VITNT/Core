// Local-only stress test. No book, images or OCR text is sent to a service.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createWorker, OEM, PSM } from 'tesseract.js';
import { imageDimensions, prepareOcrImage } from '../src/lib/ocr-image.ts';
import { recognizePreparedPage } from '../src/lib/ocr-read.ts';
import { needsSecondPass, preferReading } from '../src/lib/ocr-quality.ts';
import { formatOcrParagraphs } from '../src/lib/ocr-paragraphs.ts';
import { cleanOcrText } from '../src/lib/ocr-text.ts';
import { processImageBatch } from '../src/lib/ocr-batch.ts';
import { defaultOptions } from '../src/lib/types.ts';

const require = createRequire(import.meta.url);
const { createCanvas, loadImage } = require('@napi-rs/canvas'); // PDF.js's native canvas dependency.
const file = process.argv[2];
if (!file) throw new Error('Usage: npm run benchmark:book -- /path/to/book.pdf [output-directory] [comma-separated-pages]');
const root = resolve(import.meta.dirname, '..');
const output = resolve(process.argv[3] ?? join(tmpdir(), 'khmer-book-results'));
const selected = process.argv[4] ? new Set(process.argv[4].split(',').map(Number)) : undefined;
const reference = JSON.parse(await readFile(join(root, 'tests/fixtures/khmer-book-reference.json'), 'utf8'));
const bytes = await readFile(file);
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (sha256 !== reference.sha256) throw new Error('This reference transcript belongs to a different PDF. Use the original stress-test file.');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'khmer-book-images-'));
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
const pdf = await task.promise;
let worker;
const results = [], comparisons = [];
const options = { ...defaultOptions };
const factory = () => createCanvas(1, 1);
const checkAbort = () => {};
const normalize = (text) => text.normalize('NFC').replace(/[.·…]{3,}/gu, '').replace(/[\s\u200b\u00ad]/gu, '');
function score(expected, actual) {
  const a = [...normalize(expected)], b = [...normalize(actual)];
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1])));
    row = next;
  }
  return { characters: a.length, errors: row[b.length], accuracy: Math.max(0, 1 - row[b.length] / a.length) * 100 };
}
function excerpt(data, sample, height) {
  if (sample.top === undefined) return data.text;
  return (data.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines))
    .filter((line) => (line.bbox.y0 + line.bbox.y1) / 2 >= sample.top * height && (line.bbox.y0 + line.bbox.y1) / 2 <= sample.bottom * height)
    .map((line) => line.text).join('\n');
}
try {
  await processImageBatch({ count: pdf.numPages, signal: new AbortController().signal,
    store: {
      async put(number, image) { await writeFile(join(temporary, `${number}.png`), Buffer.from(await image.blob.arrayBuffer())); },
      async get(number) { return { blob: new Blob([await readFile(join(temporary, `${number}.png`))]), dpi: 300 }; },
      async remove(number) { await rm(join(temporary, `${number}.png`)); },
      async dispose() { await rm(temporary, { recursive: true, force: true }); },
    },
    async render(number) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 300 / 72 });
      const size = imageDimensions(base.width, base.height);
      const viewport = page.getViewport({ scale: 300 / 72 * Math.min(size.width / base.width, size.height / base.height) });
      const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
      try {
        await page.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise;
        console.log(`Prepared image ${number}/${pdf.numPages}`);
        return { blob: new Blob([canvas.toBuffer('image/png')], { type: 'image/png' }), dpi: 300 };
      } finally { canvas.width = canvas.height = 1; page.cleanup(); }
    },
    async recognize(image, number) {
      if (selected && !selected.has(number)) return;
      if (!worker) worker = await createWorker(options.language, OEM.LSTM_ONLY, {
        workerPath: join(root, 'scripts/ocr-benchmark-worker.cjs'), langPath: join(root, 'static/ocr/best'), cacheMethod: 'none', errorHandler: () => {},
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1', user_defined_dpi: '300' });
      const bitmap = await loadImage(Buffer.from(await image.blob.arrayBuffer()));
      const source = createCanvas(bitmap.width, bitmap.height); source.getContext('2d').drawImage(bitmap, 0, 0);
      const canvas = prepareOcrImage(source, options.enhance, factory);
      const parameters = { rotateAuto: false, user_defined_dpi: '300', thresholding_method: '0' };
      const sample = reference.samples.find((sample) => sample.page === number);
      let baseline;
      if (sample) {
        let { data } = await worker.recognize(canvas.toBuffer('image/png'), parameters, { text: true, blocks: true });
        if (needsSecondPass(data)) {
          const alternative = await worker.recognize(canvas.toBuffer('image/png'), { ...parameters, thresholding_method: '2', tessedit_pageseg_mode: (data.blocks?.length ?? 0) <= 1 ? PSM.SINGLE_BLOCK : PSM.AUTO }, { text: true, blocks: true });
          data = preferReading(data, alternative.data);
        }
        baseline = excerpt(data, sample, canvas.height);
      }
      const started = performance.now();
      const adapter = { ...worker, recognize: (image, parameters, output) => worker.recognize(image.toBuffer('image/png'), parameters, output) };
      const data = await recognizePreparedPage(adapter, canvas, options, parameters, { checkAbort, createCanvas: factory });
      const text = formatOcrParagraphs(data, cleanOcrText(data.text));
      const result = { page: number, confidence: data.confidence, characters: [...text].length, seconds: (performance.now() - started) / 1000, text };
      results.push(result);
      await writeFile(join(output, `page-${String(number).padStart(2, '0')}.txt`), text);
      if (sample) {
        const actual = excerpt(data, sample, canvas.height);
        comparisons.push({ page: number, before: score(sample.text, baseline), after: score(sample.text, actual), expected: sample.text, beforeText: baseline, afterText: actual });
      }
      console.log(`Read page ${number}/${pdf.numPages}: ${result.characters} characters, confidence ${result.confidence.toFixed(1)}, ${result.seconds.toFixed(1)}s`);
      await writeFile(join(output, 'progress.json'), JSON.stringify({ sha256, pages: pdf.numPages, processed: results.length, results, comparisons }, null, 2));
      source.width = source.height = canvas.width = canvas.height = 1;
    },
  });
  const totals = comparisons.reduce((total, sample) => ({ characters: total.characters + sample.after.characters, beforeErrors: total.beforeErrors + sample.before.errors, afterErrors: total.afterErrors + sample.after.errors }), { characters: 0, beforeErrors: 0, afterErrors: 0 });
  const report = { sha256, pages: pdf.numPages, processed: results.length, measuredPages: comparisons.map((sample) => sample.page),
    limitation: 'Character accuracy is measured on the fixed manually transcribed samples only. A full-book 90% accuracy claim requires a complete independently verified transcript.',
    ...totals, beforeAccuracy: totals.characters ? 100 * Math.max(0, 1 - totals.beforeErrors / totals.characters) : null,
    afterAccuracy: totals.characters ? 100 * Math.max(0, 1 - totals.afterErrors / totals.characters) : null, comparisons,
  };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(output, 'extracted.txt'), results.map((page) => page.text).join('\n\n'));
  console.log(JSON.stringify(report, null, 2));
} finally { await worker?.terminate(); await task.destroy(); await rm(temporary, { recursive: true, force: true }); }
