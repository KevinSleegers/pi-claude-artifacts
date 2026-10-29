import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseArtifactList, parseDesignList, parseFileList, parseFileSaved, parsePageRead } from '../src/parse.ts';
import { parseStream } from '../src/stream.ts';

const result = (name: string) => parseStream(readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8')).results;
const hash = '242f4a6e2599e1dcca1e1b1800044306d3bdb5faf7f0442f7a78e84921f60d16';
const jsonHash = 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356';
const mine = [
  { title: 'Example design 1', url: 'https://claude.ai/artifact/AAAA000000000000000002', scope: 'mine', kind: 'design' },
  { title: 'Example design 2', url: 'https://claude.ai/artifact/AAAA000000000000000003', scope: 'mine', kind: 'design' },
  { title: 'Example design 3', url: 'https://claude.ai/artifact/AAAA000000000000000004', scope: 'mine', kind: 'design' },
];
const shared = [
  { title: 'Example design 4', url: 'https://claude.ai/artifact/AAAA000000000000000005', scope: 'shared with the user', kind: 'design' },
  { title: 'Example design 5', url: 'https://claude.ai/artifact/AAAA000000000000000006', scope: 'shared with the user', kind: 'design' },
  { title: 'Example design 6', url: 'https://claude.ai/artifact/AAAA000000000000000007', scope: 'shared in the organization', kind: 'design' },
  { title: 'Example design 7', url: 'https://claude.ai/artifact/AAAA000000000000000008', scope: 'shared in the organization', kind: 'design' },
];

// Catches dropped rows, description leakage, and incorrect rel/audience mapping.
for (const [name, expected] of [['list-mine', mine], ['list-shared', shared]] as const) {
  const [r] = result(name);
  test(`design rows from ${name}: structured and text fallback`, () => {
    assert.deepEqual(parseDesignList('not a list', r.structured), expected);
    assert.deepEqual(parseDesignList(r.text), expected);
  });
}

test('design fallback preserves en dashes and takes the last artifact URL', () => {
  assert.deepEqual(parseDesignList('- (mine) Header – options — See https://claude.ai/artifact/AAAA000000000000000003 — https://claude.ai/artifact/AAAA000000000000000002'), [
    { title: 'Header – options', url: mine[0].url, scope: 'mine', kind: 'design' },
  ]);
  assert.deepEqual(parseDesignList('unrelated prose'), []);
});

const listed = [
  ['SKILL.md', 'text/markdown', 14],
  ['artifact-type/app.css', 'text/css', 14],
  ['artifact-type/app.js', 'text/javascript', 14],
  ['artifact-type/dc-runtime.js', 'text/javascript', 14],
  ['artifact-type/fast-edit-worker.js', 'text/javascript', 14],
  ...['brand-colors', 'brand-typography', 'craft', 'design-system-components', 'diagrams', 'format', 'print', 'questions', 'view-state'].map((name) => [`artifact-type/reference/${name}.md`, 'text/markdown', 14]),
  ['artifact-type/thumbnail/thumbnail.json', 'application/json', 3],
  ['index.html', 'text/html', 14],
  ...[1, 2, 3, 4].map((n) => [`project/Example-${n}.dc.html`, 'text/html', 14]),
  ['project/canvas.json', 'application/json', 3],
  ['project/ds/example_000000/components/bundle.css', 'text/css', 14],
  ['project/ds/example_000000/components/bundle.js', 'text/javascript', 14],
  ['project/ds/example_000000/tokens.css', 'text/css', 14],
  ['project/ds/example_000000/tokens.json', 'application/json', 3],
].map(([path, mime, bytes]) => ({ path, mime, bytes }));

test('file listing preserves every path, size and structured hash', () => {
  const [r] = result('list-files');
  assert.deepEqual(parseFileList('not a list', r.structured), {
    version: '1234567890-abcd', files: listed.map((f) => ({ ...f, sha256: f.bytes === 3 ? jsonHash : hash })), singlePage: false,
  });
  assert.deepEqual(parseFileList(r.text), { version: '1234567890-abcd', files: listed, singlePage: false });
});

test('file listing text also handles the own-design header', () => {
  assert.deepEqual(parseFileList('Published files of https://claude.ai/artifact/AAAA000000000000000002 (version 1234567890-abcd), an Artifact of type "Design", 1 files by path\n- "project/x.html"  text/html  42 bytes'), {
    version: '1234567890-abcd', files: [{ path: 'project/x.html', mime: 'text/html', bytes: 42 }], singlePage: false,
  });
});

test('saved reads parse metadata with or without inline content', () => {
  const paths = [
    ['project/ds/example_000000/components/bundle.css', 14, 'text/css', hash],
    ['project/ds/example_000000/tokens.json', 3, 'application/json', jsonHash],
    ['project/ds/example_000000/tokens.css', 14, 'text/css', hash],
    ['project/Example-1.dc.html', 14, 'text/html', hash],
  ] as const;
  result('read-batch-ok').forEach((r, i) => {
    const [path, bytes, mime, sha256] = paths[i];
    const expected = { path, bytes, mime, sha256, savedPath: `/tmp/example-cwd/staging/${path}`, version: '1234567890-abcd' };
    assert.deepEqual(parseFileSaved('not a saved line', r.structured), expected);
    assert.deepEqual(parseFileSaved(r.text), expected);
  });
  const [refused] = result('read-refused');
  assert.equal(parseFileSaved(refused.text, refused.structured), undefined);
});

test('saved-line fallback accepts the brief format without trailing prose or punctuation', () => {
  assert.deepEqual(parseFileSaved(`File saved: "/tmp/example/staging/project/x.css" (14 bytes, "text/css", sha256 ${hash}) — "project/x.css" from version example-v1`), {
    savedPath: '/tmp/example/staging/project/x.css', bytes: 14, mime: 'text/css', sha256: hash,
    path: 'project/x.css', version: 'example-v1',
  });
});

test('unknown or malformed structured shapes fall back rather than throw or drop rows', () => {
  const [designs] = result('list-mine');
  const [files] = result('list-files');
  const [saved] = result('read-batch-ok');
  const malformed = [null, [], 'unknown', {}, { type_instances: { instances: [null] } },
    { file_list: { ver: 'x', files: [{ path: 'x', size_bytes: -1 }] } },
    { file_read: { path: 'x' } }];
  for (const structured of malformed) {
    assert.deepEqual(parseDesignList(designs.text, structured), mine);
    assert.deepEqual(parseFileList(files.text, structured), { version: '1234567890-abcd', files: listed, singlePage: false });
    assert.deepEqual(parseFileSaved(saved.text, structured), parseFileSaved(saved.text));
  }
  // A valid empty structured list is authoritative, not a reason to use stale text.
  assert.deepEqual(parseDesignList(designs.text, { type_instances: { instances: [], extra: true } }), []);
  assert.deepEqual(parseFileList(files.text, { file_list: { ver: 'empty-v1', files: [], extra: true } }), { version: 'empty-v1', files: [], singlePage: false });
  assert.deepEqual(parseDesignList('unused', { ...(designs.structured as object), future: true }), mine);
  assert.deepEqual(parseFileList('unused', { ...(files.structured as object), future: true }),
    parseFileList(files.text, files.structured));
  assert.deepEqual(parseFileSaved('unused', { ...(saved.structured as object), future: true }),
    parseFileSaved(saved.text));
});

test('unrecognized file-list text fails explicitly rather than claiming an empty version', () => {
  assert.throws(() => parseFileList('This is not a file list'));
});

const anyMine = [
  { title: 'Example artifact 1', url: 'https://claude.ai/artifact/AAAA000000000000000001', scope: 'mine', kind: 'page' },
  { title: 'Example artifact 2', url: 'https://claude.ai/artifact/AAAA000000000000000002', scope: 'mine', kind: 'page' },
  { title: 'Example artifact 3', url: 'https://claude.ai/artifact/AAAA000000000000000003', scope: 'mine', kind: 'page' },
];
const anyShared = [4, 5, 6].map((n) => (
  { title: `Example artifact ${n}`, url: `https://claude.ai/artifact/AAAA0000000000000000${String(n).padStart(2, '0')}`, scope: 'shared with the user', kind: 'page' }));

// The untyped list marks shared rows with rel only; owned rows carry no rel at all.
for (const [name, expected] of [['list-any-mine', anyMine], ['list-any-shared', anyShared]] as const) {
  const [r] = result(name);
  test(`artifact rows from ${name}: structured and text fallback`, () => {
    assert.deepEqual(parseArtifactList('not a list', r.structured), expected);
    assert.deepEqual(parseArtifactList(r.text), expected);
    assert.deepEqual(parseArtifactList(r.text, { ...(r.structured as object), artifacts: 'unknown' }), expected);
  });
}

test('design rows are marked as designs', () => {
  assert.ok(parseDesignList(result('list-mine')[0].text).every((row) => row.kind === 'design'));
});

test('artifact fallback keeps a dash inside the title and drops the updated suffix', () => {
  assert.deepEqual(parseArtifactList('- (mine) Legacy — Engine – notes — https://claude.ai/artifact/AAAA000000000000000001 — updated 2026-01-01\n- (shared) Plain — https://claude.ai/artifact/AAAA000000000000000002'), [
    { title: 'Legacy — Engine – notes', url: anyMine[0].url, scope: 'mine', kind: 'page' },
    { title: 'Plain', url: anyMine[1].url, scope: 'shared with the user', kind: 'page' },
  ]);
  assert.deepEqual(parseArtifactList('unrelated prose'), []);
});

test('single-page listings are flagged, multi-file ones are not', () => {
  const [page] = result('list-files-single-page');
  const expected = { version: '1234567890-abcd', files: [], singlePage: true };
  assert.deepEqual(parseFileList('not a list', page.structured), expected);
  assert.deepEqual(parseFileList(page.text), expected);
  assert.equal(parseFileList(result('list-files')[0].text).singlePage, false);
});

test('a file path is untrusted data and cannot flag a single page', () => {
  const phrase = 'none — this version is a single page with no separately published files; read the page itself with its `url`.';
  const [page] = result('list-files-single-page');
  const file = { path: 'a this version is a single page b.html', content_type: 'text/html', size_bytes: 1 };
  assert.equal(parseFileList(phrase, { file_list: { ver: 'v1', files: [file] } }).singlePage, false);
  const text = 'Published files of https://claude.ai/artifact/AAAA000000000000000001 (version v1):\n'
    + '- "this version is a single page" text/html 1 bytes\n- "a/this version is a single page.html" text/html 1 bytes';
  const parsed = parseFileList(text);
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.singlePage, false);
  assert.equal(parseFileList(page.text).singlePage, true);
});

test('the other-organization error is preserved for the caller', () => {
  const [r] = result('list-files-other-org');
  assert.equal(r.isError, true);
  assert.match(r.text, /another of the user's organizations/);
});

test('page reads yield the saved HTML path, size, version and title', () => {
  const [r] = result('read-page');
  const expected = {
    savedPath: '/example/config/projects/-example-cwd/00000000-0000-4000-8000-000000000002/tool-results/artifact-00000000-1234567890-abcd.html',
    bytes: 14, version: '1234567890-abcd', title: 'Example artifact 1',
  };
  assert.deepEqual(parsePageRead(r.text, r.structured), expected);
  const { read: _read, ...withoutRead } = r.structured as Record<string, unknown>;
  assert.equal(parsePageRead(r.text, withoutRead), undefined);
  assert.equal(parsePageRead('no saved path here', r.structured), undefined);
  assert.equal(parsePageRead(r.text), undefined);
});
