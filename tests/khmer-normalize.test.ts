import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKhmer } from '../src/lib/khmer-normalize';

test('Khmer text gets one standard character order', () => {
  // Vowel typed before the subscript.
  assert.equal(normalizeKhmer('កា្រ'), 'ក្រា');
  // Legacy ស្រ្ត (coeng-ro first) becomes ស្ត្រ.
  assert.equal(normalizeKhmer('ស្រ្ត'), 'ស្ត្រ');
  // Register shifter after the vowel.
  assert.equal(normalizeKhmer('បា៊'), 'ប៊ា');
  // Two-part vowels typed as two code points, also once reordering joins them.
  assert.equal(normalizeKhmer('កេា'), 'កោ');
  assert.equal(normalizeKhmer('កេ្រី'), 'ក្រើ');
});

test('normalization leaves correct text, other scripts and spacing alone', () => {
  for (const text of ['ផែនដីវិទ្យា', 'ប្រវត្តិសាស្ត្រ', 'Invoice 2026 ផែនដី', 'សំណួរ១ ?  ចម្លើយ:\n']) {
    assert.equal(normalizeKhmer(text), text.normalize('NFC'));
    assert.equal(normalizeKhmer(normalizeKhmer(text)), normalizeKhmer(text));
  }
});
