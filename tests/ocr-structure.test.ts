import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, Line } from 'tesseract.js';
import { createCanvas } from '@napi-rs/canvas';
import { attachListLabels, mapLayoutCoordinates, preserveRegionParagraphs, suppressCoveredFragments } from '../src/lib/ocr-structure';
import { recognitionRegions, preparePageLayout } from '../src/lib/ocr-regions';
import { formatOcrParagraphs } from '../src/lib/ocr-paragraphs';

function line(text: string, top: number): Line {
  const bbox = { x0: 100, x1: 400, y0: top, y1: top + 24 };
  return { text: text + '\n', bbox, baseline: bbox, confidence: 85,
    rowAttributes: { rowHeight: 24, ascenders: 3, descenders: 4 },
    words: [{ text, bbox, confidence: 85, symbols: [{ text: text[0], bbox }] }],
  } as unknown as Line;
}
function page(lines: Line[]): Page {
  const bbox = { x0: 100, x1: 400, y0: lines[0].bbox.y0, y1: lines.at(-1)!.bbox.y1 };
  const text = lines.map((l) => l.text).join('');
  return { text, confidence: 85, blocks: [{ bbox, paragraphs: [{ bbox, lines, text }] }] } as unknown as Page;
}

test('keeps visible list questions separate even when PDF OCR omits labels and groups the page into one paragraph', () => {
  const canvas = createCanvas(600, 500), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 500); ctx.fillStyle = '#000';
  for (const y of [80, 160, 320]) { ctx.fillRect(30, y, 12, 24); ctx.fillRect(100, y, 300, 24); }
  // A continuation of the second question has no gutter label.
  ctx.fillRect(100, 220, 300, 24);
  const original = page([line('First question?', 80), line('Second question', 160), line('wraps here?', 220), line('Third question?', 320)]);
  const regions = recognitionRegions(canvas as unknown as HTMLCanvasElement, original);
  assert.equal(regions.filter((r) => r.listStart).length, 3);
  const result = preserveRegionParagraphs(original, regions);
  assert.equal(formatOcrParagraphs(result), 'First question?\n\nSecond question wraps here?\n\nThird question?');
  assert.equal(result.text.replace(/\s/g, ''), original.text.replace(/\s/g, ''));
  assert.equal(original.blocks![0].paragraphs.length, 1);
});

test('does not split prose at each visual line or infer a list from one widely spaced phrase', () => {
  const original = page([line('A paragraph', 80), line('continues here.', 130)]);
  const regions = [80, 130].map((top) => ({ left: 90, top: top - 8, width: 330, height: 40 }));
  assert.equal(formatOcrParagraphs(preserveRegionParagraphs(original, regions)), 'A paragraph continues here.');
  const unmatched = { ...original, text: original.text + 'Unmatched text' };
  assert.equal(preserveRegionParagraphs(unmatched, regions), unmatched);
});

test('normalizes large text for the initial layout read and maps all coordinates back to the source', () => {
  const canvas = createCanvas(600, 500), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 500); ctx.fillStyle = '#000';
  for (const y of [60, 200, 340]) ctx.fillRect(80, y, 400, 96);
  const before = canvas.toBuffer('image/png');
  const prepared = preparePageLayout(canvas as unknown as HTMLCanvasElement, 'khm', () => createCanvas(1, 1) as unknown as HTMLCanvasElement);
  assert.equal(prepared.scaleX, 0.5);
  assert.equal(prepared.scaleY, 0.5);
  const original = page([line('Text', 40)]);
  const mapped = mapLayoutCoordinates(original, prepared.scaleX, prepared.scaleY);
  const output = mapped.blocks![0].paragraphs[0].lines[0];
  assert.deepEqual(output.bbox, { x0: 200, x1: 800, y0: 80, y1: 128 });
  assert.deepEqual(output.words[0].symbols[0].bbox, output.bbox);
  assert.deepEqual(output.baseline, output.bbox);
  assert.equal(output.rowAttributes.rowHeight, 48);
  assert.deepEqual(canvas.toBuffer('image/png'), before);
  assert.equal(original.blocks![0].paragraphs[0].lines[0].bbox.x0, 100);
});


test('attaches actual recognized list labels without changing body words or duplicating existing numbers', () => {
  const original = page([line('Question one?', 80), line('2. Question two?', 160)]);
  const labels = [80, 160].map((top, index) => ({ text: `${index + 1}.`, confidence: 96,
    region: { left: 20, top: top - 8, width: 400, height: 40, listStart: true,
      label: { left: 20, top: top - 8, width: 30, height: 40 } } }));
  const result = attachListLabels(original, labels);
  assert.equal(result.text, '1. Question one?\n2. Question two?\n');
  const words = result.blocks![0].paragraphs[0].lines[0].words;
  assert.equal(words[0].text, '1.');
  assert.equal(words[1].text, 'Question one?');
  assert.equal(original.text, 'Question one?\n2. Question two?\n');
});

test('removes duplicate tiny marks covered by a Khmer word, retaining separate footnotes and superscripts', () => {
  const body = line('ព្រះរាជាណាចក្រកម្ពុជា', 80);
  const fragment = line('2', 84);
  fragment.bbox = { x0: 120, x1: 125, y0: 84, y1: 90 };
  const footnote = line('1', 150);
  footnote.bbox = { x0: 120, x1: 125, y0: 150, y1: 156 };
  const exponent = line('2', 74);
  exponent.bbox = { x0: 402, x1: 407, y0: 74, y1: 80 };
  const original = page([body, fragment, footnote, exponent]);
  const result = suppressCoveredFragments(original);
  assert.equal(result.blocks![0].paragraphs[0].lines.length, 3);
  assert.ok(result.blocks![0].paragraphs[0].lines.includes(footnote));
  assert.ok(result.blocks![0].paragraphs[0].lines.includes(exponent));
  assert.equal(original.blocks![0].paragraphs[0].lines.length, 4);
});

test('keeps a wrapped question together across engine block breaks while preserving the next question and footer', () => {
  const a = page([line('1. Question wraps', 80)]);
  const b = page([line('onto another line.', 130)]);
  const c = page([line('2. Next question?', 200)]);
  const footer = page([line('Footer', 300)]);
  const original = { ...a, blocks: [...a.blocks!, ...b.blocks!, ...c.blocks!, ...footer.blocks!],
    text: [a.text, b.text, c.text, footer.text].join('\n') };
  const regions = [80, 130, 200, 300].map((top, i) => ({ left: i === 1 ? 100 : 20, top: top - 8, width: 400, height: 40,
    ...([0, 2].includes(i) ? { listStart: true, bodyLeft: 100 } : {}) }));
  // Put a decorative rule between the list and footer, as in the real PDF.
  regions.splice(3, 0, { left: 20, top: 260, width: 400, height: 10 });
  assert.equal(formatOcrParagraphs(preserveRegionParagraphs(original, regions)),
    '1. Question wraps onto another line.\n\n2. Next question?\n\nFooter');
});
