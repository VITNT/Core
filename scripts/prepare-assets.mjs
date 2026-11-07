import { cp, mkdir, access, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const ocr = resolve(root, 'static/ocr');
const pdf = resolve(root, 'static/pdf');
await mkdir(ocr, { recursive: true });
await mkdir(pdf, { recursive: true });
await cp(require.resolve('tesseract.js/dist/worker.min.js'), resolve(ocr, 'worker.min.js'));
await cp(resolve(dirname(require.resolve('tesseract.js/package.json')), 'LICENSE.md'), resolve(ocr, 'LICENSE.tesseract.md'));
const core = dirname(require.resolve('tesseract.js-core/package.json'));
await cp(resolve(core, 'LICENSE'), resolve(ocr, 'LICENSE.core'));
for (const file of (await readdir(core)).filter((name) => /-lstm\.wasm(?:\.js)?$/.test(name))) {
  await cp(resolve(core, file), resolve(ocr, file));
}
const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
await cp(resolve(pdfRoot, 'build/pdf.worker.min.mjs'), resolve(pdf, 'pdf.worker.min.mjs'));
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(resolve(pdfRoot, folder), resolve(pdf, folder), { recursive: true });
}
for (const language of ['khm', 'eng', 'Khmer']) {
  for (const quality of ['best', 'fast']) {
    if (language === 'Khmer' && quality !== 'best') continue;
    const directory = resolve(ocr, quality);
    const target = resolve(directory, `${language}.traineddata.gz`);
    await mkdir(directory, { recursive: true });
    try { await access(target); continue; } catch { /* Download once during setup. */ }
    console.log(`Downloading ${quality} ${language} OCR model…`);
    const response = await fetch(`https://raw.githubusercontent.com/tesseract-ocr/tessdata_${quality}/main/${language === 'Khmer' ? 'script/Khmer' : language}.traineddata`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`OCR model download failed: ${response.status}`);
    await writeFile(target, gzipSync(Buffer.from(await response.arrayBuffer())));
  }
}
console.log('Local OCR and PDF assets ready.');
