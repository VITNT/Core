import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRecheckWords, recheckCrop, reviewOcrText, type RecognitionText } from '../src/lib/ocr-review';

const khmer = 'ខ្ញុំយល់ព្រមទទួលខុសត្រូវ';
const corrected = 'អំឡុងពេល';
function recognition(lines: string[], confidence = 40): RecognitionText {
  return {
    text: lines.join('\n') + '\n',
    blocks: [{ paragraphs: [{ lines: lines.map((text, row) => ({
      text: text + '\n',
      bbox: { x0: 0, x1: 500, y0: row * 40, y1: row * 40 + 30 },
      words: text.split(' ').map((word, index) => ({
        text: word, confidence: /[A-Za-z]/u.test(word) ? confidence : 95,
        bbox: { x0: index * 80, x1: index * 80 + 60, y0: row * 40 + 5, y1: row * 40 + 25 }
      }))
    })) }] }]
  };
}

test('re-reads a misclassified Latin word from Khmer and preserves the English heading', async () => {
  const data = recognition(['Technovation Girls Cambodia x Future Digital Talents 2026', `${khmer} Hein`]);
  const seen: string[] = [];
  const result = await reviewOcrText(data, async (word) => {
    seen.push(word.text);
    return { text: corrected + '\n', confidence: 95 };
  });
  assert.deepEqual(seen, ['Hein']);
  assert.equal(result.text, `Technovation Girls Cambodia x Future Digital Talents 2026\n${khmer} ${corrected}\n`);
  assert.deepEqual(result.reviewWords, []);
  assert.match(data.text, /Hein/u, 'the original text is retained without mutation');
});

test('keeps real English names and flags unresolved words instead of deleting them', async () => {
  const data = recognition([`${khmer} Hein`]);
  for (const alternative of [
    { text: 'Hein', confidence: 98 },
    { text: '', confidence: 99 },
    { text: corrected, confidence: 70 },
    { text: corrected + ' test', confidence: 99 },
    { text: corrected + '\n' + corrected, confidence: 99 },
    { text: corrected, confidence: Number.NaN },
    undefined
  ]) {
    const result = await reviewOcrText(data, async () => alternative);
    assert.equal(result.text, data.text);
    assert.deepEqual(result.reviewWords, ['Hein']);
  }
  const closeScores = recognition([`${khmer} Hein`], 75);
  assert.equal((await reviewOcrText(closeScores, async () => ({ text: corrected, confidence: 90 }))).text, closeScores.text);
});

test('preserves confident English, acronyms, English phrases and English-only lines', () => {
  assert.deepEqual(findRecheckWords(recognition([`${khmer} Hein`], 95)), []);
  assert.deepEqual(findRecheckWords(recognition([`${khmer} API`, `${khmer} user@example.com`, 'Hein signed the form'])), []);
  assert.deepEqual(findRecheckWords(recognition([`${khmer} Future Digital Talents`])), []);
  assert.deepEqual(findRecheckWords({ text: `${khmer} Hein`, blocks: null }), []);
});

test('replaces only the matched occurrence and keeps line spacing', async () => {
  const data = recognition(['Hein', `${khmer} Hein`, 'Hein']);
  const result = await reviewOcrText(data, async () => ({ text: corrected, confidence: 95 }));
  assert.equal(result.text, `Hein\n${khmer} ${corrected}\nHein\n`);
  const mismatch = { ...data, text: 'Hein' };
  assert.deepEqual(findRecheckWords(mismatch), []);
});

test('bounds rechecks per page and keeps excess candidates for review', async () => {
  const data = recognition(Array.from({ length: 15 }, () => `${khmer} Hein`));
  let calls = 0;
  const result = await reviewOcrText(data, async () => { calls++; return { text: corrected, confidence: 95 }; });
  assert.equal(calls, 12);
  assert.equal((result.text.match(/Hein/gu) ?? []).length, 3);
  assert.deepEqual(result.reviewWords, ['Hein']);
});

test('clamps crops to source pixels and rejects invalid boxes', () => {
  const word = findRecheckWords(recognition([`${khmer} Hein`]))[0];
  const crop = recheckCrop(word, 500, 100)!;
  assert.ok(crop.left >= 0 && crop.top >= 0);
  assert.ok(crop.left + crop.width <= 500 && crop.top + crop.height <= 100);
  assert.ok(crop.scale > 1 && crop.scale <= 3);
  assert.ok(crop.width * crop.height * crop.scale ** 2 <= 2_000_000);
  assert.equal(recheckCrop({ ...word, bbox: { ...word.bbox, x0: Number.NaN } }, 500, 100), undefined);
  assert.equal(recheckCrop(word, 0, 0), undefined);
});

test('propagates cancellation during an optional re-read', async () => {
  const error = new DOMException('Conversion cancelled.', 'AbortError');
  await assert.rejects(reviewOcrText(recognition([`${khmer} Hein`]), async () => { throw error; }), { name: 'AbortError' });
});
