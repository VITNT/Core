import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eraseDotLeaders, eraseTableRulings, findDotLeaders, findTextRows } from '../src/lib/ocr-layout';

function image(width = 1200, height = 600) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  function rectangle(left: number, top: number, w: number, h: number) {
    for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) {
      const index = (y * width + x) * 4;
      data[index] = data[index + 1] = data[index + 2] = 0;
    }
  }
  return { data, width, height, rectangle };
}

test('removes repeated contents leaders while preserving label glyphs and short ellipses', () => {
  const im = image();
  for (const y of [100, 200, 300]) {
    im.rectangle(60, y - 25, 50, 30);
    for (let x = 200; x < 1000; x += 18) im.rectangle(x, y, 3, 3);
  }
  for (const x of [60, 78, 96]) im.rectangle(x, 400, 3, 3);
  const leaders = findDotLeaders(im.data, im.width, im.height);
  assert.equal(leaders.length, 3);
  eraseDotLeaders(im.data, im.width, im.height, leaders);
  assert.equal(im.data[(100 * im.width + 200) * 4], 255);
  assert.equal(im.data[(90 * im.width + 70) * 4], 0);
  assert.equal(im.data[(400 * im.width + 60) * 4], 0);
});

test('does not classify irregular detached marks or three-dot ellipses as leaders', () => {
  const im = image();
  for (let index = 0; index < 15; index++) im.rectangle(60 + index * 35, 100 + index % 4 * 12, 3, 3);
  assert.deepEqual(findDotLeaders(im.data, im.width, im.height), []);
});

test('removes intersecting grid borders and retains text inside the cells', () => {
  const im = image();
  for (const y of [40, 200]) im.rectangle(40, y, 700, 2);
  for (const x of [40, 390, 738]) im.rectangle(x, 40, 2, 162);
  im.rectangle(100, 80, 15, 25);
  const removed = eraseTableRulings(im.data, im.width, im.height);
  assert.equal(removed.length, 5);
  assert.equal(im.data[(40 * im.width + 200) * 4], 255);
  assert.equal(im.data[(90 * im.width + 105) * 4], 0);
});

test('a single underline crossing two strokes is not treated as a table', () => {
  const im = image();
  im.rectangle(40, 200, 700, 2);
  for (const x of [100, 300]) im.rectangle(x, 100, 2, 102);
  assert.deepEqual(eraseTableRulings(im.data, im.width, im.height), []);
  assert.equal(im.data[(200 * im.width + 200) * 4], 0);
});

test('splits dense rows across sparse noise bridges and reattaches detached Khmer marks', () => {
  const im = image();
  for (const y of [100, 160, 220]) im.rectangle(60, y, 500, 20);
  im.rectangle(80, 120, 1, 40); // A sparse vertical scan artifact must not merge two lines.
  im.rectangle(120, 125, 4, 5); // Detached subscript below the first line.
  const rows = findTextRows(im.data, im.width, im.height);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].top + rows[0].height >= 130);
  assert.ok(rows[0].top + rows[0].height <= rows[1].top);
});

test('blank pages and broad horizontal rules do not create text rows', () => {
  const im = image();
  assert.deepEqual(findTextRows(im.data, im.width, im.height), []);
  im.rectangle(40, 100, 1000, 4);
  assert.deepEqual(findTextRows(im.data, im.width, im.height), []);
});
