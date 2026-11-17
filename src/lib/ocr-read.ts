import { PSM } from 'tesseract.js';
import type { Bbox, Line, Page, Paragraph, RecognizeOptions, Worker, WorkerParams } from 'tesseract.js';
import type { OcrOptions } from './types';
import { findDotLeaders, eraseDotLeaders, eraseTableRulings } from './ocr-layout';
import { needsSecondPass, preferReading } from './ocr-quality';
import { countTextLines, preparePageLayout, prepareTextRegion, recognitionRegions, splitWideGaps, type RegionVariant, type TextRegion } from './ocr-regions';
import { eraseRules } from './ocr-cleanup';
import { editDistance, voteReadings } from './ocr-consensus';
import { normalizeKhmer } from './khmer-normalize';
import type { WordList } from './ocr-dictionary';
import { attachListLabels, mapLayoutCoordinates, preserveRegionParagraphs, suppressCoveredFragments, type ListLabel } from './ocr-structure';

type Parameters = Partial<RecognizeOptions> & Partial<WorkerParams>;
export type RowReading = { region: TextRegion; data: Page; shear?: number; originalConfidence?: number; scale?: number };
type ReadHooks = {
  checkAbort: () => void;
  onPass?: (start: number, end: number, stage: string) => void;
  createCanvas?: () => HTMLCanvasElement;
  // Khmer script model. When supplied, Khmer text rows are read with it too.
  scriptWorker?: () => Promise<Worker>;
  // Khmer word list that settles split votes between line readings.
  words?: () => Promise<WordList>;
};
const characterCount = (text: string) => text.match(/[\p{L}\p{N}\p{M}]/gu)?.length ?? 0;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

export function preferSlantReading(first: Page, candidate: Page): boolean {
  const khmer = candidate.text.match(/\p{Script=Khmer}/gu)?.length ?? 0;
  return first.confidence < 65 && Number.isFinite(candidate.confidence) &&
    candidate.confidence >= Math.max(65, first.confidence + 15) && khmer >= 4 &&
    characterCount(candidate.text) >= characterCount(first.text) * 0.65;
}

const khmerCount = (text: string) => text.match(/\p{Script=Khmer}/gu)?.length ?? 0;
const digitCount = (text: string) => text.match(/\p{N}/gu)?.length ?? 0;
const latinCount = (text: string) => text.match(/\p{Script=Latin}/gu)?.length ?? 0;
const words = (page: Page) => page.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words))) ?? [];
const confidentEnglish = (page: Page) => words(page).filter((word) => word.confidence >= 85 && /^[A-Za-z]{3,}$/u.test(word.text));
// Weak readings invent digits inside Khmer text, so a raw digit count would
// protect noise. Require confidently read numbers to survive instead.
function retainsNumbers(first: Page, candidate: Page) {
  // Short fragment lines are excluded for the same reason as in substantialText.
  const credible = first.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines))
    .filter((line) => line.text.replace(/\s/gu, '').length >= 4).flatMap((line) => line.words) ?? [];
  const numbers = credible.filter((word) => word.confidence >= 85 && /^[\p{N}\p{P}\p{Sc}]+$/u.test(word.text) && digitCount(word.text) >= 2)
    .map((word) => word.text.replace(/^[^\p{N}]+|[^\p{N}]+$/gu, ''));
  const text = candidate.text.replace(/\s/gu, '');
  return numbers.filter((number) => text.includes(number)).length >= numbers.length * 0.75;
}

// Failed page segmentation shreds a text line into one-to-three character
// "lines", often with high confidence. They are not evidence that a row
// reading omitted text, so retention checks only count substantial lines.
function substantialText(page: Page) {
  const lines = page.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ?? [];
  if (!lines.length) return page.text;
  return lines.filter((line) => line.text.replace(/\s/gu, '').length >= 4).map((line) => line.text).join('\n');
}

// A confident Latin or numeric row needs no Khmer script reading.
export function needsScriptReading(reading: Page): boolean {
  if (!reading.text.trim() || !Number.isFinite(reading.confidence) || reading.confidence < 80) return true;
  return khmerCount(reading.text) > 0 && khmerCount(reading.text) >= latinCount(reading.text);
}

// On isolated Khmer rows the script model is measurably more accurate than
// the language model, while their confidence scores do not rank readings
// reliably. Prefer it unless it visibly lost text, digits or English words.
export function preferScriptLine(first: Page, candidate: Page): boolean {
  if (!candidate.text.trim() || !Number.isFinite(candidate.confidence) || khmerCount(candidate.text) < 2) return false;
  if (!first.text.trim()) return true;
  const before = characterCount(first.text), after = characterCount(candidate.text);
  if (after < before * 0.7 || after > before * 1.5 || !retainsNumbers(first, candidate)) return false;
  const english = confidentEnglish(first);
  return english.filter((word) => candidate.text.toLowerCase().includes(word.text.toLowerCase())).length >= english.length * 0.75;
}

// Extra readings of each Khmer line, combined by character vote with the
// standard script- and language-model readings. Chosen on the scanned and
// typed benchmark pages in test-files/; each one alone is less accurate.
// Levels [40, 200] lighten strokes, [96, 224] darken them.
export const LINE_VARIANTS: readonly { script: boolean; variant: RegionVariant }[] = [
  { script: true, variant: { target: 60, levels: [40, 200] } },
  { script: false, variant: { target: 40, levels: [96, 224] } },
  { script: true, variant: { target: 40 } },
];

// Experimental extra readings, measured with the file benchmark before use:
// OCR_LINE_VARIANTS=sauvola,adaptive (Tesseract's Sauvola / adaptive Otsu).
const EXPERIMENTAL_VARIANTS: Record<string, { script: boolean; variant: RegionVariant }> = {
  sauvola: { script: true, variant: { thresholding: '2' } },
  adaptive: { script: false, variant: { thresholding: '1' } },
};
function lineVariants() {
  const names = String((globalThis as any).process?.env?.OCR_LINE_VARIANTS ?? '').split(',').filter((name) => name in EXPERIMENTAL_VARIANTS);
  return [...LINE_VARIANTS, ...names.map((name) => EXPERIMENTAL_VARIANTS[name])];
}

// Give the combined text the structure of the reading that agrees with it
// most. `base` is that reading's index in `readings`: its boxes are in its own
// crop scale, so callers must map them with that reading's transform.
// The line keeps word boxes only where the voted words line up one-to-one;
// otherwise it gets one word spanning the line, so word rechecks never act on
// text that is no longer there. `uncertain` lists voted spans to show the user.
export type ConsensusPage = Page & { consensus: { base: number; support: number } };
export type UncertainLine = Line & { uncertain?: string[] };

export function withConsensusText(readings: readonly Page[], words?: WordList): ConsensusPage {
  const usable = readings.map((reading, index) => ({ reading, index })).filter(({ reading }) => Number.isFinite(reading.confidence));
  const vote = voteReadings(usable.map(({ reading }) => reading.text), words);
  const text = vote.text;
  const chosen = usable.reduce((best, item) =>
    editDistance(normalizeKhmer(item.reading.text.trim()), text) < editDistance(normalizeKhmer(best.reading.text.trim()), text) ? item : best,
    usable[0] ?? { reading: readings[0], index: 0 });
  const base = chosen.reading;
  const consensus = { base: chosen.index, support: vote.support };
  const lines = base.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ?? [];
  if (!text || lines.length !== 1) return { ...base, consensus };
  const uncertain = uncertainSpans(text, vote.disputed);
  // Agreement between readings is a better confidence than the base reading's score.
  const confidence = Math.min(lines[0].confidence, Math.round(vote.support * 100));
  const tokens = text.split(/\s+/u).filter(Boolean);
  const wordsKept = lines[0].words.length === tokens.length
    ? lines[0].words.map((word, index) => ({ ...word, text: tokens[index] }))
    : [{ ...(lines[0].words[0] ?? {}), text, bbox: lines[0].bbox, confidence, symbols: [] } as unknown as Line['words'][number]];
  const line: UncertainLine = { ...lines[0], text: text + '\n', confidence, words: wordsKept, ...(uncertain.length ? { uncertain } : {}) };
  const paragraph = { ...base.blocks![0].paragraphs[0], lines: [line], text: text + '\n' };
  return { ...base, consensus, text: text + '\n', blocks: [{ ...base.blocks![0], paragraphs: [paragraph], text: text + '\n' }] };
}

// Khmer has no spaces between words, so a whole space-separated token can be a
// phrase. Show the disputed letters with up to two clusters of context.
export function uncertainSpans(text: string, disputed: readonly [number, number][]): string[] {
  const chars = [...text];
  const offsets: number[] = []; // code-unit offset of each code point
  let unit = 0; for (const char of chars) { offsets.push(unit); unit += char.length; }
  const clusterStart = (index: number) => /[\u1780-\u17B3]/u.test(chars[index]) && !(index > 0 && chars[index - 1] === '\u17D2');
  const spans: string[] = [];
  for (const [start, end] of disputed) {
    let from = offsets.findIndex((offset) => offset >= start); if (from < 0) from = chars.length - 1;
    let to = Math.max(from, offsets.findIndex((offset) => offset >= end) - 1); if (to < 0) to = chars.length - 1;
    for (let clusters = 0; from > 0 && !/\s/u.test(chars[from - 1]) && clusters < 3; ) { from--; if (clusterStart(from)) clusters++; }
    for (let clusters = 0; to + 1 < chars.length && !/\s/u.test(chars[to + 1]); ) { if (clusterStart(to + 1) && ++clusters > 2) break; to++; }
    const span = chars.slice(from, to + 1).join('').trim();
    if (/\p{Script=Khmer}/u.test(span) && !spans.includes(span)) spans.push(span);
  }
  return spans;
}

// Five readings already outvote isolated mistakes, including noise that one
// model reads as Khmer letters (ruled lines, specks). Only protect what the
// language reading recognized confidently: numbers and English words.
export function preferConsensusLine(first: Page, combined: Page): boolean {
  if (!Number.isFinite(combined.confidence)) return false;
  if (!first.text.trim()) return Boolean(combined.text.trim());
  const english = confidentEnglish(first);
  return retainsNumbers(first, combined) &&
    english.filter((word) => combined.text.toLowerCase().includes(word.text.toLowerCase())).length >= english.length * 0.75;
}

export function preferRowReading(first: Page, candidate: Page, completedRows: number, expectedRows: number, contents: boolean): boolean {
  // Every region with text evidence must have a reading: coverPageLines fills
  // missing rows from the page reading, so a gap here means text was lost.
  if (!candidate.text.trim() || completedRows < expectedRows || !Number.isFinite(candidate.confidence)) return false;
  // Very weak contents readings mistake the dot leaders for letters/digits.
  // Do not require those artifacts to survive a complete row repair.
  if (contents && first.confidence < 75) return candidate.confidence >= Math.max(75, first.confidence + 15);
  if (contents && candidate.confidence < 60) return false;
  // Rows are the primary reading: isolated lines avoid page-segmentation
  // failures. Reject them only when they visibly lost text. Confidence alone
  // rewards a short reading that omitted difficult text, and does not rank
  // readings from different passes reliably.
  const reference = substantialText(first);
  if (khmerCount(candidate.text) < khmerCount(reference) * 0.85 || !retainsNumbers(first, candidate)) return false;
  if (!contents && (characterCount(candidate.text) < characterCount(reference) * 0.85 ||
      (candidate.confidence < 60 && candidate.confidence < first.confidence - 15))) return false;
  const english = confidentEnglish(first);
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
  // Pieces of one row split at wide gaps go back onto one line.
  const joins = (index: number) => index > 0 && nonempty[index].region.segmentOf !== undefined &&
    nonempty[index].region.segmentOf === nonempty[index - 1].region.segmentOf;
  const pitch = median(nonempty.slice(1).flatMap((reading, index) => joins(index + 1) ? [] : [reading.region.top - nonempty[index].region.top]));
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
    const joined = joins(index);
    // A line with wide gaps is a heading or header, never part of a wrapped paragraph.
    const boundary = !joined && (region.segmentOf !== undefined || previous?.region.segmentOf !== undefined) ||
      !previous || contents || region.listStart ||
      region.top - previous.region.top > pitch * 1.4 ||
      region.left > bodyLeft + height * 0.8 ||
      Math.max(region.height, previous.region.height) > Math.min(region.height, previous.region.height) * 1.4 ||
      /^\s*(?:[-+•]|[0-9០-៩]+[.)])\s*\S/u.test(data.text);
    if (boundary && !joined) groups.push({ lines: [], regions: [] });
    const group = groups[groups.length - 1];
    group.regions.push(region);
    const mapped: Line[] = [];
    for (const block of data.blocks ?? []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
      mapped.push({ ...line, bbox: shifted(line.bbox, reading),
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
    const last = group.lines.at(-1);
    if (joined && last && mapped.length) {
      const all = [last, ...mapped], letters = all.map((line) => Math.max(1, characterCount(line.text)));
      group.lines[group.lines.length - 1] = { ...last,
        text: all.map((line) => line.text.trim()).filter(Boolean).join(' ') + '\n',
        confidence: all.reduce((sum, line, at) => sum + line.confidence * letters[at], 0) / letters.reduce((sum, count) => sum + count, 0),
        words: all.flatMap((line) => line.words),
        bbox: { x0: Math.min(...all.map((line) => line.bbox.x0)), y0: Math.min(...all.map((line) => line.bbox.y0)),
          x1: Math.max(...all.map((line) => line.bbox.x1)), y1: Math.max(...all.map((line) => line.bbox.y1)) },
        ...(all.some((line) => (line as UncertainLine).uncertain) ? { uncertain: all.flatMap((line) => (line as UncertainLine).uncertain ?? []) } : {}),
      } as Line;
    } else group.lines.push(...mapped);
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
    if (reading.region.segmentOf !== undefined) continue; // One piece must not replace a whole line.
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

const pageLines = (page: Page) => page.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines)) ?? [];
const hasText = (page: Page) => pageLines(page).some((line) => line.text.trim());
const substantial = (line: Line) => line.text.replace(/\s/gu, '').length >= 4;

// Lines of a page reading that belong to a row region (centre inside it, most
// of the narrower width overlapping).
export function linesInRegion(page: Page, region: TextRegion): Line[] {
  return pageLines(page).filter((line) => {
    const center = (line.bbox.y0 + line.bbox.y1) / 2;
    const overlap = Math.min(line.bbox.x1, region.left + region.width) - Math.max(line.bbox.x0, region.left);
    return line.text.trim() && center >= region.top && center <= region.top + region.height &&
      overlap >= Math.min(line.bbox.x1 - line.bbox.x0, region.width) * 0.5;
  });
}

// Present page-reading lines as a row reading, so combineRowReadings maps them
// back to the same place (crop coordinates: 16 px border, scale 1).
export function pageLinesReading(base: Page, region: TextRegion, lines: Line[]): RowReading {
  const box = (b: Bbox): Bbox => ({ x0: b.x0 - region.left + 16, y0: b.y0 - region.top + 16, x1: b.x1 - region.left + 16, y1: b.y1 - region.top + 16 });
  const shifted = lines.map((line) => ({ ...line, bbox: box(line.bbox), baseline: line.baseline ? box(line.baseline) : line.baseline,
    words: line.words.map((word) => ({ ...word, bbox: box(word.bbox), symbols: word.symbols?.map((symbol) => ({ ...symbol, bbox: box(symbol.bbox) })) })) }));
  const text = shifted.map((line) => line.text.trimEnd()).join('\n') + '\n';
  const weight = shifted.reduce((sum, line) => sum + Math.max(1, characterCount(line.text)), 0);
  const confidence = shifted.reduce((sum, line) => sum + line.confidence * Math.max(1, characterCount(line.text)), 0) / weight;
  const bbox = { x0: 16, y0: 16, x1: 16 + region.width, y1: 16 + region.height };
  return { region, scale: 1, data: { ...base, text, confidence,
    blocks: [{ ...base.blocks?.[0], bbox, text, confidence, blocktype: 'FLOWING_TEXT', page: base,
      paragraphs: [{ lines: shifted, text, confidence, bbox, is_ltr: true }] }] } as Page };
}

// Make sure no line the page reading found is lost by the row pass:
// a row reading that came back empty, or with under half the letters the page
// reading has there, is replaced by the page lines; page lines outside every
// row region are inserted in reading order. Returns readings and how many
// regions have text evidence at all (blank regions are specks or rules).
export function coverPageLines(page: Page, readings: RowReading[], contents: boolean): { readings: RowReading[]; expected: number } {
  const used = new Set<Line>();
  let expected = 0;
  const covered = readings.map((reading) => {
    const lines = linesInRegion(page, reading.region);
    lines.forEach((line) => used.add(line));
    // A piece of a split row is only answerable for page lines that lie mostly inside it.
    const { region } = reading;
    const evidence = lines.filter(substantial).filter((line) => region.segmentOf === undefined ||
      Math.min(line.bbox.x1, region.left + region.width) - Math.max(line.bbox.x0, region.left) >= (line.bbox.x1 - line.bbox.x0) * 0.6);
    const empty = !hasText(reading.data);
    if (!empty || evidence.length) expected++;
    if (!evidence.length) return reading;
    const before = evidence.reduce((sum, line) => sum + characterCount(line.text), 0);
    const confident = evidence.reduce((sum, line) => sum + line.confidence, 0) / evidence.length >= 70;
    // Dot leaders read as letters in weak contents readings; only fill gaps there.
    if (empty || (!contents && confident && characterCount(reading.data.text) < before * 0.5)) return pageLinesReading(page, reading.region, region.segmentOf === undefined ? lines : evidence);
    return reading;
  });
  for (const line of pageLines(page)) {
    // Pixel row detection found no text there, so require a confident reading:
    // weak page lines outside every row are usually noise read as letters.
    if (used.has(line) || !substantial(line) || line.confidence < 70) continue;
    const region: TextRegion = { left: Math.floor(line.bbox.x0), top: Math.floor(line.bbox.y0),
      width: Math.ceil(line.bbox.x1 - line.bbox.x0), height: Math.ceil(line.bbox.y1 - line.bbox.y0) };
    const center = (line.bbox.y0 + line.bbox.y1) / 2;
    const at = covered.findIndex(({ region: other }) => other.top > center &&
      Math.min(other.left + other.width, line.bbox.x1) - Math.max(other.left, line.bbox.x0) > 0);
    covered.splice(at < 0 ? covered.length : at, 0, pageLinesReading(page, region, [line]));
    expected++;
  }
  return { readings: covered, expected };
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
    eraseRules(image.data, canvas.width, canvas.height);
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
  const tryRows = rows.length >= 1 && rows.length <= 400;
  if (tryRows) {
    const typicalHeight = median(rows.map((row) => row.height));
    // Headings side by side and running headers: read each piece on its own.
    // Rows holding several text lines are read as blocks and stay whole.
    try { rows = rows.flatMap((row, index) => row.height > typicalHeight * 1.8 && countTextLines(canvas, row) > 1 ? [row] : splitWideGaps(canvas, row, index)); }
    catch { hooks.checkAbort(); }
    const khmerContext = options.language !== 'eng' && (data.text.match(/\p{Script=Khmer}/gu)?.length ?? 0) >= 20;
    let slantRetries = 0;
    let script: Worker | undefined, scriptFailed = false;
    let wordList: Promise<WordList | undefined> | undefined;
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
            // Height alone does not make a block: a large heading is one
            // tall line, and as a line it is also read by the vote below.
            tessedit_pageseg_mode: region.height > typicalHeight * 1.8 && countTextLines(canvas, region) > 1 ? PSM.SINGLE_BLOCK : PSM.SINGLE_LINE,
          };
          let result = await worker.recognize(crop, rowParameters, output);
          let resultScale = prepared.scale;
          if (hooks.scriptWorker && options.language !== 'eng' && !scriptFailed && needsScriptReading(result.data)) {
            hooks.checkAbort();
            try {
              script ??= await hooks.scriptWorker();
              const alternative = await script.recognize(crop, rowParameters, output);
              if (rowParameters.tessedit_pageseg_mode !== PSM.SINGLE_LINE) {
                if (preferScriptLine(result.data, alternative.data)) result = alternative;
              } else {
                // Script reading first: it wins ties in the character vote.
                const readings = [alternative.data, result.data];
                // Each reading's own crop scale: the vote may pick any of them as the base.
                const scales = [prepared.scale, prepared.scale];
                // Stop once three readings are identical: the remaining ones can
                // no longer outvote them. (Two agreeing models can still share a
                // mistake, such as a stray space, that a third reading corrects.)
                const variants = lineVariants();
                const settled = () => {
                  if ((globalThis as any).process?.env?.OCR_ALWAYS_VOTE) return false;
                  const counts = new Map<string, number>();
                  for (const reading of readings) { const text = normalizeKhmer(reading.text.trim()); counts.set(text, (counts.get(text) ?? 0) + 1); }
                  return Math.max(...counts.values()) >= Math.max(3, Math.floor((2 + variants.length) / 2) + 1);
                };
                for (const { script: useScript, variant } of variants) {
                  if (settled()) break;
                  hooks.checkAbort();
                  const extra = prepareTextRegion(canvas, region, options.language, createCanvas, 0, variant);
                  try {
                    const extraParameters: Parameters = { ...rowParameters,
                      user_defined_dpi: String(Math.max(70, Math.round(Number(parameters.user_defined_dpi ?? options.dpi) * extra.scale))),
                      ...(variant.thresholding ? { thresholding_method: variant.thresholding } : {}) };
                    readings.push((await (useScript ? script : worker).recognize(extra.canvas, extraParameters, output)).data);
                    scales.push(extra.scale);
                  } catch { hooks.checkAbort(); } // Fewer readings still vote.
                  finally { extra.canvas.width = extra.canvas.height = 0; }
                }
                // Without the word list the plain vote still applies.
                wordList ??= hooks.words?.().catch(() => undefined) ?? Promise.resolve(undefined);
                const combined = withConsensusText(readings, await wordList);
                // Keep the guard against losing numbers or English words.
                if (preferConsensusLine(result.data, combined)) { result = { ...result, data: combined }; resultScale = scales[combined.consensus.base]; }
              }
            } catch { hooks.checkAbort(); scriptFailed = true; } // The language reading remains usable.
          }
          if (!hasText(result.data)) {
            // A missing row gets one more try with the other segmentation mode.
            hooks.checkAbort();
            try {
              const retryParameters: Parameters = { ...rowParameters,
                tessedit_pageseg_mode: rowParameters.tessedit_pageseg_mode === PSM.SINGLE_LINE ? PSM.SINGLE_BLOCK : PSM.SINGLE_LINE };
              const retry = await worker.recognize(crop, retryParameters, output);
              if (hasText(retry.data)) { result = retry; resultScale = prepared.scale; }
            } catch { hooks.checkAbort(); }
          }
          let selected: RowReading = { region, data: result.data, scale: resultScale };
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
      const { readings: covered, expected } = coverPageLines(data, readings, contents);
      const candidate = combineRowReadings(data, covered, contents);
      const completed = covered.filter((reading) => hasText(reading.data)).length;
      if (preferRowReading(data, candidate, completed, expected, contents)) return preserveRegionParagraphs(candidate, rows);
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

