import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { ArtifactUnreachableError, ArtifactsUnavailableError, FetchIncompleteError, NothingToFetchError, ReadRefusedError, StagingTamperedError, UnexpectedCallError, fetchArtifact, listArtifacts } from '../src/designs.ts';
import type { ClaudeRunner, RunRequest, RunResult } from '../src/runner.ts';
import { parseStream } from '../src/stream.ts';

const url = 'https://claude.ai/artifact/AAAA000000000000000005';
const version = '1234567890-abcd';
const digest = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
const fixture = (name: string, target = url): RunResult => {
  const run = { ...parseStream(readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8').replaceAll(url, target)), exitCode: 0 };
  // Recorded list calls include an optional limit; these service prompts request no limit.
  if (name === 'list-mine' || name === 'list-shared') delete run.calls[0].input.limit;
  return run;
};
const canvas = readFileSync(new URL('./fixtures/canvas.json', import.meta.url), 'utf8');
const instruction = 'Read-only. Call only what is listed. If a call answers that it must be repeated, repeat it once, identically.';
function requested(req: RunRequest): Record<string, unknown>[] {
  assert.ok(req.prompt.startsWith(instruction));
  return req.prompt.split('\n').filter((line) => line.startsWith('Artifact '))
    .map((line) => JSON.parse(line.slice('Artifact '.length)));
}

async function sandbox(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pi-ca-designs-test-'));
  const requests: RunRequest[] = [];
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    for (const req of requests) if (req.stagingDir) await rm(dirname(req.stagingDir), { recursive: true, force: true });
  });
  return { root, requests };
}

type FakeOptions = {
  list?: (run: RunResult) => void;
  read?: (run: RunResult, req: RunRequest, index: number) => Promise<void> | void;
  onRun?: (req: RunRequest, index: number) => void;
  textOnly?: boolean;
  // The artifact URL the fake Claude Code expects in every call.
  url?: string;
};
async function fetchFake(t: TestContext, options: FakeOptions = {}) {
  const { root, requests } = await sandbox(t);
  const target = options.url ?? url;
  const listing = fixture('list-files', target);
  const structured = listing.results[0].structured as { file_list: { files: { path: string; size_bytes: number; sha256: string }[] } };
  const board = structured.file_list.files.find((f) => f.path === 'project/canvas.json')!;
  board.size_bytes = Buffer.byteLength(canvas);
  board.sha256 = digest(canvas);
  // The structured result must win over the stale fixture text (which lists a 3-byte canvas).
  options.list?.(listing);
  const runner: ClaudeRunner = { async run(req) {
    const index = requests.push(req) - 1;
    options.onRun?.(req, index);
    assert.ok(req.maxTurns > 0 && req.timeoutMs > 0);
    if (index === 0) {
      assert.deepEqual(requested(req), [{ action: 'list', scope: 'files', url: target }]);
      if (options.textOnly) delete listing.results[0].structured;
      return listing;
    }
    assert.ok(req.stagingDir);
    assert.equal(req.stagingDir, await realpath(req.stagingDir));
    assert.equal(dirname(dirname(req.stagingDir)), await realpath(tmpdir()));
    const template = fixture('read-batch-ok');
    const calls = requested(req);
    const run: RunResult = { ...template, calls: [], results: [] };
    for (const [n, call] of calls.entries()) {
      assert.deepEqual(call, { action: 'read', url: target, path: call.path, out_dir: req.stagingDir });
      const path = call.path as string;
      const body = path === 'project/canvas.json' && !options.textOnly ? canvas
        : path.endsWith('.json') ? '{}\n' : 'Example file.\n';
      const savedPath = join(req.stagingDir, path);
      await mkdir(dirname(savedPath), { recursive: true });
      await writeFile(savedPath, body);
      const read = structuredClone(template.results[0]);
      read.toolUseId = `read-${n}`;
      read.structured = { file_read: { url: target, title: 'Example design 4', path, saved_to: savedPath,
        ver: version, size_bytes: Buffer.byteLength(body), content_type: 'text/plain', sha256: digest(body), source: true, foreign: true } };
      read.text = `File saved: ${JSON.stringify(savedPath)} (${Buffer.byteLength(body)} bytes, "text/plain", sha256 ${digest(body)}) — ${JSON.stringify(path)} from version ${version}.`;
      if (options.textOnly) delete read.structured;
      else read.text = 'Stale prose; rely on the structured read.';
      run.calls.push({ id: read.toolUseId, name: 'Artifact', input: call });
      run.results.push(read);
    }
    await options.read?.(run, req, index);
    return run;
  } };
  return { root, requests, runner, opts: { url, cwd: root, dest: 'output', maxBatchBytes: 28, configDir: '/tmp/unused-config' } };
}

// One run carries the typed and untyped list results of every requested scope.
function listRun(scopes: ('mine' | 'shared')[], edit: (name: string, run: RunResult) => void = () => {}): RunResult {
  const parts = scopes.flatMap((scope) => [`list-${scope}`, `list-any-${scope}`]);
  const runs = parts.map((name) => { const run = fixture(name); edit(name, run); return run; });
  return { ...runs[0], calls: runs.flatMap((run, i) => run.calls.map((call) => ({ ...call, id: `${parts[i]}-${call.id}` }))),
    results: runs.flatMap((run, i) => run.results.map((result) => ({ ...result, toolUseId: `${parts[i]}-${result.toolUseId}` }))) };
}

// Catches omitted scopes, a second run for all, and duplicate URL rows.
test('all lists typed and untyped calls for both scopes in one run, typed rows first', async () => {
  const run = listRun(['mine', 'shared']);
  const rows = await listArtifacts({ async run(req) {
    assert.deepEqual(requested(req), [
      { action: 'list', type: 'Design', scope: 'mine' }, { action: 'list', scope: 'mine' },
      { action: 'list', type: 'Design', scope: 'shared' }, { action: 'list', scope: 'shared' }]);
    return run;
  } }, 'all');
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[0], { title: 'Example design 1', url: 'https://claude.ai/artifact/AAAA000000000000000002', scope: 'mine', kind: 'design' });
  assert.deepEqual(rows[6], { title: 'Example design 7', url: 'https://claude.ai/artifact/AAAA000000000000000008', scope: 'shared in the organization', kind: 'design' });
  assert.deepEqual(rows.slice(7).map((row) => [row.title, row.kind]), [['Example artifact 1', 'page']]);
});

test('a URL in both a typed and an untyped result keeps the typed row', async () => {
  const org = 'https://claude.ai/artifact/AAAA000000000000000008';
  const run = listRun(['shared'], (name, listing) => {
    if (name !== 'list-any-shared') return;
    const structured = listing.results[0].structured as { artifacts: { url: string }[] };
    structured.artifacts[0].url = org;
  });
  const rows = await listArtifacts({ async run() { return run; } }, 'shared');
  assert.equal(rows.filter((row) => row.url === org).length, 1);
  assert.deepEqual(rows.find((row) => row.url === org),
    { title: 'Example design 7', url: org, scope: 'shared in the organization', kind: 'design' });
});

for (const scope of ['mine', 'shared'] as const) test(`list ${scope} forwards signal and only requests that scope`, async () => {
  const signal = new AbortController().signal;
  const rows = await listArtifacts({ async run(req) {
    assert.equal(req.signal, signal);
    assert.deepEqual(requested(req), [{ action: 'list', type: 'Design', scope }, { action: 'list', scope }]);
    return listRun([scope]);
  } }, scope, signal);
  assert.equal(rows.length, scope === 'mine' ? 4 : 5);
});

const unexpectedCalls: Record<string, (run: RunResult) => void> = {
  extraRead: (run) => { run.calls.push({ id: 'extra', name: 'Artifact', input: {
    action: 'read', url, path: 'index.html', out_dir: '/unrequested',
  } }); },
  extraList: (run) => { run.calls.push({ id: 'extra', name: 'Artifact', input: {
    action: 'list', type: 'Design', scope: 'shared',
  } }); },
  thirdRepeat: (run) => {
    run.calls.push({ ...structuredClone(run.calls[0]), id: 'repeat-1' },
      { ...structuredClone(run.calls[0]), id: 'repeat-2' });
  },
  extraField: (run) => { run.calls[0].input.unrequested = true; },
  wrongTool: (run) => { run.calls[0].name = 'ArtifactComments'; },
  wrongAction: (run) => { run.calls[0].input.action = 'create'; },
};
for (const field of ['scope', 'type', 'limit', 'url', 'path', 'out_dir']) {
  unexpectedCalls[`wrong-${field}`] = (run) => { run.calls[0].input[field] = 'unexpected'; };
}
for (const [fault, mutate] of Object.entries(unexpectedCalls)) {
  test(`listArtifacts rejects unexpected call ${fault}`, async () => {
    const run = fixture('list-mine');
    mutate(run);
    await assert.rejects(listArtifacts({ async run() { return run; } }, 'mine'), (error: unknown) =>
      error instanceof UnexpectedCallError && /Artifact/.test(error.message));
  });
  for (const phase of ['listing', 'read']) test(`fetch rejects unexpected call ${fault} in ${phase} and cleans R`, async (t) => {
    const { runner, opts, root, requests } = await fetchFake(t,
      phase === 'listing' ? { list: mutate } : { read: mutate });
    await mkdir(join(root, 'output'));
    await writeFile(join(root, 'output/old.txt'), 'old bytes');
    await assert.rejects(fetchArtifact(runner, { ...opts, overwrite: true }), (error: unknown) =>
      error instanceof UnexpectedCallError && /Artifact/.test(error.message));
    assert.deepEqual(await readdir(join(root, 'output')), ['old.txt']);
    assert.equal(await readFile(join(root, 'output/old.txt'), 'utf8'), 'old bytes');
    assert.equal(requests.length, phase === 'listing' ? 1 : 2);
    assert.equal(existsSync(dirname(requests[0].stagingDir!)), false);
  });
}

test('one identical repeat is allowed for each requested list call', async () => {
  const run = listRun(['mine']);
  run.calls.push(...run.calls.map((call) => ({ ...structuredClone(call), id: `${call.id}-repeat` })));
  assert.equal((await listArtifacts({ async run() { return run; } }, 'mine')).length, 4);
});

test('one identical repeat is allowed for each requested fetch call', async (t) => {
  const repeat = (run: RunResult) => { run.calls.push(...run.calls.map((call) => ({ ...structuredClone(call), id: `${call.id}-repeat` }))); };
  const { runner, opts } = await fetchFake(t, { list: repeat, read: repeat });
  assert.equal((await fetchArtifact(runner, opts)).files.length, 20);
});

test('no Artifact tool reports the manual export fallback', async () => {
  await assert.rejects(listArtifacts({ async run() { return fixture('init-no-artifact-tool'); } }, 'all'),
    (error: unknown) => error instanceof ArtifactsUnavailableError && /export.*claude\.ai/i.test(error.message));
});

test('missing scope results or unsuccessful runs cannot masquerade as an empty design list', async () => {
  for (const fault of ['missing', 'maxTurns', 'exitCode']) {
    const run = listRun(['mine']);
    if (fault === 'missing') run.results = [];
    if (fault === 'maxTurns') run.subtype = 'error_max_turns';
    if (fault === 'exitCode') run.exitCode = 1;
    await assert.rejects(listArtifacts({ async run() { return run; } }, 'mine'), /list.*failed|missing.*scope/i);
  }
});

test('a missing untyped result names the scope instead of listing only Designs', async () => {
  const run = listRun(['mine']);
  run.results = run.results.filter((result) => !result.toolUseId.startsWith('list-any-'));
  await assert.rejects(listArtifacts({ async run() { return run; } }, 'mine'), /^Error: Missing artifact list scope: mine/);
});

// Hand-derived batch boundaries for the fixture selection: 28-byte pairs, then oversized canvas.
test('fetch verifies selected files, batches, manifest and canvas; removes entire staging root', async (t) => {
  const { root, runner, opts, requests } = await fetchFake(t);
  const signal = new AbortController().signal;
  const manifest = await fetchArtifact(runner, { ...opts, signal });
  assert.deepEqual(requests.slice(1).map((req) => requested(req).map((call) => call.path)), [
    ['SKILL.md', 'artifact-type/reference/brand-colors.md'],
    ['artifact-type/reference/brand-typography.md', 'artifact-type/reference/craft.md'],
    ['artifact-type/reference/design-system-components.md', 'artifact-type/reference/diagrams.md'],
    ['artifact-type/reference/format.md', 'artifact-type/reference/print.md'],
    ['artifact-type/reference/questions.md', 'artifact-type/reference/view-state.md'],
    ['index.html', 'project/Example-1.dc.html'], ['project/Example-2.dc.html', 'project/Example-3.dc.html'],
    ['project/Example-4.dc.html'], ['project/canvas.json'],
    ['project/ds/example_000000/components/bundle.css', 'project/ds/example_000000/components/bundle.js'],
    ['project/ds/example_000000/tokens.css', 'project/ds/example_000000/tokens.json'],
  ]);
  assert.ok(requests.every((req) => req.signal === signal));
  assert.equal(manifest.url, url);
  assert.equal(manifest.version, version);
  assert.equal(manifest.kind, 'design');
  assert.equal(manifest.checksum, 'service');
  assert.equal(manifest.dest, join(root, 'output'));
  assert.equal(manifest.files.length, 20);
  for (const file of manifest.files) {
    const body = await readFile(join(manifest.dest, file.path));
    assert.equal(file.bytes, body.length);
    assert.equal(file.sha256, digest(body));
  }
  assert.deepEqual(manifest.skipped, ['artifact-type/app.css', 'artifact-type/app.js', 'artifact-type/dc-runtime.js',
    'artifact-type/fast-edit-worker.js', 'artifact-type/thumbnail/thumbnail.json']);
  assert.deepEqual(manifest.artboards, [
    { file: 'Example-2.dc.html', title: 'Example details', w: 390, h: 844 },
    { file: 'Example-1.dc.html', title: 'Example overview', w: 1440, h: 900, page: 'example-page' },
  ]);
  assert.ok(requests.every((req) => !existsSync(dirname(req.stagingDir!))));
});

test('text-only tool results still fetch and verify disk files', async (t) => {
  const { runner, opts } = await fetchFake(t, { textOnly: true });
  const manifest = await fetchArtifact(runner, opts);
  assert.equal(manifest.files.length, 20);
  assert.deepEqual(manifest.artboards, []);
});

// Each mutation removes evidence or changes disk/metadata; none may install a partial fetch.
const faults: Record<string, NonNullable<FakeOptions['read']>> = {
  omitted: (run) => { run.results.pop(); },
  maxTurns: (run) => { run.subtype = 'error_max_turns'; },
  badSavedHash: (run) => { (run.results[0].structured as any).file_read.sha256 = '0'.repeat(64); },
  badSavedSize: (run) => { (run.results[0].structured as any).file_read.size_bytes++; },
  wrongVersion: (run) => { (run.results[0].structured as any).file_read.ver = 'other-version'; },
  absentOnDisk: async (run) => { await rm((run.results[0].structured as any).file_read.saved_to); },
  changedOnDisk: async (run) => { await writeFile((run.results[0].structured as any).file_read.saved_to, 'Wrong bytes!!!'); },
  extraPath: (run) => { run.results.push({ ...run.results[0], structured: { file_read: {
    ...(run.results[0].structured as any).file_read, path: 'project/unrequested.html',
  } } }); },
  nonzeroExit: (run) => { run.exitCode = 1; },
};
for (const [name, fault] of Object.entries(faults)) test(`incomplete ${name} keeps staging and never creates dest`, async (t) => {
  const { runner, opts, requests, root } = await fetchFake(t, { read: fault });
  const error = await fetchArtifact(runner, opts).then(() => assert.fail('must reject'), (error: unknown) => error);
  assert.ok(error instanceof FetchIncompleteError);
  assert.ok(error.missing.length > 0);
  if (name === 'omitted') assert.ok(error.missing.includes('artifact-type/reference/brand-colors.md'));
  assert.equal(error.stagingDir, requests[1].stagingDir);
  assert.ok(existsSync(error.stagingDir));
  assert.equal(existsSync(join(root, 'output')), false);
});

test('an unrequested read call cannot disappear behind otherwise complete results', async (t) => {
  const { runner, opts, root, requests } = await fetchFake(t, { read(run) {
    run.calls.push({ id: 'extra-read', name: 'Artifact', input: {
      action: 'read', url, path: 'project/extra.html', out_dir: run.calls[0].input.out_dir,
    } });
  } });
  await assert.rejects(fetchArtifact(runner, opts), (error: unknown) =>
    error instanceof UnexpectedCallError && error.message.includes('project/extra.html'));
  assert.equal(existsSync(join(root, 'output')), false);
  assert.equal(existsSync(dirname(requests[0].stagingDir!)), false);
});

for (const field of ['sha256', 'size_bytes']) test(`verifies listing ${field} independently of SavedFile`, async (t) => {
  const { runner, opts } = await fetchFake(t, { list(run) {
    const file = (run.results[0].structured as any).file_list.files[0];
    if (field === 'sha256') file.sha256 = '0'.repeat(64);
    else file.size_bytes++;
  } });
  await assert.rejects(fetchArtifact(runner, opts), (error: unknown) =>
    error instanceof FetchIncompleteError && error.missing.includes('SKILL.md'));
});

for (const mode of ['denial', 'refusedText'] as const) test(`read ${mode} is a ReadRefusedError with paths`, async (t) => {
  const { runner, opts, root } = await fetchFake(t, { read(run) {
    if (mode === 'denial') run.denials = [run.calls[0]];
    else {
      const refused = fixture('read-refused').results[0];
      run.results[0] = { ...refused, toolUseId: run.calls[0].id };
      run.denials = [];
    }
  } });
  await assert.rejects(fetchArtifact(runner, opts), (error: unknown) =>
    error instanceof ReadRefusedError && error.paths.includes('SKILL.md'));
  assert.equal(existsSync(join(root, 'output')), false);
});

for (const unsafe of ['../escape', '/absolute', 'project/../../escape', 'artifact-type/../escape'])
  test(`rejects listed unsafe path ${unsafe} before reads`, async (t) => {
    const { runner, opts, requests } = await fetchFake(t, { list(run) {
      (run.results[0].structured as any).file_list.files[0].path = unsafe;
    } });
    await assert.rejects(fetchArtifact(runner, opts), /Unsafe artifact path/);
    assert.equal(requests.length, 1);
  });

test('savedPath outside staging, including symlink escapes, cannot be installed', async (t) => {
  const { runner, opts, root } = await fetchFake(t, { async read(run, req) {
    const path = join(root, 'outside');
    await writeFile(path, 'Example file.\n');
    await symlink(root, join(req.stagingDir!, 'escape'));
    (run.results[0].structured as any).file_read.saved_to = join(req.stagingDir!, 'escape/outside');
  } });
  await assert.rejects(fetchArtifact(runner, opts), (error: unknown) => error instanceof FetchIncompleteError);
  assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'Example file.\n');
});

for (const target of ['staging-symlink', 'staging-directory', 'root-symlink', 'root-directory'] as const) {
  for (const phase of ['listing', 'read']) for (const unexpectedCall of [false, true])
    test(`rejects ${target} swap after ${phase}${unexpectedCall ? ' during call validation' : ''} without touching dest or swapped contents`, async (t) => {
    const { root, requests } = await sandbox(t);
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'sentinel'), 'leave outside alone');
    await mkdir(join(root, 'output'));
    await writeFile(join(root, 'output/old.txt'), 'old bytes');
    let moved = '';
    const swap = async (req: RunRequest) => {
      const path = target.startsWith('root') ? dirname(req.stagingDir!) : req.stagingDir!;
      moved = join(root, 'original');
      await rename(path, moved);
      if (target.endsWith('symlink')) await symlink(outside, path);
      else {
        await mkdir(path);
        await writeFile(join(path, 'sentinel'), 'leave replacement alone');
      }
      if (target.startsWith('root')) await mkdir(req.stagingDir!);
      if (phase === 'read') await writeFile(join(req.stagingDir!, 'index.html'), 'Example file.\n');
    };
    const runner: ClaudeRunner = { async run(req) {
      requests.push(req);
      const calls = requested(req);
      const run = fixture('read-batch-ok');
      run.calls = calls.map((input, n) => ({ id: `call-${n}`, name: 'Artifact', input }));
      if (requests.length === 1) {
        const listing = fixture('list-files');
        const data = listing.results[0].structured as any;
        data.file_list.files = [{ path: 'index.html', content_type: 'text/html', size_bytes: 14, sha256: digest('Example file.\n') }];
        run.results = [{ ...listing.results[0], toolUseId: 'call-0' }];
      } else {
        const savedPath = join(req.stagingDir!, 'index.html');
        await writeFile(savedPath, 'Example file.\n');
        run.results = [{ ...run.results[0], toolUseId: 'call-0', structured: { file_read: {
          url, path: 'index.html', saved_to: savedPath, ver: version,
          content_type: 'text/html', size_bytes: 14, sha256: digest('Example file.\n'),
        } } }];
      }
      if ((phase === 'listing' && requests.length === 1) || (phase === 'read' && requests.length === 2)) {
        await swap(req);
        if (unexpectedCall) run.calls.push({ id: 'unexpected', name: 'Artifact', input: { action: 'delete', url } });
      }
      return run;
    } };
    let failure: Error & { rootDir?: string };
    await assert.rejects(fetchArtifact(runner, { url, cwd: root, dest: 'output', overwrite: true, maxBatchBytes: 1000, configDir: '/tmp/unused-config' }),
      (error: unknown) => {
        assert.ok(unexpectedCall ? error instanceof UnexpectedCallError : error instanceof StagingTamperedError);
        failure = error as Error & { rootDir?: string };
        return true;
      });
    assert.equal(requests.length, phase === 'listing' ? 1 : 2);
    assert.deepEqual(await readdir(join(root, 'output')), ['old.txt']);
    assert.equal(await readFile(join(root, 'output/old.txt'), 'utf8'), 'old bytes');
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'leave outside alone');
    const fetchRoot = dirname(requests[0].stagingDir!);
    assert.ok(existsSync(fetchRoot), 'keep all of R when either pinned directory is replaced');
    const replacement = target.startsWith('root') ? fetchRoot : requests[0].stagingDir!;
    assert.ok(existsSync(replacement), 'do not remove the replacement directory or symlink');
    if (target.endsWith('directory')) {
      assert.equal(await readFile(join(replacement, 'sentinel'), 'utf8'), 'leave replacement alone');
    }
    assert.ok(existsSync(moved), 'the moved original must not be deleted through another path');
    assert.equal(failure!.rootDir, fetchRoot, 'expose the retained root on the original error');
  });
}

test('nonempty destination refuses before any runner call', async (t) => {
  const { runner, opts, root, requests } = await fetchFake(t);
  await mkdir(join(root, 'output'));
  await writeFile(join(root, 'output/old.txt'), 'keep me');
  await assert.rejects(fetchArtifact(runner, opts), /non.empty|overwrite/i);
  assert.equal(requests.length, 0);
  assert.equal(await readFile(join(root, 'output/old.txt'), 'utf8'), 'keep me');
});

test('overwrite replaces old contents only after every staged file verifies', async (t) => {
  let oldPath: string;
  const { runner, opts, root } = await fetchFake(t, { onRun() { assert.ok(existsSync(oldPath)); } });
  oldPath = join(root, 'output/old.txt');
  await mkdir(dirname(oldPath));
  await writeFile(oldPath, 'keep me until verified');
  const manifest = await fetchArtifact(runner, { ...opts, overwrite: true });
  assert.equal(existsSync(oldPath), false);
  assert.equal(manifest.files.length, 20);
  assert.deepEqual((await readdir(root)).sort(), ['output']);
});

test('failed overwrite preserves the entire old destination', async (t) => {
  const { runner, opts, root } = await fetchFake(t, { read: faults.badSavedHash });
  await mkdir(join(root, 'output'));
  await writeFile(join(root, 'output/old.txt'), 'old bytes');
  await assert.rejects(fetchArtifact(runner, { ...opts, overwrite: true }), FetchIncompleteError);
  assert.deepEqual(await readdir(join(root, 'output')), ['old.txt']);
  assert.equal(await readFile(join(root, 'output/old.txt'), 'utf8'), 'old bytes');
});

test('omitted destination uses approved generic fallback and refuses second fetch before runs', async (t) => {
  const { runner, opts, root, requests } = await fetchFake(t);
  const manifest = await fetchArtifact(runner, { ...opts, dest: undefined });
  assert.equal(manifest.dest, join(root, 'design/design'));
  const count = requests.length;
  await assert.rejects(fetchArtifact(runner, { ...opts, dest: undefined }), /non.empty|overwrite/i);
  assert.equal(requests.length, count);
});

for (const dest of ['..', '.']) test(`destination ${dest} cannot remove cwd or escape`, async (t) => {
  const { runner, opts, requests } = await fetchFake(t);
  await assert.rejects(fetchArtifact(runner, { ...opts, dest, overwrite: true }), /working directory|destination.*cwd/i);
  assert.equal(requests.length, 0);
});

test('destination symlink escape is refused before runs', async (t) => {
  const { runner, opts, root, requests } = await fetchFake(t);
  const outside = await mkdtemp(join(await realpath(tmpdir()), 'pi-ca-outside-test-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'escape'));
  await assert.rejects(fetchArtifact(runner, { ...opts, dest: 'escape/output' }), /outside/);
  assert.equal(requests.length, 0);
});

test('rechecks final paths after runs so a destination symlink cannot redirect writes', async (t) => {
  let rootPath: string;
  const { runner, opts, root } = await fetchFake(t, { async read(_run, _req, index) {
    if (index !== 1) return;
    await mkdir(join(rootPath, 'output'));
    await symlink(rootPath, join(rootPath, 'output/project'));
  } });
  rootPath = root;
  await assert.rejects(fetchArtifact(runner, opts), /non.empty|outside/i);
  assert.ok(existsSync(join(root, 'output/project')));
  assert.equal(existsSync(join(root, 'Example-1.dc.html')), false);
});

test('later batch tampering of a previously verified file is detected before installing', async (t) => {
  const { runner, opts } = await fetchFake(t, { async read(_run, req, index) {
    if (index === 2) await writeFile(join(req.stagingDir!, 'SKILL.md'), 'tampered bytes');
  } });
  await assert.rejects(fetchArtifact(runner, opts), (error: unknown) =>
    error instanceof FetchIncompleteError && error.missing.includes('SKILL.md'));
});

test('pre-abort prevents list and fetch runs', async (t) => {
  const { runner, opts, requests } = await fetchFake(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchArtifact(runner, { ...opts, signal: controller.signal }), { name: 'RunAborted' });
  await assert.rejects(listArtifacts(runner, 'all', controller.signal), { name: 'RunAborted' });
  assert.equal(requests.length, 0);
});

test('abort between list and read passes signal, cleans R and leaves destination absent', async (t) => {
  const controller = new AbortController();
  const { runner, opts, requests, root } = await fetchFake(t, { onRun(req) {
    assert.equal(req.signal, controller.signal);
    controller.abort();
  } });
  await assert.rejects(fetchArtifact(runner, { ...opts, signal: controller.signal }), { name: 'RunAborted' });
  assert.equal(requests.length, 1);
  assert.equal(existsSync(dirname(requests[0].stagingDir!)), false);
  assert.equal(existsSync(join(root, 'output')), false);
});

test('an invalid batch limit is refused before any run', async (t) => {
  const { runner, opts, requests } = await fetchFake(t);
  await assert.rejects(fetchArtifact(runner, { ...opts, maxBatchBytes: 0 }), /Batch limit/);
  assert.equal(requests.length, 0);
});

// The recorded refusal lists the fixture URL; point the call and its denial at the requested artifact.
function refusedListing(text?: string): RunResult {
  const run = fixture('list-files-other-org');
  for (const call of [...run.calls, ...run.denials]) call.input.url = url;
  if (text !== undefined) run.results[0].text = text;
  return run;
}

test('a listing claude.ai refuses is ArtifactUnreachableError with the service text, and nothing is read or written', async (t) => {
  const { runner, opts, requests, root } = await fetchFake(t, { list(run) { Object.assign(run, refusedListing()); } });
  const error = await fetchArtifact(runner, opts).then(() => assert.fail('must reject'), (error: unknown) => error);
  assert.ok(error instanceof ArtifactUnreachableError);
  assert.match(error.message, /^claude\.ai refused this artifact: .*another of the user's organizations/);
  assert.equal(requests.length, 1);
  assert.equal(existsSync(join(root, 'output')), false);
  assert.equal(existsSync(dirname(requests[0].stagingDir!)), false);
});

for (const text of ['PreToolUse:Artifact hook error: Artifact guard: refused.', `${url}: Artifact guard: refused.`])
  test(`a guard denial (${text.slice(0, 20)}…) is not reported as unreachable`, async (t) => {
    const { runner, opts, root } = await fetchFake(t, { list(run) { Object.assign(run, refusedListing(text)); } });
    const error = await fetchArtifact(runner, opts).then(() => assert.fail('must reject'), (error: unknown) => error);
    assert.ok(!(error instanceof ArtifactUnreachableError));
    assert.ok(error instanceof FetchIncompleteError);
    assert.equal(existsSync(join(root, 'output')), false);
  });

test('an empty listing that is not a single page is NothingToFetchError', async (t) => {
  const { runner, opts, requests, root } = await fetchFake(t, { list(run) {
    (run.results[0].structured as any).file_list.files = [];
  } });
  await assert.rejects(fetchArtifact(runner, opts), (error: unknown) =>
    error instanceof NothingToFetchError
      && error.message === `Nothing to fetch: claude.ai lists no files for ${url} and does not report a single page.`);
  assert.equal(requests.length, 1);
  assert.equal(existsSync(join(root, 'output')), false);
});

test('a listing whose files are all outside the fetched set is NothingToFetchError before any read', async (t) => {
  const { runner, opts, requests, root } = await fetchFake(t, { list(run) {
    (run.results[0].structured as any).file_list.files = [{ path: 'app.js', content_type: 'text/javascript', size_bytes: 3, sha256: digest('{}\n') }];
  } });
  await assert.rejects(fetchArtifact(runner, opts), (error: unknown) =>
    error instanceof NothingToFetchError
      && error.message === `Nothing to fetch: all 1 files claude.ai lists for ${url} are outside what this tool fetches. Export the artifact manually from claude.ai instead.`);
  assert.equal(requests.length, 1);
  assert.equal(existsSync(join(root, 'output')), false);
});

test('fetch also checks Artifact availability in the read session', async (t) => {
  const { runner, opts, root } = await fetchFake(t, { read(run) { run.tools = []; } });
  await assert.rejects(fetchArtifact(runner, opts), ArtifactsUnavailableError);
  assert.equal(existsSync(join(root, 'output')), false);
});

for (const name of ['RunAborted', 'RunTimeout', 'Error']) {
  for (const marker of [undefined, false, 'true', true]) test(`${name} with processGroupMayRemain=${JSON.stringify(marker)} ${marker === true ? 'keeps' : 'cleans'} R`, async (t) => {
    const failure = Object.assign(new Error('Runner failed'), { name },
      marker === undefined ? {} : { processGroupMayRemain: marker });
    const { runner, opts, root, requests } = await fetchFake(t, { read() { throw failure; } });
    await mkdir(join(root, 'output'));
    await writeFile(join(root, 'output/old.txt'), 'old bytes');
    await assert.rejects(fetchArtifact(runner, { ...opts, overwrite: true }), (error: unknown) => error === failure);
    assert.equal(existsSync(dirname(requests[1].stagingDir!)), marker === true);
    if (marker === true) assert.equal((failure as Error & { stagingDir: string }).stagingDir, requests[1].stagingDir);
    assert.deepEqual(await readdir(join(root, 'output')), ['old.txt']);
    assert.equal(await readFile(join(root, 'output/old.txt'), 'utf8'), 'old bytes');
  });
}

const pageBody = 'Example page!\n';
const recordedSaved = '/example/config/projects/-example-cwd/00000000-0000-4000-8000-000000000002/tool-results/artifact-00000000-1234567890-abcd.html';
// Recorded fixtures name another artifact and a scrubbed saved path; point both at this test's url and file.
const pageFixture = (name: string, savedPath = recordedSaved, target = url): RunResult => ({ ...parseStream(
  readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8')
    .replaceAll('https://claude.ai/artifact/AAAA000000000000000001', target).replaceAll(recordedSaved, savedPath)), exitCode: 0 });
// Assumed Claude Code project slug of the run's cwd: every non-alphanumeric character becomes '-'.
const slugOf = (req: RunRequest) => dirname(req.stagingDir!).replace(/[^a-zA-Z0-9]/g, '-');

type PageOptions = {
  // Returns where the fake Claude Code says it saved the page; defaults to its observed location.
  save?: (configDir: string, req: RunRequest) => Promise<string>;
  read?: (run: RunResult, req: RunRequest) => Promise<void> | void;
  url?: string;
};
async function pageFake(t: TestContext, options: PageOptions = {}) {
  const { root, requests } = await sandbox(t);
  const configDir = join(root, 'config');
  await mkdir(join(configDir, 'projects'), { recursive: true });
  const savedFile = async (req: RunRequest) => {
    const path = join(configDir, 'projects', slugOf(req), '00000000-0000-4000-8000-000000000002',
      'tool-results', `artifact-00000000-${version}.html`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, pageBody);
    return path;
  };
  const runner: ClaudeRunner = { async run(req) {
    const index = requests.push(req) - 1;
    if (index === 0) return pageFixture('list-files-single-page', recordedSaved, options.url);
    const savedPath = options.save ? await options.save(configDir, req) : await savedFile(req);
    const run = pageFixture('read-page', savedPath, options.url);
    await options.read?.(run, req);
    return run;
  } };
  return { root, requests, runner, configDir, savedFile, opts: { url, cwd: root, dest: 'output', maxBatchBytes: 28, configDir } };
}
// The reason must reach the message (toolError drops cause) without the page body or the model summary.
async function rejectsIncomplete(fetching: Promise<unknown>, root: string, reason: RegExp) {
  await assert.rejects(fetching, (error: unknown) => error instanceof FetchIncompleteError
    && reason.test(error.message) && /Export the artifact manually from claude\.ai/.test(error.message)
    && !error.message.includes(pageBody.trim()) && !error.message.includes('placeholder summary')
    && existsSync(error.stagingDir));
  assert.equal(existsSync(join(root, 'output')), false);
}

test('page fetch installs index.html with a locally computed checksum', async (t) => {
  const { root, runner, opts, requests, configDir } = await pageFake(t);
  const unrelated = join(configDir, 'projects', '-private-tmp-pi-ca-fetch-other0', 'keep.txt');
  await mkdir(dirname(unrelated), { recursive: true });
  await writeFile(unrelated, 'another run');
  const manifest = await fetchArtifact(runner, opts);
  assert.equal(requests.length, 2);
  const read = requests[1];
  assert.equal(read.pageUrl, url);
  assert.ok(read.stagingDir);
  assert.equal(read.maxTurns, 4);
  assert.deepEqual(requested(read), [{ action: 'read', url }]);
  assert.equal(await readFile(join(root, 'output/index.html'), 'utf8'), pageBody);
  assert.deepEqual(manifest, { url, version, dest: join(root, 'output'), kind: 'page', checksum: 'local',
    files: [{ path: 'index.html', bytes: Buffer.byteLength(pageBody), sha256: digest(pageBody) }], artboards: [], skipped: [] });
  assert.equal(existsSync(join(configDir, 'projects', slugOf(read))), false);
  assert.equal(await readFile(unrelated, 'utf8'), 'another run');
  assert.equal(existsSync(dirname(read.stagingDir)), false);
});

test('page fetch refuses a saved path outside the config projects dir', async (t) => {
  const { root, runner, opts } = await pageFake(t, { async save() {
    const path = join(root, 'elsewhere', `artifact-00000000-${version}.html`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, pageBody);
    return path;
  } });
  await rejectsIncomplete(fetchArtifact(runner, opts), root, /outside Claude Code's projects directory/);
  assert.equal(await readFile(join(root, 'elsewhere', `artifact-00000000-${version}.html`), 'utf8'), pageBody);
});

test('page fetch refuses a sibling directory that shares the projects prefix', async (t) => {
  const { root, runner, opts } = await pageFake(t, { async save(configDir) {
    const path = join(configDir, 'projects-evil', 'session', `artifact-00000000-${version}.html`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, pageBody);
    return path;
  } });
  await rejectsIncomplete(fetchArtifact(runner, opts), root, /outside Claude Code's projects directory/);
});

test('page fetch refuses a symlink under projects that points outside', async (t) => {
  const { root, runner, opts } = await pageFake(t, { async save(configDir, req) {
    const outside = join(root, `artifact-00000000-${version}.html`);
    await writeFile(outside, pageBody);
    const path = join(configDir, 'projects', slugOf(req), 'session', 'tool-results', `artifact-00000000-${version}.html`);
    await mkdir(dirname(path), { recursive: true });
    await symlink(outside, path);
    return path;
  } });
  await rejectsIncomplete(fetchArtifact(runner, opts), root, /outside Claude Code's projects directory/);
  assert.equal(await readFile(join(root, `artifact-00000000-${version}.html`), 'utf8'), pageBody);
});

test('page fetch refuses a directory symlink under projects that leads outside', async (t) => {
  const { root, runner, opts } = await pageFake(t, { async save(configDir, req) {
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside', `artifact-00000000-${version}.html`), pageBody);
    await mkdir(join(configDir, 'projects', slugOf(req)), { recursive: true });
    await symlink(join(root, 'outside'), join(configDir, 'projects', slugOf(req), 'session'));
    return join(configDir, 'projects', slugOf(req), 'session', `artifact-00000000-${version}.html`);
  } });
  await rejectsIncomplete(fetchArtifact(runner, opts), root, /outside Claude Code's projects directory/);
});

test('page fetch refuses a size that differs from read.bytes', async (t) => {
  const { root, runner, opts } = await pageFake(t, { async read(run) {
    await writeFile(run.results[0].text.match(/saved to (\/\S+)/)![1], pageBody.slice(1));
  } });
  await rejectsIncomplete(fetchArtifact(runner, opts), root, /not a regular file of the read size/);
});

test('page fetch refuses a version that differs from the listing', async (t) => {
  const { root, runner, opts } = await pageFake(t, { read(run) {
    (run.results[0].structured as any).artifactRead.ver = 'other-version';
  } });
  await rejectsIncomplete(fetchArtifact(runner, opts), root, /version does not match the listing/);
});

test('page fetch refuses a file name that does not carry the listing version', async (t) => {
  const { root, runner, opts } = await pageFake(t, { async save(configDir, req) {
    const path = join(configDir, 'projects', slugOf(req), 'session', 'tool-results', 'artifact-00000000-other-version.html');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, pageBody);
    return path;
  } });
  await rejectsIncomplete(fetchArtifact(runner, opts), root, /name does not carry the listing version/);
});

test('page fetch refuses a directory at the saved path', async (t) => {
  const { root, runner, opts } = await pageFake(t, { async save(configDir, req) {
    const path = join(configDir, 'projects', slugOf(req), 'session', 'tool-results', `artifact-00000000-${version}.html`);
    await mkdir(path, { recursive: true });
    return path;
  } });
  await rejectsIncomplete(fetchArtifact(runner, opts), root, /not a regular file of the read size/);
});

test('page fetch without a parsable page read saves nothing', async (t) => {
  const { root, runner, opts } = await pageFake(t, { read(run) { delete run.results[0].structured; } });
  await rejectsIncomplete(fetchArtifact(runner, opts), root, /result was not recognised/);
});

test('page read denial is a ReadRefusedError', async (t) => {
  const { root, runner, opts } = await pageFake(t, { read(run) { run.denials = [run.calls[0]]; } });
  await assert.rejects(fetchArtifact(runner, opts), (error: unknown) =>
    error instanceof ReadRefusedError && error.paths.includes('index.html'));
  assert.equal(existsSync(join(root, 'output')), false);
});

test('page read with an unrequested key is an UnexpectedCallError', async (t) => {
  const { root, runner, opts } = await pageFake(t, { read(run) { run.calls[0].input.prompt = 'summarise'; } });
  await assert.rejects(fetchArtifact(runner, opts), UnexpectedCallError);
  assert.equal(existsSync(join(root, 'output')), false);
});

test('page fetch leaves a projects directory that is not named after this run', async (t) => {
  const { root, runner, opts } = await pageFake(t, { async save(configDir) {
    const path = join(configDir, 'projects', '-Users-example-project', 'session', 'tool-results', `artifact-00000000-${version}.html`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, pageBody);
    return path;
  } });
  await fetchArtifact(runner, opts);
  assert.equal(await readFile(join(root, 'output/index.html'), 'utf8'), pageBody);
  assert.equal(await readFile(join(opts.configDir, 'projects', '-Users-example-project', 'session', 'tool-results', `artifact-00000000-${version}.html`), 'utf8'), pageBody);
});

test('a refused page fetch still removes the projects directory named after this run', async (t) => {
  const { root, runner, opts, requests, configDir } = await pageFake(t, { read(run) {
    (run.results[0].structured as any).artifactRead.ver = 'other-version';
  } });
  const unrelated = join(configDir, 'projects', '-private-tmp-pi-ca-fetch-other0', 'keep.txt');
  await mkdir(dirname(unrelated), { recursive: true });
  await writeFile(unrelated, 'another run');
  await rejectsIncomplete(fetchArtifact(runner, opts), root, /version does not match the listing/);
  assert.equal(existsSync(join(configDir, 'projects', slugOf(requests[1]))), false);
  assert.equal(await readFile(unrelated, 'utf8'), 'another run');
});

const codeUrl = 'https://claude.ai/code/artifact/00000000-0000-4000-8000-0000000000AA';
const coworkUrl = 'https://claude.ai/cowork/cse_000000000000?artifact=00000000-0000-4000-8000-0000000000AA';

test('a Cowork link fetches the Design under its claude.ai/code/artifact URL', async (t) => {
  const { runner, opts, requests } = await fetchFake(t, { url: codeUrl });
  const manifest = await fetchArtifact(runner, { ...opts, url: coworkUrl });
  assert.equal(manifest.url, codeUrl);
  assert.equal(manifest.files.length, 20);
  assert.ok(requests.every((req) => requested(req).every((call) => call.url === codeUrl)));
});

test('a Cowork link to a single page allows exactly the converted page URL', async (t) => {
  const { runner, opts, requests } = await pageFake(t, { url: codeUrl });
  const manifest = await fetchArtifact(runner, { ...opts, url: coworkUrl });
  assert.equal(manifest.url, codeUrl);
  assert.equal(requests[1].pageUrl, codeUrl);
  assert.deepEqual(requested(requests[1]), [{ action: 'read', url: codeUrl }]);
});

for (const link of ['https://claude.ai/cowork/cse_000000000000', 'https://claude.ai/cowork/cse_000000000000?artifact=not-a-uuid',
  'https://claude.ai/cowork/cse_000000000000?artifact=00000000-0000-4000-8000-0000000000AA0'])
  test(`a Cowork link without a valid artifact parameter is refused before any run (${link.slice(41) || 'none'})`, async (t) => {
    const { runner, opts, requests, root } = await fetchFake(t);
    await assert.rejects(fetchArtifact(runner, { ...opts, url: link }), /Cowork link does not name an artifact.*claude_artifact_list/);
    assert.equal(requests.length, 0);
    assert.equal(existsSync(join(root, 'output')), false);
  });
