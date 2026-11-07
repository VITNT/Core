import { PSM } from 'tesseract.js';
import type { Bbox, Line, Page, Worker, RecognizeOptions, WorkerParams } from 'tesseract.js';

type Hooks = {
  checkAbort: () => void;
  createCanvas?: () => HTMLCanvasElement;
  onLine?: (index: number, total: number) => void;
};
const normalize = (text: string) => text.trim().normalize('NFC').replace(/\s+/gu, ' ');

// Language and script models make different mistakes on short Khmer headings.
// Retry only weak, short lines, and require agreement at two scales. Never use
// a dictionary replacement: the candidate must come from the actual pixels.
export async function recheckKhmerHeadings(data: Page, canvas: HTMLCanvasElement, getWorker: () => Promise<Worker>, hooks: Hooks): Promise<Page> {
  const lines = data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ?? [];
  const weak = lines.filter((line) => {
    const text = normalize(line.text), box = line.bbox;
    return Number.isFinite(line.confidence) && line.confidence < 60 && text.length >= 4 && text.length <= 48 &&
      /\p{Script=Khmer}/u.test(text) && /^[\p{Script=Khmer}\p{N}\p{P}\s]+$/u.test(text) &&
      Object.values(box).every(Number.isFinite) && box.x1 > box.x0 && box.y1 > box.y0;
  }).slice(0, 6);
  if (!weak.length) return data;
  const createCanvas = hooks.createCanvas ?? (() => document.createElement('canvas'));
  const replacements = new Map<Line, Line>();
  for (const [index, line] of weak.entries()) {
    hooks.checkAbort();
    hooks.onLine?.(index, weak.length);
    const left = Math.max(0, Math.floor(line.bbox.x0 - 6)), top = Math.max(0, Math.floor(line.bbox.y0 - 6));
    const width = Math.min(canvas.width, Math.ceil(line.bbox.x1 + 6)) - left;
    const height = Math.min(canvas.height, Math.ceil(line.bbox.y1 + 6)) - top;
    if (width <= 0 || height <= 0 || (width * 2.5 + 32) * (height * 2.5 + 32) > 2_000_000) continue;
    const candidates: { data: Page; scale: number }[] = [];
    try {
      const worker = await getWorker();
      for (const scale of [2, 2.5]) {
        hooks.checkAbort();
        const crop = createCanvas();
        crop.width = Math.ceil(width * scale) + 32; crop.height = Math.ceil(height * scale) + 32;
        try {
          const context = crop.getContext('2d')!;
          context.fillStyle = '#fff'; context.fillRect(0, 0, crop.width, crop.height);
          context.drawImage(canvas, left, top, width, height, 16, 16, width * scale, height * scale);
          const parameters: Partial<RecognizeOptions> & Partial<WorkerParams> = {
            tessedit_pageseg_mode: /\s/u.test(line.text.trim()) ? PSM.SINGLE_LINE : PSM.SINGLE_WORD,
            rotateAuto: false, user_defined_dpi: '300', thresholding_method: '0',
          };
          const result = await worker.recognize(crop, parameters, { text: true, blocks: true });
          candidates.push({ data: result.data, scale });
        } finally { crop.width = crop.height = 0; }
      }
      hooks.checkAbort();
      const text = normalize(candidates[0].data.text);
      const best = candidates.reduce((a, b) => a.data.confidence >= b.data.confidence ? a : b);
      if (!text || text.match(/\p{N}/gu)?.join('') !== line.text.match(/\p{N}/gu)?.join('') || text !== normalize(candidates[1].data.text) || !/^[\p{Script=Khmer}\p{N}\p{P}\s]+$/u.test(text) ||
          !Number.isFinite(best.data.confidence) || best.data.confidence < Math.max(50, line.confidence + 15) ||
          text.length < normalize(line.text).length * 0.75 || text.length > normalize(line.text).length * 1.35) continue;
      const candidateLines = best.data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ?? [];
      if (candidateLines.length !== 1) continue;
      const mapBox = (box: Bbox): Bbox => ({
        x0: left + (box.x0 - 16) / best.scale, y0: top + (box.y0 - 16) / best.scale,
        x1: left + (box.x1 - 16) / best.scale, y1: top + (box.y1 - 16) / best.scale,
      });
      const candidate = candidateLines[0];
      replacements.set(line, { ...candidate, text: text + '\n', bbox: mapBox(candidate.bbox),
        baseline: candidate.baseline ? mapBox(candidate.baseline) : candidate.baseline,
        words: candidate.words.map((word) => ({ ...word, bbox: mapBox(word.bbox),
          symbols: word.symbols?.map((symbol) => ({ ...symbol, bbox: mapBox(symbol.bbox) })),
        })),
      });
    } catch { hooks.checkAbort(); } // Keep the successful page if an optional retry fails.
  }
  if (!replacements.size) return data;
  const blocks = data.blocks!.map((block) => {
    const paragraphs = block.paragraphs.map((paragraph) => {
      const lines = paragraph.lines.map((line) => replacements.get(line) ?? line);
      return { ...paragraph, lines, text: lines.map((line) => line.text.trimEnd()).join('\n') + '\n' };
    });
    return { ...block, paragraphs, text: paragraphs.map((paragraph) => paragraph.text.trimEnd()).join('\n\n') + '\n' };
  });
  const updated = blocks.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines));
  const weight = updated.reduce((sum, line) => sum + Math.max(1, line.text.trim().length), 0);
  return { ...data, blocks, text: blocks.map((block) => block.text.trimEnd()).join('\n\n') + '\n',
    confidence: updated.reduce((sum, line) => sum + line.confidence * Math.max(1, line.text.trim().length), 0) / weight };
}
