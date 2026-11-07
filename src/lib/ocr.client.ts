import type { RecognizeOptions, Worker, WorkerParams } from 'tesseract.js';
import type { OcrOptions, PageResult } from './types';
import { extension, MAX_PAGES, officeExtensions } from './files';
import { cleanOcrText } from './ocr-text';
import { formatOcrParagraphs } from './ocr-paragraphs';
import { recheckCrop, reviewOcrText } from './ocr-review';
import { imageDimensions, prepareOcrImage } from './ocr-image';
import { recognizePreparedPage } from './ocr-read';
import { recheckKhmerHeadings } from './ocr-headings';
import { createImageBatchStore, processImageBatch } from './ocr-batch';

type Hooks = { progress: (value: number, stage: string) => void; page: (page: PageResult) => void };
const abortError = () => new DOMException('Conversion cancelled.', 'AbortError');

export class OcrSession {
  private worker?: Worker;
  private initializing?: Promise<Worker>;
  private scriptWorker?: Worker;
  private initializingScript?: Promise<Worker>;
  private currentProgress?: (progress: number) => void;
  constructor(private options: OcrOptions, private signal: AbortSignal) {}

  private async getWorker(script = false) {
    this.checkAbort();
    const key = script ? 'initializingScript' : 'initializing';
    if (!this[key]) {
      this[key] = (async () => {
        const { createWorker, OEM, PSM } = await import('tesseract.js');
        // Tesseract 7's relaxed-SIMD core crashes on the floating-point best models
        // (upstream #1080). Select ordinary SIMD, with a portable non-SIMD fallback.
        const { simd } = await import('wasm-feature-detect');
        const corePath = this.options.quality === 'best'
          ? `${location.origin}/ocr/tesseract-core-${await simd() ? 'simd-' : ''}lstm.wasm.js`
          : `${location.origin}/ocr`;
        const worker = await createWorker(script ? 'Khmer' : this.options.language, OEM.LSTM_ONLY, {
          workerPath: `${location.origin}/ocr/worker.min.js`,
          corePath,
          langPath: `${location.origin}/ocr/${this.options.quality}`,
          cachePath: `khmer-ocr-${this.options.quality}`,
          workerBlobURL: false,
          errorHandler: () => { /* Rejections are displayed on the document row. */ },
          logger: (message) => {
            if (message.status === 'recognizing text') this.currentProgress?.(message.progress);
          }
        });
        if (this.signal.aborted) { await worker.terminate(); throw abortError(); }
        if (script) this.scriptWorker = worker; else this.worker = worker;
        await worker.setParameters({
          tessedit_pageseg_mode: this.options.layout === 'column' ? PSM.SINGLE_COLUMN : PSM.AUTO,
          preserve_interword_spaces: '1', user_defined_dpi: String(this.options.dpi)
        });
        return worker;
      })();
    }
    return this[key]!;
  }

  private checkAbort() { if (this.signal.aborted) throw abortError(); }

  async dispose() {
    const workers = [this.worker, this.scriptWorker];
    this.worker = this.scriptWorker = undefined;
    await Promise.all(workers.map((worker) => worker?.terminate()));
  }

  private async recognize(source: HTMLCanvasElement, number: number, total: number, hooks: Hooks, start = 0, span = 100, dpi: number = this.options.dpi) {
    this.checkAbort();
    const progress = (fraction: number, stage: string) => hooks.progress(start + ((number - 1 + fraction) / total) * span, stage);
    progress(0, `Preparing image · page ${number} of ${total}`);
    const canvas = prepareOcrImage(source, this.options.enhance);
    try {
      progress(0, `Loading OCR · page ${number} of ${total}`);
      const worker = await this.getWorker();
      this.checkAbort();
      const parameters: Partial<RecognizeOptions> & Partial<WorkerParams> = { rotateAuto: false, user_defined_dpi: String(Math.round(dpi)), thresholding_method: '0' };
      let data = await recognizePreparedPage(worker, canvas, this.options, parameters, {
        checkAbort: () => this.checkAbort(),
        onPass: (start, end, stage) => {
          progress(start, `${stage} · page ${number} of ${total}`);
          this.currentProgress = (value) => progress(start + value * (end - start), `${stage} · page ${number} of ${total}`);
        },
      });
      this.checkAbort();
      this.currentProgress = undefined;
      if (this.options.quality === 'best' && this.options.language !== 'eng') {
        data = await recheckKhmerHeadings(data, canvas, () => this.getWorker(true), {
          checkAbort: () => this.checkAbort(),
          onLine: (index, count) => progress(0.9, `Checking Khmer heading ${index + 1} of ${count} · page ${number} of ${total}`),
        });
      }
      const reviewed = await reviewOcrText(data, async (word, index, count) => {
        this.checkAbort();
        progress(0.9 + 0.1 * index / count, `Checking text · page ${number} of ${total}`);
        const region = recheckCrop(word, canvas.width, canvas.height);
        if (!region) return;
        const crop = document.createElement('canvas');
        crop.width = Math.max(1, Math.round(region.width * region.scale));
        crop.height = Math.max(1, Math.round(region.height * region.scale));
        const context = crop.getContext('2d')!;
        context.fillStyle = '#fff'; context.fillRect(0, 0, crop.width, crop.height);
        context.drawImage(canvas, region.left, region.top, region.width, region.height, 0, 0, crop.width, crop.height);
        try {
          const { PSM } = await import('tesseract.js');
          const options: Partial<RecognizeOptions> & Partial<WorkerParams> = { ...parameters, tessedit_pageseg_mode: PSM.SINGLE_WORD };
          // Per-recognition parameters are restored by Tesseract.js afterwards.
          const result = await worker.recognize(crop, options, { text: true, blocks: false });
          this.checkAbort();
          return result.data;
        } catch {
          this.checkAbort();
          // A failed optional re-read must not discard the successful page OCR.
          return;
        } finally {
          crop.width = crop.height = 0;
        }
      });
      this.checkAbort();
      const thumbnail = document.createElement('canvas');
      thumbnail.width = Math.min(1000, source.width);
      thumbnail.height = Math.max(1, Math.round(source.height * thumbnail.width / source.width));
      thumbnail.getContext('2d')!.drawImage(source, 0, 0, thumbnail.width, thumbnail.height);
      const originalText = formatOcrParagraphs(data).normalize('NFC');
      const text = formatOcrParagraphs(data, cleanOcrText(reviewed.text));
      hooks.page({ number, text, ...(text !== originalText ? { originalText } : {}), reviewWords: reviewed.reviewWords, confidence: data.confidence, preview: thumbnail.toDataURL('image/jpeg', 0.8) });
      thumbnail.width = thumbnail.height = 0;
      progress(1, `Read ${number} of ${total} images`);
    } finally {
      this.currentProgress = undefined;
      canvas.width = canvas.height = 0;
    }
  }

  async process(file: File, hooks: Hooks) {
    this.checkAbort();
    let source: Blob = file;
    const ext = extension(file.name);
    if (officeExtensions.includes(ext)) {
      hooks.progress(0, 'Rendering document to PDF');
      const form = new FormData();
      form.set('file', file);
      const response = await fetch('/api/render', { method: 'POST', body: form, signal: this.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message ?? 'Document rendering failed. Try exporting the document as a PDF.');
      }
      source = await response.blob();
    }

    if (ext === 'pdf' || officeExtensions.includes(ext)) {
      hooks.progress(0, 'Opening PDF');
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';
      const task = pdfjs.getDocument({
        data: new Uint8Array(await source.arrayBuffer()), cMapUrl: '/pdf/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/pdf/standard_fonts/', wasmUrl: '/pdf/wasm/'
      });
      const abort = () => { void task.destroy(); };
      this.signal.addEventListener('abort', abort, { once: true });
      try {
        const pdf = await task.promise;
        if (pdf.numPages > MAX_PAGES) throw new Error(`This PDF has ${pdf.numPages} pages. Split it into files of ${MAX_PAGES} pages or fewer.`);
        const store = await createImageBatchStore();
        await processImageBatch({
          count: pdf.numPages, store, signal: this.signal,
          render: async (number) => {
            this.checkAbort();
            hooks.progress((number - 1) / pdf.numPages * 30, `Creating image ${number} of ${pdf.numPages}`);
            const page = await pdf.getPage(number);
            const base = page.getViewport({ scale: this.options.dpi / 72 });
            const size = imageDimensions(base.width, base.height);
            const scale = Math.min(size.width / base.width, size.height / base.height);
            const viewport = page.getViewport({ scale: this.options.dpi / 72 * scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
            const rendering = page.render({ canvas, viewport, background: 'rgb(255,255,255)' });
            const cancelRender = () => rendering.cancel();
            this.signal.addEventListener('abort', cancelRender, { once: true });
            try {
              this.checkAbort();
              await rendering.promise;
              this.checkAbort();
              const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((image) => image ? resolve(image) : reject(new Error(`Could not create image ${number}.`)), 'image/png'));
              hooks.progress(number / pdf.numPages * 30, `Prepared ${number} of ${pdf.numPages} images`);
              return { blob, dpi: this.options.dpi * scale };
            } finally {
              this.signal.removeEventListener('abort', cancelRender);
              canvas.width = canvas.height = 0;
              page.cleanup();
            }
          },
          recognize: async (image, number) => {
            const bitmap = await createImageBitmap(image.blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            try {
              canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
              bitmap.close();
              await this.recognize(canvas, number, pdf.numPages, hooks, 30, 70, image.dpi);
            } finally {
              bitmap.close();
              canvas.width = canvas.height = 0;
            }
          },
        });
      } catch (error) {
        if (this.signal.aborted) throw abortError();
        if (error instanceof Error && error.name === 'PasswordException') throw new Error('This PDF is password-protected. Unlock it and try again.');
        throw error;
      } finally {
        this.signal.removeEventListener('abort', abort);
        await task.destroy();
      }
    } else {
      hooks.progress(0, 'Opening image');
      const bitmap = await createImageBitmap(source);
      try {
        const size = imageDimensions(bitmap.width, bitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        try { await this.recognize(canvas, 1, 1, hooks); }
        finally { canvas.width = canvas.height = 0; }
      } finally { bitmap.close(); }
    }
  }
}
