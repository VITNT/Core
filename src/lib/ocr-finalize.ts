// The steps after page recognition, shared by the browser and the benchmark so
// the benchmark measures exactly what users get.
import { PSM } from 'tesseract.js';
import type { Page, RecognizeOptions, Worker, WorkerParams } from 'tesseract.js';
import { recheckKhmerHeadings } from './ocr-headings';
import { recheckCrop, reviewOcrText } from './ocr-review';
import { formatOcrParagraphs } from './ocr-paragraphs';
import { cleanOcrText } from './ocr-text';
import { normalizeKhmer } from './khmer-normalize';
import type { UncertainLine } from './ocr-read';

type Parameters = Partial<RecognizeOptions> & Partial<WorkerParams>;
type FinalizeHooks = {
  checkAbort: () => void;
  createCanvas: () => HTMLCanvasElement;
  // Khmer script model; heading rechecks run only when it is supplied.
  scriptWorker?: () => Promise<Worker>;
  onHeading?: (index: number, count: number) => void;
  onReview?: (index: number, count: number) => void;
};
export type FinalPage = { data: Page; text: string; originalText: string; reviewWords: string[]; confidence: number };

// Uncertain Khmer spans per page are capped so the notice stays readable.
const MAX_UNCERTAIN = 12;
const lines = (page: Page) => page.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ?? [];
const letters = (text: string) => text.match(/[\p{L}\p{N}\p{M}]/gu)?.length ?? 0;

export async function finalizeOcrPage(data: Page, canvas: HTMLCanvasElement, worker: Worker, parameters: Parameters, hooks: FinalizeHooks): Promise<FinalPage> {
  if (hooks.scriptWorker) data = await recheckKhmerHeadings(data, canvas, hooks.scriptWorker, { checkAbort: hooks.checkAbort, createCanvas: hooks.createCanvas, onLine: hooks.onHeading });
  hooks.checkAbort();
  const reviewed = await reviewOcrText(data, async (word, index, count) => {
    hooks.checkAbort();
    hooks.onReview?.(index, count);
    const region = recheckCrop(word, canvas.width, canvas.height);
    if (!region) return;
    const crop = hooks.createCanvas();
    crop.width = Math.max(1, Math.round(region.width * region.scale));
    crop.height = Math.max(1, Math.round(region.height * region.scale));
    try {
      const context = crop.getContext('2d')!;
      context.fillStyle = '#fff'; context.fillRect(0, 0, crop.width, crop.height);
      context.drawImage(canvas, region.left, region.top, region.width, region.height, 0, 0, crop.width, crop.height);
      // Per-recognition parameters are restored by Tesseract.js afterwards.
      const wordParameters: Parameters = { ...parameters, tessedit_pageseg_mode: PSM.SINGLE_WORD };
      const result = await worker.recognize(crop, wordParameters, { text: true, blocks: false });
      hooks.checkAbort();
      return result.data;
    } catch {
      hooks.checkAbort();
      return; // A failed optional re-read must not discard the successful page OCR.
    } finally { crop.width = crop.height = 0; }
  });
  hooks.checkAbort();
  // Places where the line readings disagreed, even if the engine was confident.
  const uncertain = [...new Set(lines(data).flatMap((line) => (line as UncertainLine).uncertain ?? []))].slice(0, MAX_UNCERTAIN);
  const all = lines(data).filter((line) => line.text.trim() && Number.isFinite(line.confidence));
  const weight = all.reduce((sum, line) => sum + Math.max(1, letters(line.text)), 0);
  const confidence = weight ? all.reduce((sum, line) => sum + line.confidence * Math.max(1, letters(line.text)), 0) / weight : data.confidence;
  return {
    data,
    originalText: normalizeKhmer(formatOcrParagraphs(data)),
    text: formatOcrParagraphs(data, normalizeKhmer(cleanOcrText(reviewed.text))),
    reviewWords: [...new Set([...reviewed.reviewWords, ...uncertain])],
    confidence,
  };
}
