import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processImageBatch, type ImageBatchStore, type PageImage } from '../src/lib/ocr-batch';

function batch() {
  const events: string[] = [];
  const pages = new Map<number, PageImage>();
  const store: ImageBatchStore = {
    async put(number, image) { events.push(`store ${number}`); pages.set(number, image); },
    async get(number) { return pages.get(number)!; },
    async remove(number) { pages.delete(number); },
    async dispose() { events.push('cleanup'); pages.clear(); },
  };
  return { events, pages, store };
}

test('renders the complete lossless image batch before OCR, retaining page order', async () => {
  const { events, pages, store } = batch();
  await processImageBatch({ count: 3, store, signal: new AbortController().signal,
    async render(number) { events.push(`render ${number}`); return { blob: new Blob([String(number)], { type: 'image/png' }), dpi: 300 }; },
    async recognize(image, number) {
      events.push(`OCR ${number}`);
      assert.equal(image.blob.type, 'image/png');
      assert.equal(await image.blob.text(), String(number));
      if (number === 1) assert.equal(pages.size, 3);
    },
  });
  assert.deepEqual(events, ['render 1', 'store 1', 'render 2', 'store 2', 'render 3', 'store 3', 'OCR 1', 'OCR 2', 'OCR 3', 'cleanup']);
  assert.equal(pages.size, 0);
});

test('cancels preparation without starting OCR and removes temporary images', async () => {
  const { events, pages, store } = batch();
  const controller = new AbortController();
  await assert.rejects(processImageBatch({ count: 3, store, signal: controller.signal,
    async render(number) { if (number === 2) controller.abort(); return { blob: new Blob(), dpi: 300 }; },
    async recognize() { assert.fail('OCR must not start on a partial image batch'); },
  }), { name: 'AbortError' });
  assert.equal(events.at(-1), 'cleanup');
  assert.equal(pages.size, 0);
});

test('cleans up after storage failure and OCR failure', async () => {
  for (const failure of ['storage', 'OCR']) {
    const { events, pages, store } = batch();
    if (failure === 'storage') store.put = async () => { throw new Error('storage'); };
    await assert.rejects(processImageBatch({ count: 2, store, signal: new AbortController().signal,
      async render() { return { blob: new Blob(), dpi: 300 }; },
      async recognize() { throw new Error('OCR'); },
    }), new RegExp(failure));
    assert.equal(events.at(-1), 'cleanup');
    assert.equal(pages.size, 0);
  }
});
