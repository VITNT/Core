import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import type { Page } from 'tesseract.js';
import { prepareTextRegion, recognitionRegions } from '../src/lib/ocr-regions';
const factory = () => createCanvas(1, 1) as unknown as HTMLCanvasElement;

test('normalizes full glyph height consistently across source resolutions, including detached marks', () => {
  for (const factor of [1, 2, 3]) {
    const source = createCanvas(300 * factor, 100 * factor);
    const ctx = source.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, source.width, source.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(30 * factor, 30 * factor, 120 * factor, 20 * factor);
    ctx.fillRect(50 * factor, 20 * factor, 10 * factor, 5 * factor);
    ctx.fillRect(70 * factor, 55 * factor, 10 * factor, 5 * factor);
    const result = prepareTextRegion(source as unknown as HTMLCanvasElement,
      { left: 0, top: 0, width: source.width, height: source.height }, 'khm', factory);
    assert.ok(Math.abs(result.scale * 40 * factor - 48) < 0.2);
    const pixels = result.canvas.getContext('2d')!.getImageData(0, 0, result.canvas.width, result.canvas.height).data;
    const inkRows = [];
    for (let y = 0; y < result.canvas.height; y++) {
      let ink = false;
      for (let x = 0; x < result.canvas.width; x++) if (pixels[(y * result.canvas.width + x) * 4] < 160) ink = true;
      if (ink) inkRows.push(y);
    }
    assert.ok(inkRows.at(-1)! - inkRows[0] >= 46);
  }
});

test('detects title, body, and footer separately, retaining list numbers with their text', () => {
  const source = createCanvas(600, 500), ctx = source.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 500); ctx.fillStyle = '#000';
  ctx.fillRect(150, 30, 300, 40);
  for (const y of [150, 230, 310]) { ctx.fillRect(30, y, 10, 24); ctx.fillRect(80, y, 450, 24); }
  ctx.fillRect(30, 440, 200, 14);
  const regions = recognitionRegions(source as unknown as HTMLCanvasElement, { blocks: [] } as unknown as Page);
  assert.equal(regions.length, 5);
  assert.ok(regions[1].left <= 30);
  assert.ok(regions[1].left + regions[1].width >= 530);
  assert.ok(regions[0].top + regions[0].height < regions[1].top);
  assert.ok(regions[4].top > regions[3].top + regions[3].height);
});

test('keeps side-by-side text columns as independent regions in block reading order', () => {
  const source = createCanvas(600, 400), ctx = source.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 400); ctx.fillStyle = '#000';
  for (const x of [30, 330]) for (const y of [60, 140]) ctx.fillRect(x, y, 220, 24);
  const blocks = [30, 330].map((x) => ({ bbox: { x0: x, x1: x + 220, y0: 60, y1: 164 },
    paragraphs: [{ lines: [{ text: 'Column text' }] }] }));
  const regions = recognitionRegions(source as unknown as HTMLCanvasElement, { blocks } as unknown as Page);
  assert.equal(regions.length, 4);
  assert.ok(regions[0].left < 300 && regions[1].left < 300);
  assert.ok(regions[2].left > 300 && regions[3].left > 300);
  assert.ok(regions.every((r) => r.width < 300));
});
