import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { resolveConfigDir } from '../src/config.ts';
import { fetchArtifact, listArtifacts } from '../src/designs.ts';
import { createSpawnRunner, MAX_BATCH_BYTES } from '../src/runner.ts';
import type { ClaudeRunner } from '../src/runner.ts';

async function cleanupLiveSmoke(cwd: string | undefined, counts: { failures: number },
  report: () => void, remove: typeof rm = rm): Promise<void> {
  try {
    if (cwd) await remove(cwd, { recursive: true, force: true });
  } catch {
    counts.failures++;
    // Filesystem errors can contain fetched filenames; never retain the original error.
    throw new Error('Live smoke cleanup failed; see counts-only diagnostics.');
  } finally {
    report();
  }
}

// Catches filesystem errors leaking fetched names, and cleanup failures missing from the count.
for (const priorFailures of [0, 1]) {
  test(`live cleanup redacts private paths and counts failures (prior=${priorFailures})`, async () => {
    const privatePath = '/tmp/fake-private-design/hidden-board.dc.html';
    const counts = { failures: priorFailures };
    const diagnostics: string[] = [];
    let failure: unknown;
    try {
      await cleanupLiveSmoke('/tmp/fake-private-design', counts,
        () => { diagnostics.push(`failures=${counts.failures}`); },
        async () => { throw new Error(`EACCES: cannot remove ${privatePath}`); });
    } catch (error) {
      failure = error;
    }
    const reported = [...diagnostics, inspect(failure, { showHidden: true })].join('\n');
    assert.ok(!reported.includes(privatePath), 'Cleanup reporting must not expose the private path.');
    assert.ok(!reported.includes('hidden-board.dc.html'), 'Cleanup reporting must not expose fetched filenames.');
    assert.equal(counts.failures, priorFailures + 1);
    assert.deepEqual(diagnostics, [`failures=${priorFailures + 1}`]);
    assert.ok(failure instanceof Error, 'Cleanup failure must fail the test.');
    assert.equal(failure.message, 'Live smoke cleanup failed; see counts-only diagnostics.');
    assert.equal(Object.hasOwn(failure, 'cause'), false);
  });
}

// Catches real CLI/list/read integration failures and installed bytes that differ from the manifest.
test('live own-design list and verified fetch', {
  skip: process.env.PI_CA_LIVE === '1' ? false : 'Set PI_CA_LIVE=1 to enable the read-only live smoke test (uses your Claude plan).',
  timeout: 900_000,
}, async (t) => {
  const started = performance.now();
  let designs = 0;
  let files = 0;
  let verified = 0;
  let skipped = 0;
  let artboards = 0;
  let runs = 0;
  let costUsd = 0;
  let unreportedCosts = 0;
  const counts = { failures: 0 };
  let cwd: string | undefined;
  try {
    cwd = await mkdtemp(join(await realpath(tmpdir()), 'pi-ca-live-'));
    const configDir = resolveConfigDir(process.env, homedir(), (path) => {
      try { return readFileSync(path, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    });
    const delegate = createSpawnRunner({ configDir,
      hookPath: fileURLToPath(new URL('../hook/artifact-guard.mjs', import.meta.url)) });
    const runner: ClaudeRunner = { async run(request) {
      runs++;
      unreportedCosts++;
      const result = await delegate.run(request);
      if (result.costUsd !== undefined) {
        unreportedCosts--;
        costUsd += result.costUsd;
      }
      return result;
    } };
    const rows = await listArtifacts(runner, 'mine', t.signal);
    designs = rows.length;
    assert.ok(designs >= 1, 'Expected at least one own Design artifact.');
    assert.ok(rows[0].scope === 'mine', 'Expected the first design to be owned by the user.');
    const manifest = await fetchArtifact(runner, { url: rows[0].url, cwd,
      dest: './design/first', maxBatchBytes: MAX_BATCH_BYTES, configDir, signal: t.signal });
    files = manifest.files.length;
    skipped = manifest.skipped.length;
    artboards = manifest.artboards.length;
    assert.ok(files > 0, 'Expected fetched files.');
    for (const file of manifest.files) {
      // Read bytes only: fetched HTML, JavaScript and SKILL.md are never executed or followed.
      const body = await readFile(join(manifest.dest, file.path));
      assert.ok(body.length === file.bytes, 'Installed file size verification failed.');
      assert.ok(createHash('sha256').update(body).digest('hex') === file.sha256,
        'Installed file hash verification failed.');
      verified++;
    }
    assert.equal(verified, files);
  } catch (error) {
    counts.failures++;
    // Service errors can contain private URLs and paths; expose only safe classification counts.
    const name = error instanceof Error ? error.name : '';
    t.diagnostic(`unavailable=${Number(name === 'ArtifactsUnavailableError')} refused=${Number(name === 'ReadRefusedError')} incomplete=${Number(name === 'FetchIncompleteError')} timeout=${Number(name === 'RunTimeout')} assertion=${Number(name === 'AssertionError')}`);
    throw new Error('Live smoke failed; see counts-only diagnostics.');
  } finally {
    await cleanupLiveSmoke(cwd, counts, () => {
      t.diagnostic(`designs=${designs} files=${files} verified=${verified} skipped=${skipped} artboards=${artboards} runs=${runs} failures=${counts.failures} costUsd=${costUsd.toFixed(6)} unreportedCosts=${unreportedCosts} durationMs=${Math.round(performance.now() - started)}`);
    });
  }
});
