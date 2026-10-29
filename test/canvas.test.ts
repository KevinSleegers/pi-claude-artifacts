import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readArtboards } from '../src/canvas.ts';

test('canvas boards follow explicit order rather than object insertion order', () => {
  assert.deepEqual(readArtboards(readFileSync(new URL('./fixtures/canvas.json', import.meta.url), 'utf8')), [
    { file: 'Example-2.dc.html', title: 'Example details', w: 390, h: 844 },
    { file: 'Example-1.dc.html', title: 'Example overview', w: 1440, h: 900, page: 'example-page' },
  ]);
});

test('invalid canvas JSON or shape is harmless and malformed boards are skipped', () => {
  for (const json of ['{', 'null', '[]', '{}', '{"boards":[],"order":[]}']) {
    assert.deepEqual(readArtboards(json), []);
  }
  assert.deepEqual(readArtboards(JSON.stringify({
    boards: { good: { title: 'Example', w: 10, h: 20, extra: true }, bad: null,
      invalid: { title: 'Example invalid', w: -1, h: 20 } },
    order: ['bad', 'missing', 'invalid', 'good'],
  })), [{ file: 'good', title: 'Example', w: 10, h: 20 }]);
});
