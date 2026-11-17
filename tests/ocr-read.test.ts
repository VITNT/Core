import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, Worker } from 'tesseract.js';
import { createCanvas } from '@napi-rs/canvas';
import { defaultOptions } from '../src/lib/types';
import { combineRowReadings, mergeRegionReadings, needsScriptReading, preferRowReading, preferScriptLine, preferSlantReading, recognizePreparedPage } from '../src/lib/ocr-read';
import { formatOcrParagraphs } from '../src/lib/ocr-paragraphs';

function page(text: string, confidence = 80): Page {
  const bbox = { x0: 16, y0: 16, x1: 100, y1: 40 };
  return { text: text + '\n', confidence, blocks: [{ bbox, paragraphs: [{ text: text + '\n', bbox, confidence, is_ltr: true,
    lines: [{ text: text + '\n', confidence, bbox, baseline: bbox, rowAttributes: { ascenders: 0, descenders: 0, rowHeight: 24 },
      words: text.split(' ').map((word) => ({ text: word, bbox, confidence, symbols: [] })),
    }],
  }] }] } as unknown as Page;
}

test('combines repaired rows into paragraphs and maps word coordinates back to the page', () => {
  const rows = ['First paragraph', 'wraps here.', 'Second paragraph', 'wraps too.'].map((text, index) => ({
    region: { left: index % 2 === 0 ? 100 : 50, top: 80 + index * 50, width: 600, height: 30 }, data: page(text),
  }));
  const result = combineRowReadings(page('broken', 40), rows);
  assert.equal(formatOcrParagraphs(result), 'First paragraph wraps here.\n\nSecond paragraph wraps too.');
  assert.deepEqual(result.blocks![0].paragraphs[0].lines[0].words[0].bbox, { x0: 100, y0: 80, x1: 184, y1: 104 });
  assert.equal(rows[0].data.blocks![0].paragraphs[0].lines[0].words[0].bbox.x0, 16);
});

test('contents entries stay separate instead of merging into one paragraph', () => {
  const rows = ['I. ភាសាខ្មែរ', 'II. សេចក្តីផ្តើម'].map((text, index) => ({ region: { left: 100, top: 80 + index * 50, width: 600, height: 30 }, data: page(text) }));
  assert.equal(formatOcrParagraphs(combineRowReadings(page('broken', 40), rows, true)), 'I. ភាសាខ្មែរ\n\nII. សេចក្តីផ្តើម');
});

test('rejects incomplete/empty row results and accepts a complete contents repair', () => {
  const first = page('broken', 40), candidate = page('ភាសាខ្មែរ សេចក្តីផ្តើម', 85);
  assert.equal(preferRowReading(first, candidate, 10, 10, true), true);
  assert.equal(preferRowReading(first, candidate, 3, 10, true), false);
  assert.equal(preferRowReading(first, page('', 90), 10, 10, true), false);
});

test('layout repair does not discard a confident English passage', () => {
  assert.equal(preferRowReading(page('Invoice reference amount', 90), page('ភាសាខ្មែរ សេចក្តីផ្តើម'.repeat(3), 95), 10, 10, false), false);
  const first = page('ភាសាខ្មែរ', 70), repaired = page('ភាសាខ្មែរ សេចក្តីផ្តើម', 75);
  assert.equal(preferRowReading(first, repaired, 10, 10, false), true);
});

test('accepts a substantially stronger Khmer slant correction, without replacing confident text or short noise', () => {
  assert.equal(preferSlantReading(page('CLUE EIA', 17), page('ទុំឱបបីបមថ្នមប្រឡែង', 88)), true);
  assert.equal(preferSlantReading(page('Invoice number', 90), page('ទុំឱបបីបមថ្នមប្រឡែង', 95)), false);
  assert.equal(preferSlantReading(page('Text', 20), page('Text', 95)), false);
  assert.equal(preferSlantReading(page('ភាសាខ្មែរ'.repeat(5), 20), page('ភាសាខ្មែរ', 95)), false);
});

test('inverse-maps slanted row boxes to the unmodified page for visual word rechecks', () => {
  const result = combineRowReadings(page('broken', 40), [{ region: { left: 100, top: 80, width: 600, height: 40 }, data: page('ភាសាខ្មែរ'), shear: 0.25 }]);
  assert.deepEqual(result.blocks![0].paragraphs[0].lines[0].words[0].bbox, { x0: 94, y0: 80, x1: 184, y1: 104 });
});

test('keeps a strong italic line correction when the rest of a page cannot be repaired safely', () => {
  const first = combineRowReadings(page('base'), [
    { region: { left: 100, top: 100, width: 600, height: 40 }, data: page('CLUE EIA', 76) },
    { region: { left: 100, top: 180, width: 600, height: 40 }, data: page('Invoice number', 90) },
  ]);
  const result = mergeRegionReadings(first, [
    { region: { left: 100, top: 100, width: 600, height: 40 }, data: page('ទុំឱបបីបមថ្នមប្រឡែង', 88), shear: 0.35, originalConfidence: 17 },
    { region: { left: 100, top: 180, width: 600, height: 40 }, data: page('ទុំឱបបីបមថ្នមប្រឡែង', 95), shear: 0.35, originalConfidence: 17 },
  ]);
  assert.match(result.text, /ទុំឱបបីបមថ្នមប្រឡែង/);
  assert.match(result.text, /Invoice number/);
  assert.doesNotMatch(result.text, /CLUE/);
  assert.match(first.text, /CLUE/);
  assert.equal(result.blocks![0].paragraphs[0].lines[0].words[0].bbox.x0, 91.6);
});

test('does not overwrite multiple layout lines with an ambiguous row correction', () => {
  const first = combineRowReadings(page('base'), [
    { region: { left: 100, top: 100, width: 600, height: 40 }, data: page('CLUE', 17) },
    { region: { left: 100, top: 180, width: 600, height: 40 }, data: page('EIA', 20) },
  ]);
  const result = mergeRegionReadings(first, [{ region: { left: 100, top: 100, width: 600, height: 140 }, data: page('ទុំឱបបីបមថ្នមប្រឡែង', 88), shear: 0.35 }]);
  assert.equal(result, first);
});


test('layout repair retains both scripts and page numbers even on contents pages', () => {
  const first = page('Invoice reference amount ភាសាខ្មែរ សេចក្តីផ្តើម 12345', 90);
  assert.equal(preferRowReading(first, page('Invoice reference 12345', 99), 10, 10, true), false);
  assert.equal(preferRowReading(first, page('ភាសាខ្មែរ សេចក្តីផ្តើម 12345', 99), 10, 10, true), false);
  assert.equal(preferRowReading(first, page('Invoice reference amount ភាសាខ្មែរ សេចក្តីផ្តើម', 99), 10, 10, true), false);
});

test('reads original pixels first, rejects incomplete cleaned output and preserves the recheck source', async () => {
  const canvas = createCanvas(600, 300);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, 600, 300);
  context.fillStyle = '#000';
  // A grid that layout processing will erase.
  for (const y of [50, 150, 250]) context.fillRect(50, y, 500, 2);
  for (const x of [50, 300, 548]) context.fillRect(x, 50, 2, 202);
  const original = canvas.toBuffer('image/png');
  const first = page('Invoice reference amount ភាសាខ្មែរ សេចក្តីផ្តើម 12345', 90);
  let calls = 0;
  const worker = { recognize: async (image: typeof canvas) => {
    calls++;
    if (calls === 1) {
      assert.deepEqual(image.toBuffer('image/png'), original);
      return { data: first };
    }
    assert.notDeepEqual(image.toBuffer('image/png'), original);
    return { data: page('Invoice', 99) };
  } } as unknown as Worker;
  const result = await recognizePreparedPage(worker, canvas as unknown as HTMLCanvasElement, defaultOptions, {}, {
    checkAbort() {}, createCanvas: () => createCanvas(1, 1) as unknown as HTMLCanvasElement,
  });
  assert.equal(calls, 2);
  assert.equal(result, first);
  assert.deepEqual(canvas.toBuffer('image/png'), original);
});

test('optional layout failure keeps the successful source reading', async () => {
  const canvas = createCanvas(100, 100);
  const first = page('Successful original reading', 90);
  const worker = { recognize: async () => ({ data: first }) } as unknown as Worker;
  const result = await recognizePreparedPage(worker, canvas as unknown as HTMLCanvasElement, defaultOptions, {}, {
    checkAbort() {}, createCanvas: () => { throw new Error('Canvas allocation failed'); },
  });
  assert.equal(result, first);
});


test('inverse-maps normalized boxes, baselines and character heights before page rechecks', () => {
  const result = combineRowReadings(page('base'), [{ region: { left: 100, top: 80, width: 600, height: 40 },
    data: page('ភាសាខ្មែរ'), scale: 2, shear: 0.25 }]);
  const line = result.blocks![0].paragraphs[0].lines[0];
  assert.deepEqual(line.words[0].bbox, { x0: 97, y0: 80, x1: 142, y1: 92 });
  assert.deepEqual(line.baseline, { x0: 100, y0: 80, x1: 139, y1: 92 });
  assert.equal(line.rowAttributes.rowHeight, 12);
});

test('normalizes and reads regions even on confident pages, retaining independently improved lines', async () => {
  const canvas = createCanvas(600, 300), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 300); ctx.fillStyle = '#000';
  ctx.fillRect(80, 80, 300, 40); ctx.fillRect(80, 180, 300, 40);
  const first = combineRowReadings(page('base'), [
    { region: { left: 80, top: 80, width: 300, height: 40 }, data: page('First reading', 70) },
    { region: { left: 80, top: 180, width: 300, height: 40 }, data: page('Second reading', 90) },
  ]);
  first.confidence = 90;
  let calls = 0;
  const worker = { recognize: async (image: typeof canvas) => {
    calls++;
    if (calls === 1) return { data: first };
    assert.ok(image.height < canvas.height);
    return { data: calls === 2 ? page('First corrected', 80) : page('Second reading', 70) };
  } } as unknown as Worker;
  const result = await recognizePreparedPage(worker, canvas as unknown as HTMLCanvasElement, defaultOptions, {}, {
    checkAbort() {}, createCanvas: () => createCanvas(1, 1) as unknown as HTMLCanvasElement,
  });
  assert.equal(calls, 3);
  assert.match(result.text, /First corrected/);
  assert.match(result.text, /Second reading/);
  assert.match(first.text, /First reading/);
});

test('does not erase a repeated letter gutter when its labels are not recognized as numbers', async () => {
  const canvas = createCanvas(600, 400), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 400); ctx.fillStyle = '#000';
  for (const y of [60, 160, 260]) { ctx.fillRect(30, y, 12, 24); ctx.fillRect(100, y, 300, 24); }
  const original = canvas.toBuffer('image/png');
  let labels = 0, fullReads = 0;
  const worker = { recognize: async (image: typeof canvas, parameters: { tessedit_pageseg_mode?: string }) => {
    if (parameters.tessedit_pageseg_mode === '8') {
      labels++;
      return { data: page('A.', 96) };
    }
    if (image.width === 600 && image.height === 400) {
      fullReads++;
      assert.deepEqual(image.toBuffer('image/png'), original);
    }
    return { data: page('Original body reading', 90) };
  } } as unknown as Worker;
  const result = await recognizePreparedPage(worker, canvas as unknown as HTMLCanvasElement, { ...defaultOptions, enhance: false }, {}, {
    checkAbort() {}, createCanvas: () => createCanvas(1, 1) as unknown as HTMLCanvasElement,
  });
  assert.equal(labels, 3);
  assert.equal(fullReads, 1);
  assert.match(result.text, /Original body reading/);
  assert.doesNotMatch(result.text, /1\./);
});

test('row reading replaces a page reading that shredded lines into confident fragments', () => {
  const region = (index: number) => ({ left: 100, top: 80 + index * 50, width: 600, height: 30 });
  const sentence = 'ភាសាខ្មែរ សេចក្តីផ្តើម ទំព័រ';
  // Segmentation failure: one real line, then a lost line as digit/letter fragments.
  const shredded = combineRowReadings(page('base'), [sentence, '2', '30', 'យ', '=៥%', '5'].map((text, index) => ({ region: region(index), data: page(text, 92) })));
  const rows = combineRowReadings(page('base'), [sentence, sentence].map((text, index) => ({ region: region(index), data: page(text, 80) })));
  assert.equal(preferRowReading(shredded, rows, 2, 2, false), true);
  // A confidently read number in a real line must still survive.
  const numbered = combineRowReadings(page('base'), [{ region: region(0), data: page(sentence + ' 2026', 92) }]);
  assert.equal(preferRowReading(numbered, rows, 2, 2, false), false);
  // Rows that lost most of the text are not an improvement.
  assert.equal(preferRowReading(shredded, page('ភាសា', 95), 2, 2, false), false);
});

test('Khmer rows prefer the script model unless it lost text, numbers or English', () => {
  assert.equal(needsScriptReading(page('Invoice reference amount', 92)), false);
  assert.equal(needsScriptReading(page('2026', 95)), false);
  assert.equal(needsScriptReading(page('ភាសាខ្មែរ សេចក្តីផ្តើម', 92)), true);
  assert.equal(needsScriptReading(page('CLUE EIA', 40)), true);
  const first = page('ភាសាខ្មែរ Invoice 2026', 90);
  assert.equal(preferScriptLine(first, page('ភាសាខ្មែរ Invoice 2026', 60)), true);
  assert.equal(preferScriptLine(first, page('ភាសាខ្មែរ Invoice', 95)), false);
  assert.equal(preferScriptLine(first, page('ភាសាខ្មែរ នេះ 2026', 95)), false);
  assert.equal(preferScriptLine(first, page('ភាសា', 95)), false);
  assert.equal(preferScriptLine(first, page('', 95)), false);
});

test('reads Khmer rows with the script model and keeps the language model for English rows', async () => {
  const canvas = createCanvas(600, 300), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 300); ctx.fillStyle = '#000';
  ctx.fillRect(80, 80, 300, 40); ctx.fillRect(80, 180, 300, 40);
  const first = page('garbled', 50);
  let calls = 0, scriptCalls = 0;
  const worker = { recognize: async () => {
    calls++;
    // Page read, then the first row twice (standard and one voting variant), then the English row.
    return { data: calls === 1 ? first : calls <= 3 ? page('ភាសាខ្មែរ សេចក្តីផ្ដើម', 85) : page('Invoice reference amount', 92) };
  } } as unknown as Worker;
  const script = { recognize: async () => { scriptCalls++; return { data: page('ភាសាខ្មែរ សេចក្តីផ្តើម', 70) }; } } as unknown as Worker;
  const result = await recognizePreparedPage(worker, canvas as unknown as HTMLCanvasElement, defaultOptions, {}, {
    checkAbort() {}, createCanvas: () => createCanvas(1, 1) as unknown as HTMLCanvasElement, scriptWorker: async () => script,
  });
  assert.equal(scriptCalls, 3);
  assert.equal(calls, 4);
  assert.match(result.text, /សេចក្តីផ្តើម/);
  assert.match(result.text, /Invoice reference amount/);
  assert.doesNotMatch(result.text, /garbled/);
});

test('row pass keeps every line the page reading found', async () => {
  const { coverPageLines } = await import('../src/lib/ocr-read');
  // Page reading with ten lines; the row pass read nine and lost the last one.
  const lines = Array.from({ length: 10 }, (_, index) => `ភាសាខ្មែរ ជួរ ${index + 1}`);
  const pageReading = combineRowReadings(page('', 0), lines.map((text, index) => ({
    region: { left: 100, top: 100 + index * 50, width: 400, height: 30 }, data: page(text, 85) })));
  const rows = lines.map((text, index) => ({ region: { left: 100, top: 100 + index * 50, width: 400, height: 30 }, data: page(index === 9 ? '' : text, 90) }));
  const { readings, expected } = coverPageLines(pageReading, rows, false);
  assert.equal(expected, 10);
  const combined = combineRowReadings(pageReading, readings);
  assert.match(combined.text, /ជួរ 10/);
  // Without the fill the same nine-of-ten reading is no longer accepted.
  assert.equal(preferRowReading(pageReading, combineRowReadings(pageReading, rows), 9, 10, false), false);
  assert.equal(preferRowReading(pageReading, combined, 10, expected, false), true);
});

test('row pass inserts confident page lines that no row region covers, in reading order', async () => {
  const { coverPageLines } = await import('../src/lib/ocr-read');
  const pageReading = combineRowReadings(page('', 0), ['ជួរទីមួយ', 'ជួរកណ្ដាល', 'ជួរទីបី'].map((text, index) => ({
    region: { left: 100, top: 100 + index * 50, width: 400, height: 30 }, data: page(text, 88) })));
  const rows = [0, 2].map((index) => ({ region: { left: 100, top: 100 + index * 50, width: 400, height: 30 }, data: page(index ? 'ជួរទីបី' : 'ជួរទីមួយ', 90) }));
  const { readings } = coverPageLines(pageReading, rows, false);
  assert.equal(combineRowReadings(pageReading, readings).text.replace(/\n+/gu, ' ').trim(), 'ជួរទីមួយ ជួរកណ្ដាល ជួរទីបី');
});

test('row reading that lost most of a confident line falls back to the page line', async () => {
  const { coverPageLines } = await import('../src/lib/ocr-read');
  const region = { left: 100, top: 100, width: 400, height: 30 };
  const pageReading = combineRowReadings(page('', 0), [{ region, data: page('ផ្នែករឹងរបស់ផែនដីមានបីស្រទាប់', 85) }]);
  const { readings } = coverPageLines(pageReading, [{ region, data: page('ផ្នែក', 95) }], false);
  assert.match(readings[0].data.text, /បីស្រទាប់/);
  // Contents pages keep their row readings: leaders read as letters inflate the page reading.
  assert.equal(coverPageLines(pageReading, [{ region, data: page('ផ្នែក', 95) }], true).readings[0].data.text.trim(), 'ផ្នែក');
});

test('pieces of a row split at wide gaps return to one line, in a paragraph of their own', () => {
  const rows = [
    { region: { left: 50, top: 80, width: 200, height: 30, segmentOf: 0 }, data: page('ជំពូក១') },
    { region: { left: 500, top: 80, width: 200, height: 30, segmentOf: 0 }, data: page('ភពផែនដី') },
    { region: { left: 50, top: 130, width: 600, height: 30 }, data: page('សំណួរ១ តើផ្នែករឹង') },
    { region: { left: 50, top: 180, width: 600, height: 30 }, data: page('របស់ផែនដី') },
  ];
  const result = combineRowReadings(page('broken', 40), rows);
  assert.equal(formatOcrParagraphs(result), 'ជំពូក១ ភពផែនដី\n\nសំណួរ១ តើផ្នែករឹងរបស់ផែនដី');
  const heading = result.blocks![0].paragraphs[0].lines[0];
  assert.equal(heading.words.length, 2);
  assert.ok(heading.bbox.x0 < 100 && heading.bbox.x1 > 500);
});
