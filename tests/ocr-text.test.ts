import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanOcrText } from '../src/lib/ocr-text';

test('removes isolated mixed symbol artifacts, including the reported #10#$', () => {
  assert.equal(cleanOcrText('ភាសាខ្មែរ #10#$ សូមស្វាគមន៍\n@#$ English text\nDone #២៣#$'), 'ភាសាខ្មែរ សូមស្វាគមន៍\nEnglish text\nDone');
  assert.equal(cleanOcrText('#10#$\n\nText\n'), '\n\nText\n');
  assert.equal(cleanOcrText('Text (#10#$), next'), 'Text next');
});

test('preserves meaningful symbols, numeric values, Khmer marks and mixed text', () => {
  const text = [
    'លេខ ១០។ តម្លៃ ៛១០០០ និង $10.50 (10%)។',
    '#10 #១០ C# C++ user@example.com https://example.com/#10',
    '2 + 2 = 4; 10 >= 3 && 4 <= 5; x != y; 5 * 2; 2^10',
    '100%*10% $10*$10 10|&^2 €10.00 10%*20%*30%',
    '*** --- ___ ### ||| $$10$$ #hashtag @user',
    'passwordA#10#$Z សូមស្វាគមន៍។ ៕ ៗ ៘',
    'Column 1    Column 2\n\n\tIndented text  '
  ].join('\n');
  assert.equal(cleanOcrText(text), text);
});

test('preserves line structure and only trims spaces left by removed noise', () => {
  assert.equal(cleanOcrText('  Text    #10#$ next\r\n\t@#$\r\nLast  '), '  Text    next\r\n\r\nLast  ');
  const text = 'First #10#$ second\n@#$\nLast';
  assert.equal(cleanOcrText(cleanOcrText(text)), cleanOcrText(text));
  assert.equal(cleanOcrText('Cafe\u0301'), 'Café');
});
