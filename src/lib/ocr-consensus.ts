// Combine several independent readings of the same text line. Each reading
// (different model, scale or stroke weight) makes different mistakes on
// scanned Khmer, so a character-level majority is more accurate than any one
// reading or than choosing by Tesseract confidence. Every output character
// comes from at least one reading of the pixels; nothing is invented.

import { dictionaryScore, lookalikes, nearestWord, type WordList } from './ocr-dictionary';
import { normalizeKhmer } from './khmer-normalize';

function distanceTable(a: readonly string[], b: readonly string[]) {
  const table: Uint16Array[] = [];
  for (let i = 0; i <= a.length; i++) {
    const row = new Uint16Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) {
      row[j] = i === 0 ? j : j === 0 ? i
        : Math.min(table[i - 1][j] + 1, row[j - 1] + 1, table[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
    }
    table.push(row);
  }
  return table;
}

export function editDistance(a: string, b: string) {
  const x = [...a], y = [...b];
  return distanceTable(x, y)[x.length][y.length];
}

// The reading closest to all others is the alignment pivot.
export function medoidIndex(texts: readonly string[]) {
  let best = 0, bestScore = Infinity;
  for (const [index, text] of texts.entries()) {
    const score = texts.reduce((sum, other) => sum + editDistance(text, other), 0);
    if (score < bestScore) { best = index; bestScore = score; }
  }
  return best;
}

// support: average share of readings that agree with each chosen character
// (1 = all readings identical). disputed: [start, end) spans of the returned
// text where no option had a strict majority, or the word list overrode the
// vote. A zero-width span marks a letter some readings had and the vote dropped.
export type Consensus = { text: string; support: number; disputed: [number, number][] };

export function consensusText(readings: readonly string[], words?: WordList): string {
  return voteReadings(readings, words).text;
}

export function voteReadings(readings: readonly string[], words?: WordList): Consensus {
  const texts = readings.map((text) => normalizeKhmer(text.trim()));
  if (texts.length < 3) {
    const text = texts[medoidIndex(texts)] ?? '';
    const same = texts.every((other) => other === text);
    return { text, support: same ? 1 : 0.5, disputed: same || !text ? [] : [[0, text.length]] };
  }
  const pivot = [...texts[medoidIndex(texts)]];
  // Slot 2k holds insertions before pivot character k; slot 2k+1 holds what
  // each reading has in place of pivot character k ('' for a deletion).
  const slots = Array.from({ length: pivot.length * 2 + 1 }, () => new Map<string, number>());
  for (const text of texts) {
    const other = [...text];
    const table = distanceTable(pivot, other);
    const inserted = new Map<number, string>();
    let i = pivot.length, j = other.length;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && table[i][j] === table[i - 1][j - 1] + Number(pivot[i - 1] !== other[j - 1])) {
        const slot = slots[(i - 1) * 2 + 1]; slot.set(other[j - 1], (slot.get(other[j - 1]) ?? 0) + 1); i--; j--;
      } else if (i > 0 && table[i][j] === table[i - 1][j] + 1) {
        const slot = slots[(i - 1) * 2 + 1]; slot.set('', (slot.get('') ?? 0) + 1); i--;
      } else {
        inserted.set(i, other[j - 1] + (inserted.get(i) ?? '')); j--;
      }
    }
    for (let k = 0; k <= pivot.length; k++) {
      const value = inserted.get(k) ?? '';
      slots[k * 2].set(value, (slots[k * 2].get(value) ?? 0) + 1);
    }
  }
  // Plurality per slot. Ties go to the earliest reading, so callers list the
  // most reliable reading first. (A strict-majority rule measured worse.)
  const choice = slots.map((slot) => {
    let value = '', votes = -1;
    for (const [option, count] of slot) if (count > votes) { value = option; votes = count; }
    return value;
  });
  const voted = [...choice];
  if (words) { chooseKnownWords(slots, choice, words); completeKnownWords(slots, choice, words); }
  const joined = choice.join('');
  const lead = joined.length - joined.trimStart().length;
  let text = joined.trim();
  let offset = 0, agreement = 0, counted = 0;
  const disputed: [number, number][] = [];
  for (const [index, value] of choice.entries()) {
    const votes = slots[index].get(value) ?? 0;
    // Insertion slots that every reading left empty carry no evidence.
    if (index % 2 === 1 || value || votes < texts.length) { agreement += votes / texts.length; counted++; }
    const contested = votes * 2 <= texts.length || value !== voted[index];
    const start = Math.min(text.length, Math.max(0, offset - lead));
    const end = Math.min(text.length, Math.max(0, offset + value.length - lead));
    if (contested && /\S/u.test([...slots[index].keys()].join(''))) disputed.push([start, end]);
    offset += value.length;
  }
  // A short piece standing alone (one run of Khmer letters, perhaps with a
  // number or bullet) is checked against the word list as a whole.
  const alone = words && /^[^\u1780-\u17D3\u17DD]*([\u1780-\u17D3\u17DD]{5,16})[^\u1780-\u17D3\u17DD]*$/u.exec(text);
  const owner = choice.flatMap((value, index) => Array.from(value, () => index)); // Slot of each letter (Khmer letters are one code unit).
  const at = alone ? text.indexOf(alone[1]) : -1;
  const nearest = alone && nearestWord(alone[1], words, (index, letter) => {
    const slot = owner[lead + at + index];
    return slot % 2 === 1 && slots[slot].has(letter);
  });
  if (alone && nearest) {
    text = text.slice(0, at) + nearest + text.slice(at + nearest.length);
    disputed.push([at, at + nearest.length]);
  }
  return { text, support: counted ? agreement / counted : 1, disputed };
}

// Where readings disagree, an option that at least two readings saw may beat
// the plurality if it turns more of the line into dictionary words. Scanned
// Khmer often splits votes between look-alike vowels and subscripts, and the
// vote alone cannot tell which is a word. Ties keep the plurality choice.
// Only one letter may replace another: whether a letter is there at
// all stays with the vote, because dropping an unknown letter or adding one
// to complete a word would always look better to the dictionary.
function chooseKnownWords(slots: readonly Map<string, number>[], choice: string[], words: WordList) {
  const disputed = slots.flatMap((slot, index) => {
    const letters = (value: string) => /^\S+$/u.test(value); // Spaces count as absent.
    if (!letters(choice[index])) return [];
    // A Latin option must not replace Khmer: the word list ignores Latin, so
    // it would always look like fewer unknown letters.
    const khmer = /^[\u1780-\u17DD]+$/u.test(choice[index]);
    const options = [...slot].filter(([option, count]) => count >= 2 && letters(option) && option !== choice[index] &&
      (!khmer || /^[\u1780-\u17DD]+$/u.test(option))).map(([option]) => option);
    return options.length ? [{ index, options }] : [];
  });
  if (!disputed.length) return;
  const cache = new Map<string, [number, number]>();
  const score = () => {
    const [uncovered, pieces] = dictionaryScore(choice.join(''), words, cache);
    const votes = disputed.reduce((sum, { index }) => sum + (slots[index].get(choice[index]) ?? 0), 0);
    return [uncovered, pieces, -votes];
  };
  const better = (a: number[], b: number[]) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const { index, options } of disputed) {
      const current = choice[index];
      let best = score(), bestOption = current;
      for (const option of options) {
        choice[index] = option;
        const candidate = score();
        if (better(candidate, best)) { best = candidate; bestOption = option; }
      }
      choice[index] = bestOption;
      changed ||= bestOption !== current;
    }
    if (!changed) break;
  }
  // Two neighbouring letters can be wrong together (គឺ read for កំ): neither
  // change alone makes a word, so try them as a pair.
  for (const [at, first] of disputed.entries()) {
    const second = disputed[at + 1];
    if (!second || second.index - first.index > 4) continue;
    const before = [choice[first.index], choice[second.index]];
    let best = score(), bestPair = before;
    for (const a of first.options) for (const b of second.options) {
      choice[first.index] = a; choice[second.index] = b;
      const candidate = score();
      if (better(candidate, best)) { best = candidate; bestPair = [a, b]; }
    }
    [choice[first.index], choice[second.index]] = bestPair;
  }
}

// Only look-alike letters (see ocr-dictionary) may replace a letter that no
// reading saw. Allowing any consonant or vowel changed correct text on the
// benchmark pages (15 wrong changes in 78 lines), and ត/ល alone changed three.
// Second dictionary step. Look-alike letters (ះ and ៖, ី and ៏, a subscript ម
// and ទ) are often misread the same way by most or all readings, so the vote
// cannot correct them. For each letter, try a letter that only one reading
// saw, or a look-alike that no reading saw. A change is kept only if the line
// then splits into fewer, longer known words without leaving more letters
// outside known words. (The word list has many short fragments such as ខ្ល and
// កី, so "is it a word" alone decides nothing.) A look-alike no reading saw
// must also be the only replacement that does equally well. Letters are never
// added or removed.
function completeKnownWords(slots: readonly Map<string, number>[], choice: string[], words: WordList) {
  const cache = new Map();
  const changed = new Set<number>();
  const letter = (value: string) => /^[\u1780-\u17D3\u17D6\u17DD]$/u.test(value);
  for (let pass = 0; pass < 3; pass++) {
    const before = dictionaryScore(choice.join(''), words, cache);
    let best: { index: number; option: string; gain: number; votes: number } | undefined, ties = 0;
    for (let index = 1; index < choice.length; index += 2) {
      const current = choice[index];
      if (!letter(current) || changed.has(index)) continue; // One change per letter: no chains of look-alikes.
      const options = new Map<string, number>();
      for (const [option, count] of slots[index]) if (option !== current && option !== '៖' && letter(option)) options.set(option, count);
      for (const option of lookalikes(current)) if (!options.has(option)) options.set(option, 0);
      for (const [option, votes] of options) {
        choice[index] = option;
        const after = dictionaryScore(choice.join(''), words, cache);
        const gain = after[0] > before[0] ? 0 : (before[0] - after[0]) * 4 + before[1] - after[1];
        if (gain < 1) continue;
        if (!best || gain > best.gain || (gain === best.gain && votes > best.votes)) { best = { index, option, gain, votes }; ties = 0; }
        else if (gain === best.gain && votes === best.votes) ties++;
      }
      choice[index] = current;
    }
    if (!best || (best.votes === 0 && ties > 0)) return;
    choice[best.index] = best.option;
    changed.add(best.index);
  }
}
