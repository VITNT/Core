// Khmer word list used to settle disagreements between line readings. It is
// the word list inside tessdata_best's khm.traineddata (Apache 2.0),
// extracted with combine_tessdata and dawg2wordlist, one word per line.

import { normalizeKhmer } from './khmer-normalize';

export type WordList = { has(word: string): boolean; readonly maxLength: number; readonly entries?: readonly string[] };

export function parseWordList(text: string): WordList {
  const words = new Set<string>();
  let maxLength = 0;
  for (const line of text.split('\n')) {
    const word = normalizeKhmer(line.trim());
    if (word.length < 2) continue;
    words.add(word);
    maxLength = Math.max(maxLength, word.length);
  }
  return { has: (word) => words.has(word), maxLength, entries: [...words] };
}

const KHMER_RUN = /[ក-៓៝]+/gu;

// Split a run of Khmer letters (no spaces between words) into dictionary
// words, covering as many letters as possible with as few pieces as possible.
function segmentRun(run: string, words: WordList): [uncovered: number, pieces: number] {
  const best: [number, number][] = [[0, 0]];
  for (let end = 1; end <= run.length; end++) {
    let choice: [number, number] | undefined;
    for (let start = Math.max(0, end - words.maxLength); start < end; start++) {
      const known = end - start >= 2 && words.has(run.slice(start, end));
      if (!known && end - start > 1) continue;
      const [uncovered, pieces] = best[start];
      const score: [number, number] = [uncovered + (known ? 0 : 1), pieces + 1];
      if (!choice || score[0] < choice[0] || (score[0] === choice[0] && score[1] < choice[1])) choice = score;
    }
    best.push(choice!);
  }
  return best[run.length];
}

// Lower is better: letters outside any known word, then number of pieces.
export function dictionaryScore(text: string, words: WordList, cache = new Map<string, [number, number]>()): [number, number] {
  let uncovered = 0, pieces = 0;
  for (const [run] of text.matchAll(KHMER_RUN)) {
    let score = cache.get(run);
    if (!score) { score = segmentRun(run, words); cache.set(run, score); }
    uncovered += score[0]; pieces += score[1];
  }
  return [uncovered, pieces];
}

// Letters that printed Khmer fonts draw alike, in groups.
const LOOKALIKES = ['ីឺ៏៍', 'ិឹ', 'ឹឺ', 'ុូ', 'ូួ', 'ដជគ', 'ពភ', 'ទម', '៖ះ'].map((group) => [...group]);
export const lookalikes = (letter: string) => [...new Set(LOOKALIKES.filter((group) => group.includes(letter)).flat())]
  .filter((other) => other !== letter && other !== '៖');

const CONSONANT = /[ក-អ]/u, MARK = /[ា-៑៓៝]/u;

// The single dictionary word nearest to a short piece of text that stands
// alone (a heading, a label, a list item). Heading fonts are misread letter
// by letter in the same way by every reading, but a heading is usually one
// dictionary entry, and few entries are close to it. The word must have the
// same length, the same subscript structure, and differ only by vowels or
// signs (cost 1 each), look-alike consonants (1) or one other consonant (2),
// with a total cost of at most 3. A letter that some reading saw at that
// place (`seen`) costs nothing. Nothing is returned when two words are equally
// near.
export function nearestWord(run: string, words: WordList, seen?: (index: number, letter: string) => boolean): string | undefined {
  const letters = [...run];
  if (!words.entries || letters.length < 5 || words.has(run)) return undefined;
  let best: string | undefined, bestCost = 4, tied = false;
  for (const word of words.entries) {
    if (word.length !== run.length) continue;
    let cost = 0, other = 0;
    for (let i = 0; i < letters.length && cost < 4; i++) {
      const a = letters[i], b = word[i];
      if (a === b || seen?.(i, b)) continue;
      if (MARK.test(a) && MARK.test(b)) cost += 1;
      else if (CONSONANT.test(a) && CONSONANT.test(b)) { if (lookalikes(a).includes(b)) cost += 1; else { cost += 2; other++; } }
      else cost = 4;
    }
    if (cost > 3 || other > 1) continue;
    if (cost < bestCost) { best = word; bestCost = cost; tied = false; }
    else if (cost === bestCost) tied = true;
  }
  return tied ? undefined : best;
}
