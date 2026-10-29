import assert from 'node:assert/strict';
import test from 'node:test';
import { batchFiles, selectFiles } from '../src/select.ts';

const file = (path: string, bytes = 14) => ({ path, bytes, mime: 'text/plain' });

// Catches runtime leakage and over-broad project/reference prefix matches.
test('selection includes only design files and reference notes, without mutating the input', () => {
  const keep = ['project/canvas.json', 'project/ds/example/tokens.css', 'project/ds/example/components/bundle.js',
    'index.html', 'SKILL.md', 'artifact-type/reference/format.md'];
  const drop = ['artifact-type/app.js', 'artifact-type/app.css', 'artifact-type/dc-runtime.js',
    'artifact-type/fast-edit-worker.js', 'artifact-type/thumbnail/thumbnail.json', 'other.txt',
    'project-other/x', 'artifact-type/reference-other/x'];
  const files = [...keep, ...drop].map((p) => Object.freeze(file(p)));
  assert.deepEqual(selectFiles(files), files.slice(0, keep.length));
  assert.equal(files.length, keep.length + drop.length);
});

test('batches retain every file exactly once, respect byte limits and isolate oversized files', () => {
  const files = [60000, 50000, 200000, 10000, 0, 100000].map((n, i) => file(`project/${i}`, n));
  const batches = batchFiles(files, 100000);
  assert.deepEqual(batches.flat().map((f) => f.path).sort(), files.map((f) => f.path).sort());
  for (const batch of batches) {
    assert.ok(batch.length > 0);
    assert.ok(batch.reduce((sum, f) => sum + f.bytes, 0) <= 100000 || batch.length === 1);
    if (batch.some((f) => f.bytes > 100000)) assert.equal(batch.length, 1);
  }
  assert.deepEqual(batchFiles([], 100000), []);
});

test('invalid sizes and batch limits cannot bypass the byte budget', () => {
  for (const max of [0, -1, NaN, Infinity]) assert.throws(() => batchFiles([file('project/x')], max));
  for (const bytes of [-1, NaN, Infinity, 1.5]) assert.throws(() => batchFiles([file('project/x', bytes)], 100000));
});
