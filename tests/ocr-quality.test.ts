import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsSecondPass, preferReading } from '../src/lib/ocr-quality';

test('retries empty and uncertain pages but keeps the fast path for clear results', () => {
  assert.equal(needsSecondPass({ text: '', confidence: 95 }), true);
  assert.equal(needsSecondPass({ text: 'Text', confidence: 60 }), true);
  assert.equal(needsSecondPass({ text: 'Text', confidence: 90 }), false);
});

test('accepts a stronger complete reading and rejects confident partial bilingual output', () => {
  const first = { text: 'Invoice ភាសាខ្មែរ សូមស្វាគមន៍', confidence: 65 };
  const better = { text: first.text, confidence: 80 };
  assert.equal(preferReading(first, better), better);
  assert.equal(preferReading(first, { text: 'Invoice', confidence: 99 }), first);
  assert.equal(preferReading(first, { text: 'ភាសាខ្មែរ សូមស្វាគមន៍', confidence: 99 }), first);
  assert.equal(preferReading(first, { text: first.text.repeat(3), confidence: 99 }), first);
  assert.equal(preferReading(first, { text: first.text, confidence: NaN }), first);
  assert.equal(preferReading(first, { text: first.text, confidence: 68 }), first);
});

test('requires a meaningful confident result before replacing an empty page', () => {
  const empty = { text: '', confidence: 0 };
  const recovered = { text: 'ភាសាខ្មែរ', confidence: 80 };
  assert.equal(preferReading(empty, recovered), recovered);
  assert.equal(preferReading(empty, { text: '?! #', confidence: 99 }), empty);
  assert.equal(preferReading(empty, { text: 'false text', confidence: 25 }), empty);
});
