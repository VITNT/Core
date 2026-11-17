import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, Worker } from 'tesseract.js';
import { createCanvas } from '@napi-rs/canvas';
import { finalizeOcrPage } from '../src/lib/ocr-finalize';

function page(lines: { text: string; confidence: number; uncertain?: string[] }[]): Page {
  const bbox = { x0: 16, y0: 16, x1: 300, y1: 40 };
  const text = lines.map((line) => line.text).join('\n') + '\n';
  return { text, confidence: 90, blocks: [{ bbox, text, paragraphs: [{ text, bbox, confidence: 90, is_ltr: true,
    lines: lines.map((line) => ({ ...line, text: line.text + '\n', bbox, baseline: bbox, rowAttributes: { ascenders: 0, descenders: 0, rowHeight: 24 },
      words: line.text.split(' ').map((word) => ({ text: word, bbox, confidence: line.confidence, symbols: [] })) })),
  }] }] } as unknown as Page;
}

test('final step reports disputed Khmer spans, standard order and line-based confidence', async () => {
  const canvas = createCanvas(400, 100) as unknown as HTMLCanvasElement;
  const worker = { recognize: async () => { throw new Error('no rechecks expected'); } } as unknown as Worker;
  const data = page([{ text: 'ស្រ្តី ផែនដី', confidence: 60, uncertain: ['ផែនដី'] }, { text: 'ភាសាខ្មែរ', confidence: 90 }]);
  const final = await finalizeOcrPage(data, canvas, worker, {}, { checkAbort() {}, createCanvas: () => createCanvas(1, 1) as unknown as HTMLCanvasElement });
  assert.deepEqual(final.reviewWords, ['ផែនដី']);
  assert.match(final.text, /ស្ត្រី/);
  // Standard ordering alone is not an edit the user is offered to undo.
  assert.equal(final.text, final.originalText);
  assert.ok(final.confidence > 60 && final.confidence < 90);
});
