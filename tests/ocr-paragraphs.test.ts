import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOcrParagraphs } from '../src/lib/ocr-paragraphs';
import { cleanOcrText } from '../src/lib/ocr-text';
import { joinPages } from '../src/lib/files';

function reading(paragraphs: string[][], separator = '\n') {
  return {
    text: paragraphs.map((lines) => lines.join('\n')).join(separator) + '\n',
    blocks: [{ paragraphs: paragraphs.map((lines) => ({ lines: lines.map((text) => ({ text: text + '\n' })) })) }],
  };
}

test('joins visual line wraps and separates actual layout paragraphs even without blank OCR lines', () => {
  const data = reading([['This paragraph wraps', 'onto a second line.'], ['A new paragraph', 'continues here.']]);
  assert.equal(formatOcrParagraphs(data), 'This paragraph wraps onto a second line.\n\nA new paragraph continues here.');
});

test('retains headings and paragraphs in different blocks, without changing internal spaces', () => {
  const data = reading([['Heading'], ['Column 1    Column 2', 'continued text']]);
  data.blocks = [
    { paragraphs: [data.blocks[0].paragraphs[0]] },
    { paragraphs: [data.blocks[0].paragraphs[1]] },
  ];
  assert.equal(formatOcrParagraphs(data), 'Heading\n\nColumn 1    Column 2 continued text');
});

test('uses corrected text, including longer replacement words, instead of stale layout strings', () => {
  const data = reading([['ភាសាខ្មែរ Hein', 'បន្តអត្ថបទ'], ['English paragraph', 'continues.']]);
  const corrected = data.text.replace('Hein', 'អំឡុងពេល');
  assert.equal(formatOcrParagraphs(data, corrected), 'ភាសាខ្មែរ អំឡុងពេលបន្តអត្ថបទ\n\nEnglish paragraph continues.');
  assert.match(data.text, /Hein/u);
});

test('joins Khmer continuations without inserting spaces inside words, and spaces Latin/sentence boundaries', () => {
  assert.equal(formatOcrParagraphs(reading([['ព្រះរាជាណា', 'ចក្រកម្ពុជា']])), 'ព្រះរាជាណាចក្រកម្ពុជា');
  assert.equal(formatOcrParagraphs(reading([['ភាសាខ្មែរ ', 'បន្តអត្ថបទ']])), 'ភាសាខ្មែរ បន្តអត្ថបទ');
  assert.equal(formatOcrParagraphs(reading([['ភាសាខ្មែរ។', 'បន្តអត្ថបទ']])), 'ភាសាខ្មែរ។ បន្តអត្ថបទ');
  assert.equal(formatOcrParagraphs(reading([['Khmer and', 'English text']])), 'Khmer and English text');
});

test('removes discretionary soft hyphens but preserves literal compound hyphens', () => {
  assert.equal(formatOcrParagraphs(reading([['para\u00ad', 'graph text']])), 'paragraph text');
  assert.equal(formatOcrParagraphs(reading([['well-', 'known text']])), 'well-known text');
});

test('fallback joins single breaks, retains blank-line paragraphs and never discards unmatched text', () => {
  const data = { text: 'First wrapped\r\nparagraph.\r\n\r\nSecond wrapped\r\nparagraph.\r\n', blocks: null };
  assert.equal(formatOcrParagraphs(data), 'First wrapped paragraph.\n\nSecond wrapped paragraph.');
  const partial = reading([['Unmatched text'], ['Expected text']]);
  partial.blocks[0].paragraphs.shift();
  assert.equal(formatOcrParagraphs(partial), 'Unmatched text Expected text');
  assert.equal(formatOcrParagraphs(reading([['Old text']]), 'New\n\nparagraph'), 'New\n\nparagraph');
  const sameLine = reading([['First'], ['second']]);
  sameLine.text = 'First second\n';
  assert.equal(formatOcrParagraphs(sameLine), 'First second');
});

test('handles repeated lines and noise-only paragraphs without losing corrections or adding empty paragraphs', () => {
  const data = reading([['Repeated line', 'wraps here.'], ['@#$'], ['Repeated line', 'wraps differently.']], '\n\n');
  assert.equal(formatOcrParagraphs(data, cleanOcrText(data.text)), 'Repeated line wraps here.\n\nRepeated line wraps differently.');
  assert.equal(formatOcrParagraphs({ text: '\n \n', blocks: null }), '');
});

test('copy/download page joining keeps the same paragraph formatting and preserves page order', () => {
  const first = formatOcrParagraphs(reading([['First page', 'wrapped paragraph.'], ['Another paragraph.']]));
  const second = formatOcrParagraphs(reading([['Second page', 'wrapped paragraph.']]));
  assert.equal(joinPages([{ text: first }, { text: second }]), 'First page wrapped paragraph.\n\nAnother paragraph.\n\nSecond page wrapped paragraph.');
});
