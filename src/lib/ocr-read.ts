import { PSM } from 'tesseract.js';
import type { Bbox, Line, Page, Paragraph, RecognizeOptions, Worker, WorkerParams } from 'tesseract.js';
import type { OcrOptions } from './types';
import { findDotLeaders, eraseDotLeaders, eraseTableRulings } from './ocr-layout';
import { needsSecondPass, preferReading } from './ocr-quality';
import { preparePageLayout, prepareTextRegion, recognitionRegions, type TextRegion } from './ocr-regions';
import { attachListLabels, mapLayoutCoordinates, preserveRegionParagraphs, suppressCoveredFragments, type ListLabel } from './ocr-structure';

type Parameters = Partial<RecognizeOptions> & Partial<WorkerParams>;
export type RowReading = { region: TextRegion; data: Page; shear?: number; originalConfidence?: number; scale?: number };
type ReadHooks = {
  checkAbort: () => void;
  onPass?: (start: number, end: number, stage: string) => void;
  createCanvas?: () => HTMLCanvasElement;
};
const characterCount = (text: string) => text.match(/[\p{L}\p{N}\p{M}]/gu)?.length ?? 0;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

export function preferSlantReading(first: Page, candidate: Page): boolean {
  const khmer = candidate.text.match(/\p{Script=Khmer}/gu)?.length ?? 0;
  return first.confidence < 65 && Number.isFinite(candidate.confidence) &&
    candidate.confidence >= Math.max(65, first.confidence + 15) && khmer >= 4 &&
    characterCount(candidate.text) >= characterCount(first.text) * 0.65;
}

export function preferRowReading(first: Page, candidate: Page, completedRows: number, expectedRows: number, contents: boolean): boolean {
  if (!candidate.text.trim() || completedRows < expectedRows * 0.85 || candidate.confidence < 60 || !Number.isFinite(candidate.confidence)) return false;
  // Very weak contents readings mistake the dot leaders for letters/digits.
  // Do not require those artifacts to survive a complete row repair.
  if (contents && first.confidence < 75) return candidate.confidence >= Math.max(75, first.confidence + 15);
  // Confidence alone rewards a short reading that omitted difficult text.
  for (const script of [/\p{Script=Khmer}/gu, /\p{N}/gu]) {
    const count = (text: string) => text.match(script)?.length ?? 0;
    if (count(candidate.text) < count(first.text) * 0.85) return false;
  }
  const khmer = (text: string) => text.match(/\p{Script=Khmer}/gu)?.length ?? 0;
  const recoversText = khmer(candidate.text) > khmer(first.text) * 1.03 && characterCount(candidate.text) >= characterCount(first.text) * 0.95;
  if (!contents && (candidate.confidence < first.confidence + (recoversText ? -1 : 3) || characterCount(candidate.text) < characterCount(first.text) * 0.85)) return false;
  const english = first.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words)))
    .filter((word) => word.confidence >= 85 && /^[A-Za-z]{3,}$/u.test(word.text)) ?? [];
  const retained = english.filter((word) => candidate.text.toLowerCase().includes(word.text.toLowerCase())).length;
  // Layout repair may replace spurious Latin fragments in Khmer, but must not
  // silently discard a substantial, confidently recognized English passage.
  return (english.length < 3 || retained >= english.length * 0.75) && (!contents || candidate.confidence >= first.confidence - 5);
}

export function combineRowReadings(base: Page, readings: RowReading[], contents = false): Page {
  const nonempty = readings.filter((reading) => reading.data.text.trim());
  const height = median(nonempty.map(({ region }) => region.height));
  const lefts = nonempty.map(({ region }) => region.left).sort((a, b) => a - b);
  const bodyLeft = lefts[Math.floor(lefts.length * 0.2)] ?? 0;
  const pitch = median(nonempty.slice(1).map((reading, index) => reading.region.top - nonempty[index].region.top));
  const groups: { lines: Line[]; regions: TextRegion[] }[] = [];
  let weight = 0, confidence = 0;
  function mappedPoint(x: number, y: number, reading: RowReading) {
    const scale = reading.scale ?? 1;
    return { x: reading.region.left + (x - 16 - (reading.shear ?? 0) * (y - 16)) / scale,
      y: reading.region.top + (y - 16) / scale };
  }
  function shifted(box: Bbox, reading: RowReading): Bbox {
    const points = [mappedPoint(box.x0, box.y0, reading), mappedPoint(box.x0, box.y1, reading),
      mappedPoint(box.x1, box.y0, reading), mappedPoint(box.x1, box.y1, reading)];
    return { x0: Math.min(...points.map((p) => p.x)), y0: Math.min(...points.map((p) => p.y)),
      x1: Math.max(...points.map((p) => p.x)), y1: Math.max(...points.map((p) => p.y)) };
  }
  for (const [index, reading] of nonempty.entries()) {
    const { region, data } = reading;
    const previous = nonempty[index - 1];
    const boundary = !previous || contents || region.listStart ||
      region.top - previous.region.top > pitch * 1.4 ||
      region.left > bodyLeft + height * 0.8 ||
      Math.max(region.height, previous.region.height) > Math.min(region.height, previous.region.height) * 1.4 ||
      /^\s*(?:[-+•]|[0-9០-៩]+[.)])\s*\S/u.test(data.text);
    if (boundary) groups.push({ lines: [], regions: [] });
    const group = groups[groups.length - 1];
    group.regions.push(region);
    for (const block of data.blocks ?? []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
      group.lines.push({ ...line, bbox: shifted(line.bbox, reading),
        baseline: line.baseline ? (() => {
          const start = mappedPoint(line.baseline.x0, line.baseline.y0, reading);
          const end = mappedPoint(line.baseline.x1, line.baseline.y1, reading);
          return { x0: start.x, y0: start.y, x1: end.x, y1: end.y };
        })() : line.baseline,
        rowAttributes: { ...line.rowAttributes, rowHeight: line.rowAttributes.rowHeight / (reading.scale ?? 1),
          ascenders: line.rowAttributes.ascenders / (reading.scale ?? 1), descenders: line.rowAttributes.descenders / (reading.scale ?? 1) },
        words: line.words.map((word) => ({ ...word, bbox: shifted(word.bbox, reading),
          symbols: word.symbols?.map((symbol) => ({ ...symbol, bbox: shifted(symbol.bbox, reading) })),
        })),
      });
    }
    const characters = Math.max(1, characterCount(data.text));
    weight += characters; confidence += characters * data.confidence;
  }
  const paragraphs: Paragraph[] = groups.filter((group) => group.lines.length).map((group) => ({
    lines: group.lines, text: group.lines.map((line) => line.text.trimEnd()).join('\n') + '\n',
    confidence: group.lines.reduce((sum, line) => sum + line.confidence, 0) / group.lines.length,
    is_ltr: true,
    bbox: { x0: Math.min(...group.regions.map((region) => region.left)), y0: Math.min(...group.regions.map((region) => region.top)),
      x1: Math.max(...group.regions.map((region) => region.left + region.width)), y1: Math.max(...group.regions.map((region) => region.top + region.height)) },
  }));
  const text = paragraphs.map((paragraph) => paragraph.text.trimEnd()).join('\n\n') + (paragraphs.length ? '\n' : '');
  return { ...base, text, confidence: weight ? confidence / weight : 0,
    blocks: paragraphs.length ? [{ ...base.blocks?.[0], paragraphs, text, confidence: weight ? confidence / weight : 0,
      bbox: { x0: Math.min(...paragraphs.map((paragraph) => paragraph.bbox.x0)), y0: Math.min(...paragraphs.map((paragraph) => paragraph.bbox.y0)),
        x1: Math.max(...paragraphs.map((paragraph) => paragraph.bbox.x1)), y1: Math.max(...paragraphs.map((paragraph) => paragraph.bbox.y1)) },
      blocktype: 'FLOWING_TEXT', page: base,
    }] : null,
  };
}

// Keep improved regions even if the complete region reading cannot replace the
// page safely. Only replace one unambiguously matching line at a time.
export function mergeRegionReadings(base: Page, readings: RowReading[]): Page {
  const lines = base.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ?? [];
  const replacements = new Map<Line, Line>();
  for (const reading of readings) {
    if (!reading.shear && reading.scale === undefined) continue;
    const { region } = reading;
    const matching = lines.filter((line) => {
      const center = (line.bbox.y0 + line.bbox.y1) / 2;
      const overlap = Math.min(line.bbox.x1, region.left + region.width) - Math.max(line.bbox.x0, region.left);
      return center >= region.top && center <= region.top + region.height &&
        overlap >= Math.min(line.bbox.x1 - line.bbox.x0, region.width) * 0.5;
    });
    if (matching.length !== 1) continue;
    if (reading.shear && matching[0].confidence >= 85) continue;
    // Compare the same crop before/after the transform. Whole-page segmentation
    // can assign a higher score to a badly segmented line than its isolated read.
    const confidence = Math.min(matching[0].confidence, reading.originalConfidence ?? matching[0].confidence);
    const first = { ...base, text: matching[0].text, confidence };
    if (reading.shear ? !preferSlantReading(first, reading.data) : !preferRowReading(first, reading.data, 1, 1, false)) continue;
    const corrected = combineRowReadings(base, [reading]).blocks?.[0].paragraphs.flatMap((paragraph) => paragraph.lines) ?? [];
    if (corrected.length === 1) replacements.set(matching[0], corrected[0]);
  }
  if (!replacements.size) return base;
  const blocks = base.blocks!.map((block) => {
    const paragraphs = block.paragraphs.map((paragraph) => {
      const lines = paragraph.lines.map((line) => replacements.get(line) ?? line);
      return { ...paragraph, lines, text: lines.map((line) => line.text.trimEnd()).join('\n') + '\n' };
    });
    return { ...block, paragraphs, text: paragraphs.map((paragraph) => paragraph.text.trimEnd()).join('\n\n') + '\n' };
  });
  const updated = blocks.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines));
  const weight = updated.reduce((sum, line) => sum + Math.max(1, characterCount(line.text)), 0);
  return { ...base, blocks, text: blocks.map((block) => block.text.trimEnd()).join('\n\n') + '\n',
    confidence: updated.reduce((sum, line) => sum + line.confidence * Math.max(1, characterCount(line.text)), 0) / weight };
}

export async function recognizePreparedPage(worker: Worker, canvas: HTMLCanvasElement, options: OcrOptions, parameters: Parameters, hooks: ReadHooks): Promise<Page> {
  const createCanvas = hooks.createCanvas ?? (() => document.createElement('canvas'));
  const onPass = hooks.onPass ?? (() => {});
  const output = { text: true, blocks: true };
  hooks.checkAbort();
  onPass(0, 0.2, 'Reading image');
  let layout = { canvas, scaleX: 1, scaleY: 1, rows: [] as TextRegion[] };
  if (options.quality === 'best') {
    try { layout = preparePageLayout(canvas, options.language, createCanvas); }
    catch { hooks.checkAbort(); } // Allocation failure retains the original layout path.
  }
  const labels: ListLabel[] = [];
  const numbered = layout.rows.filter((row) => row.label).slice(0, 120);
  for (const [index, region] of numbered.entries()) {
    hooks.checkAbort();
    onPass(index / numbered.length * 0.1, (index + 1) / numbered.length * 0.1, `Reading list label ${index + 1} of ${numbered.length}`);
    let crop: ReturnType<typeof prepareTextRegion> | undefined;
    try {
      crop = prepareTextRegion(canvas, region.label!, 'eng', createCanvas);
      const labelParameters: Parameters = { ...parameters, tessedit_pageseg_mode: PSM.SINGLE_WORD,
        user_defined_dpi: String(Math.max(70, Math.round(Number(parameters.user_defined_dpi ?? options.dpi) * crop.scale))) };
      const result = await worker.recognize(crop.canvas, labelParameters, { text: true, blocks: false });
      const text = result.data.text.trim();
      if (/^[0-9០-៩]{1,4}[.)]?$/u.test(text) && result.data.confidence >= 50) labels.push({ region, text, confidence: result.data.confidence });
    } catch { hooks.checkAbort(); }
    finally { if (crop) crop.canvas.width = crop.canvas.height = 0; }
  }
  if (labels.length) {
    try {
      if (layout.canvas === canvas) {
        const isolated = createCanvas(); isolated.width = canvas.width; isolated.height = canvas.height;
        isolated.getContext('2d')!.drawImage(canvas, 0, 0);
        layout = { ...layout, canvas: isolated };
      }
      const context = layout.canvas.getContext('2d')!;
      context.fillStyle = '#fff';
      for (const { region } of labels) context.fillRect(Math.floor(region.left * layout.scaleX), Math.floor(region.top * layout.scaleY),
        Math.ceil((region.bodyLeft! - region.left) * layout.scaleX), Math.ceil(region.height * layout.scaleY));
    } catch { hooks.checkAbort(); }
  }
  onPass(numbered.length ? 0.1 : 0, 0.2, 'Reading image');
  let primary: { data: Page };
  try {
    const layoutParameters: Parameters = { ...parameters,
      user_defined_dpi: String(Math.max(70, Math.round(Number(parameters.user_defined_dpi ?? options.dpi) * layout.scaleY))) };
    const result = await worker.recognize(layout.canvas, layoutParameters, output);
    const mapped = mapLayoutCoordinates(result.data, layout.scaleX, layout.scaleY);
    primary = { data: options.quality !== 'best' || options.language === 'eng' ? mapped : suppressCoveredFragments(mapped) };
  } finally { if (layout.canvas !== canvas) layout.canvas.width = layout.canvas.height = 0; }
  hooks.checkAbort();
  // Never let line removal destroy the only reading of the source pixels.
  // Keep the caller's canvas intact: word rechecks must also use those pixels.
  if (options.quality !== 'best') return primary.data;
  let layoutCanvas: HTMLCanvasElement | undefined;
  try {
    layoutCanvas = createCanvas();
    layoutCanvas.width = canvas.width; layoutCanvas.height = canvas.height;
    layoutCanvas.getContext('2d')!.drawImage(canvas, 0, 0);
    const data = await recognizeLayoutPage(worker, layoutCanvas, options, parameters, hooks, primary.data, labels);
    hooks.checkAbort();
    return preserveRegionParagraphs(attachListLabels(data, labels), layout.rows);
  } catch {
    hooks.checkAbort();
    return preserveRegionParagraphs(attachListLabels(primary.data, labels), layout.rows);
  } finally { if (layoutCanvas) layoutCanvas.width = layoutCanvas.height = 0; }
}

async function recognizeLayoutPage(worker: Worker, canvas: HTMLCanvasElement, options: OcrOptions, parameters: Parameters, hooks: ReadHooks, primary: Page, labels: ListLabel[]): Promise<Page> {
  const createCanvas = hooks.createCanvas ?? (() => document.createElement('canvas'));
  const onPass = hooks.onPass ?? (() => {});
  const output = { text: true, blocks: true };
  let data = primary;
  let rows: TextRegion[] = [], contents = false, table = false;
  if (options.enhance) {
    hooks.checkAbort();
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const leaders = findDotLeaders(image.data, canvas.width, canvas.height);
    contents = leaders.length >= 3;
    if (contents) eraseDotLeaders(image.data, canvas.width, canvas.height, leaders);
    table = eraseTableRulings(image.data, canvas.width, canvas.height).length >= 4;
    context.putImageData(image, 0, 0);

    if (contents || table) {
      try {
        onPass(0.2, 0.3, 'Checking page layout');
        const cleaned = await worker.recognize(canvas, parameters, output);
        hooks.checkAbort();
        if (preferRowReading(data, cleaned.data, 1, 1, false)) data = cleaned.data;
        else data = preferReading(data, cleaned.data);
      } catch { hooks.checkAbort(); }
    }
  }
  hooks.checkAbort();
  rows = recognitionRegions(canvas, data);
  const readings: RowReading[] = [];
  const tryRows = rows.length >= 1 && rows.length <= 120;
  if (tryRows) {
    const typicalHeight = median(rows.map((row) => row.height));
    const khmerContext = options.language !== 'eng' && (data.text.match(/\p{Script=Khmer}/gu)?.length ?? 0) >= 20;
    let slantRetries = 0;
    try {
      for (const [index, row] of rows.entries()) {
        const isolatedLabel = labels.some(({ region }) => Math.abs(region.top - row.top) < row.height * 0.2 && Math.abs(region.left - row.left) < row.height * 0.4);
        const region = row.bodyLeft === undefined || !isolatedLabel ? row : { ...row, left: row.bodyLeft, width: row.left + row.width - row.bodyLeft };
        hooks.checkAbort();
        const start = 0.3 + index / rows.length * 0.55, end = 0.3 + (index + 1) / rows.length * 0.55;
        onPass(start, start + (end - start) * 0.5, `Reading text region ${index + 1} of ${rows.length}`);
        const prepared = prepareTextRegion(canvas, region, options.language, createCanvas);
        const crop = prepared.canvas;
        try {
          const rowParameters: Parameters = { ...parameters,
            user_defined_dpi: String(Math.max(70, Math.round(Number(parameters.user_defined_dpi ?? options.dpi) * prepared.scale))),
            tessedit_pageseg_mode: region.height > typicalHeight * 1.8 ? PSM.SINGLE_BLOCK : PSM.SINGLE_LINE,
          };
          const result = await worker.recognize(crop, rowParameters, output);
          let selected: RowReading = { region, data: result.data, scale: prepared.scale };
          if (khmerContext && result.data.confidence < 65 && slantRetries < 24 && region.height <= typicalHeight * 3) {
            slantRetries++;
            for (const [attempt, shear] of [0.35, 0.2].entries()) {
              hooks.checkAbort();
              onPass(start + (end - start) * (0.5 + attempt * 0.25), start + (end - start) * (0.75 + attempt * 0.25), `Checking slanted text row ${index + 1} of ${rows.length}`);
              const transformed = prepareTextRegion(canvas, region, options.language, createCanvas, shear);
              const straight = transformed.canvas;
              try {
                const transformedParameters: Parameters = { ...rowParameters,
                  user_defined_dpi: String(Math.max(70, Math.round(Number(parameters.user_defined_dpi ?? options.dpi) * transformed.scale))) };
                const alternative = await worker.recognize(straight, transformedParameters, output);
                if (preferSlantReading(result.data, alternative.data) && alternative.data.confidence > selected.data.confidence) selected = { region, data: alternative.data, shear, scale: transformed.scale, originalConfidence: result.data.confidence };
                if (selected.data.confidence >= 85) break;
              } finally { straight.width = straight.height = 0; }
            }
          }
          readings.push(selected);
        } finally { crop.width = crop.height = 0; }
      }
      hooks.checkAbort();
      const candidate = combineRowReadings(data, readings, contents);
      const completed = readings.filter((reading) => reading.data.blocks?.some((block) => block.paragraphs.some((paragraph) => paragraph.lines.some((line) => line.text.trim())))).length;
      if (preferRowReading(data, candidate, completed, rows.length, contents)) return preserveRegionParagraphs(candidate, rows);
    } catch {
      hooks.checkAbort(); // Optional layout repair must preserve a successful first pass.
    }
  }
  if (options.quality === 'best' && needsSecondPass(data)) {
    try {
      onPass(tryRows ? 0.85 : 0.3, 0.9, 'Checking another reading');
      const alternateParameters: Parameters = { ...parameters, thresholding_method: '2',
        tessedit_pageseg_mode: options.layout === 'auto' && (data.blocks?.length ?? 0) <= 1 ? PSM.SINGLE_BLOCK : options.layout === 'column' ? PSM.SINGLE_COLUMN : PSM.AUTO,
      };
      const alternative = await worker.recognize(canvas, alternateParameters, output);
      hooks.checkAbort();
      data = preferReading(data, alternative.data);
    } catch { hooks.checkAbort(); }
  }
  return preserveRegionParagraphs(mergeRegionReadings(data, readings), rows);
}
