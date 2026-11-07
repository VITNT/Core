import type { Bbox, Line, Word } from 'tesseract.js';

type TextWord = Pick<Word, 'text' | 'confidence' | 'bbox'>;
type TextLine = Pick<Line, 'text' | 'bbox'> & { words: readonly TextWord[] };
export type RecognitionText = {
  text: string;
  blocks: readonly { paragraphs: readonly { lines: readonly TextLine[] }[] }[] | null;
};
export type RecheckWord = TextWord & { start: number; end: number; lineBbox: Bbox };
type Alternative = { text: string; confidence: number };
const latin = /\p{Script=Latin}/u;
const khmerLetters = /[\u1780-\u17b3]/gu;
const MAX_RECHECKS = 12;

export function findRecheckWords(data: RecognitionText): RecheckWord[] {
  const candidates: RecheckWord[] = [];
  let cursor = 0;
  for (const block of data.blocks ?? []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
    const lineText = line.text.trimEnd();
    if (!lineText) continue;
    const lineStart = data.text.indexOf(lineText, cursor);
    // Fail closed if structured OCR and plain text do not agree. Never replace
    // a different occurrence of a word just because it has the same spelling.
    if (lineStart < 0) continue;
    const lineEnd = lineStart + lineText.length;
    cursor = lineEnd;
    const latinWords = line.words.filter((word) => latin.test(word.text));
    if ((lineText.match(khmerLetters)?.length ?? 0) < 6 || latinWords.length > 2) continue;
    let wordCursor = lineStart;
    for (const word of line.words) {
      const start = data.text.indexOf(word.text, wordCursor);
      if (start < 0 || start + word.text.length > lineEnd) break;
      wordCursor = start + word.text.length;
      // Preserve confident English, URLs, acronyms and English phrases.
      // An uncertain isolated Latin word in a Khmer line is only a candidate
      // for another visual read, never a reason to delete it.
      if (!Number.isFinite(word.confidence) || word.confidence >= 80 || /^[A-Z]{2,5}$/u.test(word.text) ||
          !/^[\p{Script=Latin}\p{M}]{2,12}$/u.test(word.text)) continue;
      candidates.push({ ...word, start, end: wordCursor, lineBbox: line.bbox });
    }
  }
  return candidates;
}

export function recheckCrop(word: RecheckWord, width: number, height: number) {
  const { bbox, lineBbox } = word;
  if (![width, height, ...Object.values(bbox), ...Object.values(lineBbox)].every(Number.isFinite) ||
      bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0 || lineBbox.y1 <= lineBbox.y0) return;
  const padding = Math.max(2, Math.round((lineBbox.y1 - lineBbox.y0) * 0.1));
  const left = Math.max(0, Math.floor(bbox.x0 - padding));
  const top = Math.max(0, Math.floor(lineBbox.y0 - padding));
  const right = Math.min(width, Math.ceil(bbox.x1 + padding));
  const bottom = Math.min(height, Math.ceil(lineBbox.y1 + padding));
  if (right <= left || bottom <= top) return;
  const cropWidth = right - left, cropHeight = bottom - top;
  // Enlarge small text without allowing a malformed box to allocate a huge canvas.
  const scale = Math.min(3, Math.max(1, 80 / cropHeight), Math.sqrt(2_000_000 / (cropWidth * cropHeight)));
  return { left, top, width: cropWidth, height: cropHeight, scale };
}

export async function reviewOcrText(
  data: RecognitionText,
  recheck: (word: RecheckWord, index: number, total: number) => Promise<Alternative | undefined>
) {
  const candidates = findRecheckWords(data);
  const replacements: { start: number; end: number; text: string }[] = [];
  const reviewWords: string[] = [];
  for (const [index, word] of candidates.entries()) {
    const alternative = index < MAX_RECHECKS ? await recheck(word, index, Math.min(candidates.length, MAX_RECHECKS)) : undefined;
    const text = alternative?.text.trim().normalize('NFC') ?? '';
    // Scores are heuristics, not probabilities. Require a strong Khmer reading
    // from the same mixed-language engine; do not force English into Khmer.
    if (alternative && Number.isFinite(alternative.confidence) && alternative.confidence >= 85 &&
        alternative.confidence >= word.confidence + 20 &&
        (text.match(khmerLetters)?.length ?? 0) >= 2 && text.length <= 60 &&
        /^[\p{Script=Khmer}\p{N}\p{P} ]+$/u.test(text)) {
      replacements.push({ start: word.start, end: word.end, text });
    } else {
      reviewWords.push(word.text);
    }
  }
  let text = data.text;
  for (const replacement of replacements.reverse()) {
    text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
  }
  return { text, reviewWords: [...new Set(reviewWords)] };
}
