// Put Khmer text into one standard character order. NFC does not reorder
// Khmer, so OCR readings that render identically (a vowel typed before a
// subscript, coeng-ro before another subscript, a split two-part vowel) still
// differ code point by code point. Votes, dictionary lookups and scoring must
// all compare the same encoding. Only order changes; no letter is added or lost
// (except invisible inherent-vowel marks U+17B4/U+17B5, which carry no glyph).

const BASE = /[ក-ឳ]/u;
const CONSONANT = /[ក-អ]/u;
const COENG = '្';
const RO = 'រ';
const ROBAT = '៌';
const SHIFTER = /[៉៊]/u;
const VOWEL = /[ា-ៅ]/u;
const SIGN = /[ំ-ៈ់៍-៑៓៝]/u;

function reorderCluster(base: string, marks: string[]): string {
  const robat: string[] = [], subscripts: string[] = [], roSubscripts: string[] = [];
  const shifters: string[] = [], vowels: string[] = [], signs: string[] = [];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark === COENG && i + 1 < marks.length && CONSONANT.test(marks[i + 1])) {
      (marks[i + 1] === RO ? roSubscripts : subscripts).push(COENG + marks[i + 1]);
      i++;
    } else if (mark === ROBAT) robat.push(mark);
    else if (SHIFTER.test(mark)) shifters.push(mark);
    else if (VOWEL.test(mark)) vowels.push(mark);
    else if (SIGN.test(mark)) signs.push(mark);
    else return base + marks.join(''); // Unknown pattern: leave it untouched.
  }
  return base + robat.join('') + subscripts.join('') + roSubscripts.join('') + shifters.join('') + vowels.join('') + signs.join('');
}

export function normalizeKhmer(text: string): string {
  const chars = [...text.normalize('NFC').replace(/[឴឵]/gu, '')
    // Two-part vowels typed as two code points.
    .replace(/េី/gu, 'ើ').replace(/េា/gu, 'ោ')];
  let output = '';
  for (let i = 0; i < chars.length;) {
    if (!BASE.test(chars[i])) { output += chars[i++]; continue; }
    const base = chars[i++];
    const marks: string[] = [];
    while (i < chars.length) {
      const char = chars[i];
      // A coeng followed by a consonant belongs to this cluster; a bare base does not.
      if (char === COENG && i + 1 < chars.length && CONSONANT.test(chars[i + 1])) { marks.push(char, chars[i + 1]); i += 2; continue; }
      if (char === COENG || char === ROBAT || SHIFTER.test(char) || VOWEL.test(char) || SIGN.test(char)) { marks.push(char); i++; continue; }
      break;
    }
    output += reorderCluster(base, marks);
  }
  // Reordering can bring the halves of a split vowel together.
  return joinVowels(output);
}

// Two-part vowels typed as two code points.
const joinVowels = (text: string) => text.replace(/\u17C1\u17B8/gu, '\u17BE').replace(/\u17C1\u17B6/gu, '\u17C4');
