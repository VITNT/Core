import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:5173';

test('Office renderer reports availability', async () => {
  const response = await fetch(`${base}/api/render`);
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).available, 'boolean');
});

test('renderer rejects malformed and unsupported uploads', async () => {
  const malformed = await fetch(`${base}/api/render`, { method: 'POST', headers: { origin: base }, body: 'not multipart' });
  const availability = await (await fetch(`${base}/api/render`)).json();
  if (!availability.available) { assert.equal(malformed.status, 503); return; }
  assert.equal(malformed.status, 400);
  const form = new FormData();
  form.set('file', new File(['not an office document'], 'script.sh'));
  const unsupported = await fetch(`${base}/api/render`, { method: 'POST', headers: { origin: base }, body: form });
  assert.equal(unsupported.status, 415);
});

test('real DOCX and RTF render into PDF', { timeout: 150_000 }, async (context) => {
  const { available } = await (await fetch(`${base}/api/render`)).json();
  if (!available) { context.skip('LibreOffice is not installed.'); return; }
  const inputs = [
    new File([await readFile(new URL('./fixtures/sample.docx', import.meta.url))], 'sample.docx'),
    new File(['{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}}\\f0\\fs40 Khmer OCR integration test\\par Second line of document.}'], 'sample.rtf')
  ];
  for (const file of inputs) {
    const form = new FormData(); form.set('file', file);
    const response = await fetch(`${base}/api/render`, { method: 'POST', headers: { origin: base }, body: form });
    assert.equal(response.status, 200, `${file.name}: ${response.status === 200 ? '' : await response.text()}`);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buffer.byteLength > 1000);
    if (file.name.endsWith('.docx')) assert.match(buffer.toString('latin1'), /NotoSansKhmer/, 'The PDF must embed a font that actually renders Khmer glyphs.');
    await writeFile(join(tmpdir(), `khmer-ocr-${file.name}.pdf`), buffer);
  }
});
