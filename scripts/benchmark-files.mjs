// Local accuracy benchmark for the PDFs in test-files/. Nothing leaves this machine.
// Usage: npm run benchmark:files -- [output-directory] [file.pdf:page,file.pdf:page...]
// Pages with a transcript in tests/fixtures/test-files-reference.json are scored.
// Each sample has a "split": "tuning" pages may guide design choices; "heldout"
// pages must not, and are reported separately. "verified": true marks a
// transcript corrected by a person against the page, not just read from OCR.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createWorker, OEM, PSM } from 'tesseract.js';
import { imageDimensions, prepareOcrImage } from '../src/lib/ocr-image.ts';
import { recognizePreparedPage } from '../src/lib/ocr-read.ts';
import { finalizeOcrPage } from '../src/lib/ocr-finalize.ts';
import { normalizeKhmer } from '../src/lib/khmer-normalize.ts';
import { defaultOptions } from '../src/lib/types.ts';
import { parseWordList } from '../src/lib/ocr-dictionary.ts';

const root = resolve(import.meta.dirname, '..');
// BENCHMARK_NO_WORDS=1 measures the plain vote without the Khmer word list.
const wordFile = join(root, 'static/ocr/khm-words.txt');
const words = process.env.BENCHMARK_NO_WORDS ? undefined : parseWordList(await readFile(wordFile, 'utf8').catch(() => {
  throw new Error(`Missing ${wordFile}. Run "npm run assets" first.`);
}));

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');
const output = resolve(process.argv[2] ?? join(tmpdir(), 'khmer-file-results'));
const reference = JSON.parse(await readFile(join(root, 'tests/fixtures/test-files-reference.json'), 'utf8'));
const targets = process.argv[3]
  ? process.argv[3].split(',').map((item) => ({ file: item.split(':')[0], page: Number(item.split(':')[1]) }))
  : reference.samples.map(({ file, page }) => ({ file, page }));
await mkdir(output, { recursive: true });
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
const options = { ...defaultOptions };
const factory = () => createCanvas(1, 1);

const invisible = /[​‌‍­>➢►▶]/gu;
const canonical = (text) => normalizeKhmer(text).replace(invisible, '');
const compact = (text) => [...canonical(text).replace(/\s/gu, '')];
// Line breaks differ by design (wrapped lines are joined), so drop them, but
// keep spaces inside lines: a missing or extra space is a real error.
const spaced = (text) => [...canonical(text).replace(/\s*\n\s*/gu, '').replace(/[^\S\n]+/gu, ' ').trim()];

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1])));
    row = next;
  }
  return row[b.length];
}

// Best match of `needle` anywhere in `haystack` (free start and end).
function locate(needle, haystack) {
  let row = new Array(haystack.length + 1).fill(0);
  for (let i = 1; i <= needle.length; i++) {
    const next = [i];
    for (let j = 1; j <= haystack.length; j++) next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + Number(needle[i - 1] !== haystack[j - 1])));
    row = next;
  }
  let best = Infinity, end = -1;
  for (let j = 0; j < row.length; j++) if (row[j] < best) { best = row[j]; end = j; }
  return { errors: best, end };
}

const numbers = (text) => (canonical(text).match(/[0-9០-៩]+(?:[.,][0-9០-៩]+)*/gu) ?? []);

export function score(expected, actual) {
  const a = compact(expected), b = compact(actual);
  const result = { characters: a.length, errors: distance(a, b), spacedErrors: distance(spaced(expected), spaced(actual)) };
  // A reference line is missing when no part of the output is within 30% of it.
  const lines = expected.split('\n').map(compact).filter((line) => line.length >= 4);
  const ends = [];
  let missing = 0;
  for (const line of lines) {
    const found = locate(line, b);
    if (found.errors > line.length * 0.3) missing++; else ends.push(found.end);
  }
  // Lines found out of order: found lines minus the longest in-order run.
  const tails = [];
  for (const end of ends) {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >> 1; if (tails[mid] < end) low = mid + 1; else high = mid; }
    tails[low] = end;
  }
  const outputNumbers = numbers(actual);
  const missingNumbers = numbers(expected).filter((number) => {
    const index = outputNumbers.indexOf(number);
    if (index < 0) return true;
    outputNumbers.splice(index, 1);
    return false;
  }).length;
  return { ...result, lines: lines.length, missingLines: missing, outOfOrder: ends.length - tails.length, numbers: numbers(expected).length, missingNumbers };
}

const workerOptions = { workerPath: join(root, 'scripts/ocr-benchmark-worker.cjs'), langPath: join(root, 'static/ocr/best'), cacheMethod: 'none', errorHandler: () => {} };
const wrap = (worker) => ({ ...worker, recognize: (image, parameters, out) => worker.recognize(image.toBuffer ? image.toBuffer('image/png') : image, parameters, out) });
const worker = await createWorker(options.language, OEM.LSTM_ONLY, workerOptions);
await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1', user_defined_dpi: '300' });
let scriptWorker;
const getScript = async () => wrap(scriptWorker ??= await createWorker('Khmer', OEM.LSTM_ONLY, workerOptions));
const documents = new Map(), rows = [];
const sum = (items, key) => items.reduce((total, item) => total + (item[key] ?? 0), 0);
const rate = (errors, characters) => characters ? +(100 * errors / characters).toFixed(2) : null;
function totals(items) {
  const characters = sum(items, 'characters');
  return { pages: items.length, characters, errors: sum(items, 'errors'), errorRate: rate(sum(items, 'errors'), characters),
    spacedErrorRate: rate(sum(items, 'spacedErrors'), characters), lines: sum(items, 'lines'), missingLines: sum(items, 'missingLines'),
    outOfOrder: sum(items, 'outOfOrder'), numbers: sum(items, 'numbers'), missingNumbers: sum(items, 'missingNumbers'),
    reviewWords: sum(items, 'reviewWords'), seconds: sum(items, 'seconds') };
}
try {
  for (const { file, page: number } of targets) {
    if (!documents.has(file)) documents.set(file, await pdfjs.getDocument({ data: new Uint8Array(await readFile(join(root, 'test-files', file))), isEvalSupported: false }).promise);
    const page = await documents.get(file).getPage(number);
    const base = page.getViewport({ scale: options.dpi / 72 });
    const size = imageDimensions(base.width, base.height);
    const scale = Math.min(size.width / base.width, size.height / base.height);
    const viewport = page.getViewport({ scale: options.dpi / 72 * scale });
    const source = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
    await page.render({ canvas: source, viewport, background: 'rgb(255,255,255)' }).promise;
    const canvas = prepareOcrImage(source, options.enhance, factory);
    const parameters = { rotateAuto: false, user_defined_dpi: String(Math.round(options.dpi * scale)), thresholding_method: '0' };
    const started = Date.now();
    const hooks = { checkAbort() {}, createCanvas: factory };
    const data = await recognizePreparedPage(wrap(worker), canvas, options, parameters, { ...hooks, scriptWorker: getScript, ...(words ? { words: async () => words } : {}) });
    // Same final steps as the browser: heading rechecks, word review, formatting.
    const final = await finalizeOcrPage(data, canvas, wrap(worker), parameters, { ...hooks, scriptWorker: getScript });
    const name = `${file.replace(/\.pdf$/u, '')}-p${number}`;
    await writeFile(join(output, `${name}.txt`), final.text);
    if (process.env.BENCHMARK_IMAGES) await writeFile(join(output, `${name}.png`), canvas.toBuffer('image/png'));
    const sample = reference.samples.find((item) => item.file === file && item.page === number);
    const result = { file, page: number, split: sample?.split ?? 'unscored', verified: Boolean(sample?.verified),
      confidence: Math.round(final.confidence), seconds: Math.round((Date.now() - started) / 1000), reviewWords: final.reviewWords.length,
      ...(sample ? score(sample.text, final.text) : {}) };
    if (result.characters) Object.assign(result, { errorRate: rate(result.errors, result.characters), spacedErrorRate: rate(result.spacedErrors, result.characters) });
    rows.push(result);
    console.log(JSON.stringify(result));
    source.width = source.height = canvas.width = canvas.height = 1;
  }
  const scored = rows.filter((row) => row.characters);
  const splits = Object.fromEntries([...new Set(scored.map((row) => row.split))].map((split) => [split, totals(scored.filter((row) => row.split === split))]));
  const report = { note: reference.description, pages: rows, total: totals(scored), splits,
    unverifiedPages: scored.filter((row) => !row.verified).length };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  for (const [split, total] of Object.entries(splits)) console.log(`${split}: ${JSON.stringify(total)}`);
  console.log(`Total: ${report.total.errors} errors in ${report.total.characters} characters (${report.total.errorRate}%), ` +
    `${report.total.missingLines}/${report.total.lines} lines missing, ${report.total.missingNumbers}/${report.total.numbers} numbers missing. Results: ${output}`);
  if (!splits.heldout) console.log('Note: no held-out pages; these results can overstate accuracy.');
  if (report.unverifiedPages) console.log(`Note: ${report.unverifiedPages} scored page(s) have unverified transcripts.`);
} finally { await worker.terminate(); await scriptWorker?.terminate(); for (const pdf of documents.values()) await pdf.loadingTask.destroy(); }
