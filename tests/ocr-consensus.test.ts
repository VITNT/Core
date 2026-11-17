import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'tesseract.js';
import { consensusText, editDistance, medoidIndex } from '../src/lib/ocr-consensus';
import { preferConsensusLine, withConsensusText, type UncertainLine } from '../src/lib/ocr-read';
import { dictionaryScore, parseWordList } from '../src/lib/ocr-dictionary';

function page(text: string, confidence = 80): Page {
  const bbox = { x0: 16, y0: 16, x1: 100, y1: 40 };
  return { text: text + '\n', confidence, blocks: [{ bbox, paragraphs: [{ text: text + '\n', bbox, confidence, is_ltr: true,
    lines: [{ text: text + '\n', confidence, bbox, baseline: bbox, rowAttributes: { ascenders: 0, descenders: 0, rowHeight: 24 },
      words: text.split(' ').map((word) => ({ text: word, bbox, confidence, symbols: [] })),
    }],
  }] }] } as unknown as Page;
}

test('character vote corrects different single mistakes in each reading', () => {
  const truth = 'បរិយាកាសផែនដីដំបូង មានតែ អេល្យូម';
  const readings = ['បរិយាកាសផែននីដំបូង មានតែ អេល្យូម', 'ចរិយាកាសផែនដីដំបូង មានតែ អេល្យូម', 'បរិយាកាសផែនដីដំបូង មានតែ អេឈ្យូម', truth];
  assert.equal(consensusText(readings), truth);
  for (const reading of readings.slice(0, 3)) assert.ok(editDistance(reading, truth) > 0);
});

test('vote handles insertions and deletions, and keeps the first reading on ties', () => {
  assert.equal(consensusText(['ផែនដី', 'ផែនដីី', 'ផែនដ']), 'ផែនដី');
  assert.equal(consensusText(['សំបក ។', 'សំបក ។ \'', 'សំបក ។']), 'សំបក ។');
  assert.equal(consensusText(['ក', 'ខ', 'គ']), 'ក');
  assert.equal(consensusText(['ផែនដី', 'ផែនជី']), 'ផែនដី');
  assert.equal(consensusText([]), '');
  assert.equal(medoidIndex(['abc', 'abd', 'xyz']), 0);
});

test('voted text keeps one reading\'s structure and replaces only its line text', () => {
  const result = withConsensusText([page('ផែនដី', 70), page('ផែនជី', 90), page('ផែនដី', 60)]);
  assert.equal(result.text, 'ផែនដី\n');
  assert.equal(result.blocks![0].paragraphs[0].lines[0].text, 'ផែនដី\n');
  const fixed = withConsensusText([page('ផែនដី មាន', 70), page('ផែនជី មាន', 90), page('ផែនដី មា', 60)]);
  assert.equal(fixed.text, 'ផែនដី មាន\n');
  assert.equal(fixed.blocks![0].paragraphs[0].lines[0].words.length, 2);
});

test('a voted line may drop noise but not confident numbers or English', () => {
  assert.equal(preferConsensusLine(page('សែស.----សសស', 40), page('~~', 60)), true);
  assert.equal(preferConsensusLine(page('Invoice 2026 ផែនដី', 92), page('ផែនដី', 95)), false);
  assert.equal(preferConsensusLine(page('Invoice reference amount ផែនដី', 92), page('ផែនដី 2026', 95)), false);
  assert.equal(preferConsensusLine(page('Invoice 2026 ផែនដី', 92), page('Invoice 2026 ផែនដី', 70)), true);
  assert.equal(preferConsensusLine(page('', 0), page('ផែនដី', 70)), true);
});

const words = parseWordList('ពន្លឺ\nព្រះ\nអាទិត្យ\nផែនដី\nក\n');

test('word list ignores single letters and segments unspaced Khmer', () => {
  assert.equal(words.has('ក'), false);
  assert.deepEqual(dictionaryScore('ពន្លឺព្រះអាទិត្យ', words), [0, 3]);
  assert.deepEqual(dictionaryScore('ពន្លីព្រះអាទិត្យ', words)[0] > 0, true);
  assert.deepEqual(dictionaryScore('abc 123', words), [0, 0]);
});

test('word list settles a split vote in favour of a real word', () => {
  const wrong = 'ពន្លីព្រះអាទិត្យ', right = 'ពន្លឺព្រះអាទិត្យ';
  const readings = [wrong, wrong, right, wrong, right];
  assert.equal(consensusText(readings), wrong);
  assert.equal(consensusText(readings, words), right);
  assert.equal(withConsensusText(readings.map((text) => page(text)), words).text.trim(), right);
});

const more = parseWordList('ពន្លឺ\nព្រះ\nអាទិត្យ\nផែនដី\nអ្វី\nអ្វីខ្លះ\nខ្ល\nមាន\nដី\nជី\nពួក\nពូក\nដីគោក\nជំពូក\nភពផែនដី\nភព\nទឹក\nសំបក\nមេរៀនទី\nនិង\nតិច\nលិច\n');

test('word list accepts a letter only one reading saw when it completes a longer word', () => {
  const wrong = 'ពន្លីព្រះអាទិត្យ', right = 'ពន្លឺព្រះអាទិត្យ';
  assert.equal(consensusText([wrong, wrong, wrong, wrong, right], more), right);
  // ៖ (colon) read for ះ by four readings of five.
  assert.equal(consensusText(['អ្វីខ្ល៖ ?', 'អ្វីខ្លះ ?', 'អ្វីខ្ល៖ ?', 'អ្វីខ្ល៖ ?', 'អ្វីខ្ល៖ ?'], more), 'អ្វីខ្លះ ?');
});

test('word list replaces a look-alike letter that no reading saw, and reports it', async () => {
  const { voteReadings } = await import('../src/lib/ocr-consensus');
  const readings = ['ផែនជី', 'ផែនជី', 'ផែនថី', 'ផែនជី', 'ផែនថី'];
  assert.equal(consensusText(readings), 'ផែនជី');
  const vote = voteReadings(readings, more);
  assert.equal(vote.text, 'ផែនដី');
  assert.ok(vote.disputed.length > 0);
  // A colon after a complete word stays a colon.
  assert.equal(consensusText(['ផែនដីមាន៖', 'ផែនដីមាន៖', 'ផែនដីមាន៖'], more), 'ផែនដីមាន៖');
});

test('word list leaves correct text and unknown names alone', () => {
  for (const text of ['បរិយាកាសផែនដីដំបូង មានតែ អេល្យូម និងអ៊ីដ្រូសែន', 'យើងកាន់តែតិចទៅៗ និង ស្ថិតនៅឆ្ងាយពីគ្នាជាហេតុ',
    'ចម្លើយ: លោក អឺរ៉ាស្តែន បានវាស់ទំហំរបស់ផែនដីតាម', '> ម៉ង់តូ', 'សំបក ។', 'មេរៀនទី១']) {
    assert.equal(consensusText([text, text, text], more), text);
  }
});

test('a heading standing alone is matched to the nearest single dictionary word', async () => {
  const { voteReadings } = await import('../src/lib/ocr-consensus');
  // A bold heading font: no reading has ភ, and none has the whole of ជំពូក.
  const planet = voteReadings(['តពផែនជី', 'តពផ៉ែនដី', 'តពផែនពី', 'តពផែនជី', 'តពផែនដី'], more);
  assert.equal(planet.text, 'ភពផែនដី');
  assert.deepEqual(planet.disputed.at(-1), [0, 7]);
  assert.equal(consensusText(['ដីពួក១', 'fifa', 'ដីព្ជក១', 'ជីពូក9', 'ជីពួក១'], more), 'ជំពូក១');
  // Inside a longer line the same letters are left as read.
  assert.equal(consensusText(['តពផែនដី មានទឹក', 'តពផែនដី មានទឹក', 'តពផែនដី មានទឹក'], more), 'តពផែនដី មានទឹក');
});

test('vote reports how strongly readings agree and where they split', async () => {
  const { voteReadings } = await import('../src/lib/ocr-consensus');
  const same = voteReadings(['ផែនដី', 'ផែនដី', 'ផែនដី']);
  assert.equal(same.support, 1);
  assert.deepEqual(same.disputed, []);
  const split = voteReadings(['ផែនដី', 'ផែនជី', 'ផែនថី']);
  assert.ok(split.support < 1);
  assert.equal(split.disputed.length, 1);
  const [start, end] = split.disputed[0];
  assert.equal(split.text.slice(start, end), 'ដ');
  // A legacy-order reading and a standard one count as the same text.
  assert.equal(voteReadings(['ស្រ្ត', 'ស្ត្រ', 'ស្ត្រ']).support, 1);
});

function pageAt(text: string, confidence: number, x1: number): Page {
  const result = page(text, confidence);
  const line = result.blocks![0].paragraphs[0].lines[0];
  line.bbox = { ...line.bbox, x1 };
  return result;
}

test('voted line reports which reading supplied its boxes', () => {
  // The base reading (closest to the vote) is the third one, at another scale.
  const result = withConsensusText([pageAt('ផែនជី', 90, 100), pageAt('ផែនថី', 80, 100), pageAt('ផែនដី', 60, 125), pageAt('ផែនដី', 60, 125)]);
  assert.equal(result.text, 'ផែនដី\n');
  assert.equal(result.consensus.base, 2);
  assert.equal(result.blocks![0].paragraphs[0].lines[0].bbox.x1, 125);
});

test('voted line never keeps word text that is no longer in the line', () => {
  const result = withConsensusText([page('ផែនដី មាន', 70), page('ផែនជីមាន', 90), page('ផែនដីមាន', 60)]);
  const line = result.blocks![0].paragraphs[0].lines[0];
  assert.equal(line.text, 'ផែនដីមាន\n');
  for (const word of line.words) assert.ok(line.text.includes(word.text));
});

test('voted line lists disputed Khmer spans and lowers its confidence', () => {
  const result = withConsensusText([page('ផែនដី មាន', 95), page('ផែនជី មាន', 95), page('ផែនថី មាន', 95)]);
  const line = result.blocks![0].paragraphs[0].lines[0] as UncertainLine;
  assert.deepEqual(line.uncertain, ['ផែនដី']);
  assert.ok(line.confidence < 95);
});
