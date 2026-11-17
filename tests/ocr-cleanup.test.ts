import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eraseRules } from '../src/lib/ocr-cleanup';

function blank(width: number, height: number) {
  return new Uint8ClampedArray(width * height * 4).fill(255);
}
function fill(pixels: Uint8ClampedArray, width: number, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * width + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
  }
}
const ink = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => pixels[(y * width + x) * 4] < 160;

test('erases an underline but keeps the letters resting on it and strokes crossing it', () => {
  const width = 1200, height = 300, pixels = blank(width, height);
  fill(pixels, width, 100, 100, 600, 104); // underline
  fill(pixels, width, 150, 60, 158, 100); // stem resting on the line
  fill(pixels, width, 300, 60, 308, 140); // stroke crossing the line
  assert.equal(eraseRules(pixels, width, height).length, 1);
  assert.equal(ink(pixels, width, 400, 102), false);
  assert.equal(ink(pixels, width, 154, 80), true);
  assert.equal(ink(pixels, width, 154, 102), false);
  assert.equal(ink(pixels, width, 304, 102), true);
  assert.equal(ink(pixels, width, 304, 130), true);
});

test('erases a slightly tilted rule and the sides of a box, keeping the boxed text', () => {
  const width = 1200, height = 1000, pixels = blank(width, height);
  for (let x = 50; x < 1150; x++) { const y = 30 + Math.floor((x - 50) / 400); fill(pixels, width, x, y, x + 1, y + 3); }
  fill(pixels, width, 300, 100, 600, 104); fill(pixels, width, 300, 250, 600, 254); // top and bottom
  fill(pixels, width, 300, 100, 304, 254); fill(pixels, width, 596, 100, 600, 254); // sides
  fill(pixels, width, 350, 150, 550, 200); // boxed text
  eraseRules(pixels, width, height);
  assert.equal(ink(pixels, width, 700, 32), false);
  assert.equal(ink(pixels, width, 1100, 33), false);
  assert.equal(ink(pixels, width, 302, 180), false);
  assert.equal(ink(pixels, width, 598, 180), false);
  assert.equal(ink(pixels, width, 450, 175), true);
});

test('leaves text rows, short strokes and thick bars alone', () => {
  const width = 1200, height = 300, pixels = blank(width, height);
  for (let x = 100; x < 1000; x += 40) fill(pixels, width, x, 100, x + 30, 140); // a row of letters
  fill(pixels, width, 100, 200, 160, 204); // short stroke
  fill(pixels, width, 100, 240, 700, 280); // solid bar
  const before = pixels.slice();
  assert.equal(eraseRules(pixels, width, height).length, 0);
  assert.deepEqual(pixels, before);
});
