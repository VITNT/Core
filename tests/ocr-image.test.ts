import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSkew, imageDimensions, MAX_OCR_PIXELS, normalizeScan } from '../src/lib/ocr-image';

test('bounds decoded images and enlarges small text without unbounded allocations', () => {
  assert.deepEqual(imageDimensions(800, 600, true), { width: 1600, height: 1200 });
  assert.deepEqual(imageDimensions(2400, 3200, true), { width: 2400, height: 3200 });
  for (const [width, height] of [[10000, 10000], [1e8, 1], [1, 1e8], [1, 1]]) {
    const size = imageDimensions(width, height, true);
    assert.ok(size.width * size.height <= MAX_OCR_PIXELS);
    assert.ok(Math.max(size.width, size.height) <= 12000);
    assert.ok(size.width >= 1 && size.height >= 1);
  }
  for (const value of [0, -1, Infinity, NaN]) assert.throws(() => imageDimensions(value, 100));
});

function pixels(values: number[]) {
  return new Uint8ClampedArray(values.flatMap((value) => [value, value, value, 255]));
}

test('normalizes faint scans while retaining intermediate gray marks', () => {
  const data = pixels([...Array(100).fill(130), 180, ...Array(899).fill(230)]);
  normalizeScan(data);
  assert.equal(data[0], 0);
  assert.ok(data[400] >= 125 && data[400] <= 130);
  assert.equal(data.at(-4), 255);
});

test('leaves nearly blank scans quiet, flattens transparency and inverts dark pages', () => {
  const blank = pixels(Array(100).fill(240));
  normalizeScan(blank);
  assert.equal(blank[0], 240);
  const dark = pixels([...Array(900).fill(25), ...Array(100).fill(235)]);
  normalizeScan(dark);
  assert.equal(dark[0], 255);
  assert.equal(dark.at(-4), 0);
  const transparent = new Uint8ClampedArray([0, 0, 0, 0]);
  normalizeScan(transparent);
  assert.deepEqual([...transparent], [255, 255, 255, 255]);
});

function rows(angle: number) {
  const width = 600, height = 400;
  const data = pixels(Array(width * height).fill(255));
  for (const row of [60, 120, 180, 240, 300]) {
    for (let x = 40; x < width - 40; x++) {
      if (x % 20 > 14) continue;
      const base = row + Math.round(Math.tan(angle * Math.PI / 180) * (x - width / 2));
      for (let dy = 0; dy < 5; dy++) {
        const index = ((base + dy) * width + x) * 4;
        data[index] = data[index + 1] = data[index + 2] = 0;
      }
    }
  }
  return { data, width, height };
}

test('deskewing finds positive and negative tilt and avoids changing straight/blank pages', () => {
  for (const angle of [-3, 3]) {
    const image = rows(angle);
    assert.ok(Math.abs(estimateSkew(image.data, image.width, image.height) + angle) < 0.3);
  }
  const straight = rows(0);
  assert.equal(estimateSkew(straight.data, straight.width, straight.height), 0);
  assert.equal(estimateSkew(pixels(Array(10000).fill(255)), 100, 100), 0);
});
