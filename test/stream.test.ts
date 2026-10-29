import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseStream } from '../src/stream.ts';

const url = 'https://claude.ai/artifact/AAAA000000000000000005';
const batchPaths = [
  'project/ds/example_000000/components/bundle.css',
  'project/ds/example_000000/tokens.json',
  'project/ds/example_000000/tokens.css',
  'project/Example-1.dc.html',
];
const cases = [
  { file: 'list-mine', inputs: [{ action: 'list', type: 'Design', scope: 'mine', limit: 20 }], cost: 0.00319316 },
  { file: 'list-shared', inputs: [{ action: 'list', type: 'Design', scope: 'shared', limit: 20 }], cost: 0.00319316 },
  { file: 'list-files', inputs: [{ action: 'list', scope: 'files', url }], cost: 0.00272279 },
  { file: 'read-refused', inputs: [{ action: 'read', url, path: 'project/canvas.json', out_dir: '/tmp/example-staging' }], cost: 0.00272279 },
  { file: 'read-batch-ok', inputs: batchPaths.map((path) => ({ action: 'read', url, path, out_dir: '/tmp/example-cwd/staging' })), cost: 0.00751554 },
  { file: 'init-no-artifact-tool', inputs: [], cost: 0.00057189 },
];

// Catches dropped or mislinked tool events, lost structured hashes, and prose-based success inference.
for (const { file, inputs, cost } of cases) {
  test(`parseStream extracts tool facts from ${file}`, () => {
    const jsonl = readFileSync(new URL(`./fixtures/${file}.jsonl`, import.meta.url), 'utf8');
    const parsed = parseStream(jsonl);
    const ids = file === 'read-batch-ok'
      ? ['example-id-4', 'example-id-9', 'example-id-14', 'example-id-19'] : ['example-id-4'];
    assert.deepEqual(parsed.calls, inputs.map((input, i) => ({ id: ids[i], name: 'Artifact', input })));
    assert.equal(parsed.results.length, inputs.length);
    // The fixture's user events are the independent source of the result payload, not assistant prose.
    const users = jsonl.trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.type === 'user');
    users.forEach((event, i) => {
      assert.deepEqual(parsed.results[i], {
        toolUseId: ids[i], text: event.message.content[0].content,
        isError: file === 'read-refused', structured: event.tool_use_result,
      });
    });
    assert.deepEqual(parsed.tools, file === 'init-no-artifact-tool' ? [] : ['Artifact', 'ArtifactComments', 'ArtifactData']);
    assert.deepEqual(parsed.denials, file === 'read-refused'
      ? [{ id: 'example-id-4', name: 'Artifact', input: inputs[0] }] : []);
    assert.equal(parsed.subtype, 'success');
    assert.equal(parsed.costUsd, cost);
    assert.equal(parsed.exitCode, null);
  });
}

test('parseStream ignores model prose and unrelated events, handles text blocks and a final error', () => {
  const result = parseStream([
    '',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Artifact list: invented facts' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true,
      content: [{ type: 'text', text: 'first' }, { type: 'image', source: {} }, { type: 'text', text: 'second' }] }] } }),
    JSON.stringify({ type: 'result', subtype: 'error_max_turns', permission_denials: [] }),
    '',
  ].join('\n'));
  assert.deepEqual(result, { calls: [], results: [{ toolUseId: 'call-1', text: 'first\nsecond', isError: true }],
    tools: [], denials: [], subtype: 'error_max_turns', exitCode: null });
});

test('parseStream does not silently accept malformed JSONL', () => {
  assert.throws(() => parseStream('{broken}\n'), SyntaxError);
});
