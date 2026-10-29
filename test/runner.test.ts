import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { buildInvocation, createSpawnRunner } from '../src/runner.ts';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'ca-'));
const staging = join(root, 'staging');
mkdirSync(staging);
symlinkSync(staging, join(root, 'alias'));
after(() => rmSync(root, { recursive: true, force: true }));
const hookPath = fileURLToPath(new URL('../hook/artifact-guard.mjs', import.meta.url));
const opts = { configDir: '/example/claude-config', hookPath };
const req = { prompt: 'Read-only list.', maxTurns: 12, timeoutMs: 5000 };

// Catches inherited traffic suppression, missing isolation flags and an unsafe hook matcher.
test('buildInvocation reproduces the live-proven flags, environment and command hook', () => {
  const env = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: '/wrong',
    CLAUDE_CODE_ARTIFACT: '0', CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '1', PI_CA_STAGING: '/wrong', KEEP: 'yes' };
  const invocation = buildInvocation({ ...req, stagingDir: join(root, 'alias') }, { ...opts, env });
  assert.equal(invocation.command, 'claude');
  assert.deepEqual(invocation.args.slice(0, 14), ['-p', 'Read-only list.', '--model', 'haiku',
    '--output-format', 'stream-json', '--verbose', '--max-turns', '12', '--tools', 'Artifact',
    '--strict-mcp-config', '--no-session-persistence', '--settings']);
  assert.equal(invocation.args.length, 15);
  assert.ok(!invocation.args.includes('--permission-mode'));
  assert.deepEqual(JSON.parse(invocation.args[14]), { hooks: { PreToolUse: [{
    matcher: 'Artifact|ArtifactComments|ArtifactData', hooks: [{ type: 'command', command: `node '${hookPath}'`, onFailure: 'block' }],
  }] } });
  assert.deepEqual(invocation.env, { CLAUDE_CONFIG_DIR: '/example/claude-config', CLAUDE_CODE_ARTIFACT: '1',
    CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0', PI_CA_STAGING: realpathSync(staging), KEEP: 'yes' });
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(env.PI_CA_STAGING, '/wrong');
  assert.equal(invocation.settingsFile, undefined);
});

test('buildInvocation supports a fake executable and removes inherited staging when none is requested', () => {
  const invocation = buildInvocation(req, { ...opts, env: { PI_CA_STAGING: '/inherited' }, claudeBin: '/fake/claude' });
  assert.equal(invocation.command, '/fake/claude');
  assert.equal(invocation.env.PI_CA_STAGING, undefined);
});

test('page URL is passed to the guard only when requested', () => {
  const pageUrl = 'https://claude.ai/artifact/AAAA000000000000000009';
  assert.equal(buildInvocation({ ...req, pageUrl }, { ...opts, env: {} }).env.PI_CA_PAGE_URL, pageUrl);
  assert.equal(buildInvocation(req, { ...opts, env: { PI_CA_PAGE_URL: '/inherited' } }).env.PI_CA_PAGE_URL, undefined);
});

// Removing shell quoting must change the argv observed by the executable, not merely a string assertion.
for (const segment of ['$PI_CA_QUOTE_PROBE', '$(printf substitution)', '`printf substitution`', "package's", 'package with spaces']) {
  test(`hook command passes the literal path containing ${segment} to node`, () => {
    const bin = join(root, 'quote-bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$#" "$1"\n', { mode: 0o700 });
    const path = join(root, segment, 'artifact-guard.mjs');
    const invocation = buildInvocation(req, { ...opts, hookPath: path, env: {} });
    const hook = JSON.parse(invocation.args[14]).hooks.PreToolUse[0].hooks[0];
    const result = spawnSync('sh', ['-c', hook.command], { encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CA_QUOTE_PROBE: 'expanded' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `1\n${path}\n`);
  });
}

for (const mode of ['missing', 'crashing', 'timed-out'] as const) {
  test(`a ${mode} hook launcher is configured to block on failure`, () => {
    const path = join(root, `${mode}-hook.mjs`);
    if (mode === 'crashing') writeFileSync(path, 'throw new Error("guard crashed");\n');
    if (mode === 'timed-out') writeFileSync(path, 'setInterval(() => {}, 1000);\n');
    const invocation = buildInvocation(req, { ...opts, hookPath: path, env: {} });
    const hook = JSON.parse(invocation.args[14]).hooks.PreToolUse[0].hooks[0];
    const result = spawnSync('sh', ['-c', `exec ${hook.command}`], {
      encoding: 'utf8', timeout: 250,
    });
    if (mode === 'timed-out') assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT');
    else {
      assert.equal(result.status, 1);
      assert.match(result.stderr, mode === 'missing' ? /MODULE_NOT_FOUND/ : /guard crashed/);
    }
    assert.equal(hook.onFailure, 'block');
  });
}

// The only fake is the external executable: spawn, environment, pipes, cwd and signal handling are real.
const fake = join(root, 'fake-claude.mjs');
const fixture = fileURLToPath(new URL('./fixtures/read-batch-ok.jsonl', import.meta.url));
writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
const request = JSON.parse(process.argv[3]);
if (request.mode === 'sleep') {
  if (request.ignoreTerm) process.on('SIGTERM', () => {});
  const socket = connect(request.socket, () => socket.end(JSON.stringify({ pid: process.pid, cwd: process.cwd() })));
  setInterval(() => {}, 1000);
} else if (request.mode === 'tree') {
  const descendant = spawn(process.execPath, ['-e', \`
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    process.send('ready');
    process.disconnect();
  \`], { stdio: ['ignore', request.output ?? 'inherit', request.output ?? 'inherit', 'ipc'] });
  descendant.once('message', () => {
    const socket = connect(request.socket, () => socket.end(JSON.stringify({
      pid: process.pid, descendantPid: descendant.pid, cwd: process.cwd(),
    })));
  });
  setInterval(() => {}, 1000);
} else if (request.mode === 'fixture') {
  process.stdout.write(readFileSync(${JSON.stringify(fixture)}));
  process.exitCode = request.exitCode || 0;
} else {
  console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'boundary',
    content: JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), env: {
      config: process.env.CLAUDE_CONFIG_DIR, artifact: process.env.CLAUDE_CODE_ARTIFACT,
      autoOpen: process.env.CLAUDE_CODE_ARTIFACT_AUTO_OPEN, staging: process.env.PI_CA_STAGING,
      blocked: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    } }) }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', permission_denials: [] }));
}
`, { mode: 0o700 });
const runner = createSpawnRunner({ ...opts, claudeBin: fake });

function inspectRequest(stagingDir?: string) {
  return runner.run({ ...req, prompt: JSON.stringify({ mode: 'inspect' }), stagingDir });
}

test('runner runs staging requests in realpath(dirname(stagingDir)) and preserves caller files', { timeout: 5000 }, async () => {
  const result = await inspectRequest(join(root, 'alias'));
  const boundary = JSON.parse(result.results[0].text);
  assert.equal(boundary.cwd, realpathSync(root));
  assert.deepEqual(boundary.env, { config: '/example/claude-config', artifact: '1', autoOpen: '0', staging: realpathSync(staging) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.subtype, 'success');
  assert.ok(existsSync(staging));
});

test('runner uses a distinct fresh canonical cwd for every request without staging', { timeout: 10000 }, async () => {
  const first = JSON.parse((await inspectRequest()).results[0].text);
  const second = JSON.parse((await inspectRequest()).results[0].text);
  assert.notEqual(first.cwd, second.cwd);
  assert.notEqual(first.cwd, process.cwd());
  assert.equal(first.env.staging, undefined);
  assert.equal(second.env.staging, undefined);
  assert.ok(!existsSync(first.cwd), 'runner removes its owned cwd after reaping the child');
  assert.ok(!existsSync(second.cwd));
});

test('successful runs have no termination delay or leftover timers and abort listeners', { timeout: 5000 }, async () => {
  const timersBefore = activeTimeouts();
  const controller = new AbortController();
  const started = performance.now();
  const result = await runner.run({ ...req, timeoutMs: 60000,
    prompt: JSON.stringify({ mode: 'inspect' }), signal: controller.signal });
  assert.equal(result.exitCode, 0);
  assert.equal(result.subtype, 'success');
  assert.ok(performance.now() - started < 2000, 'normal runs do not wait for cancellation grace periods');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(activeTimeouts(), timersBefore);
  controller.abort();
});

test('runner parses real JSONL fixture output and preserves nonzero process exit codes', { timeout: 5000 }, async () => {
  const result = await runner.run({ ...req, prompt: JSON.stringify({ mode: 'fixture', exitCode: 7 }) });
  assert.equal(result.calls.length, 4);
  assert.equal(result.results.length, 4);
  assert.equal(result.exitCode, 7);
  assert.equal(result.subtype, 'success');
  assert.deepEqual(result.denials, []);
  assert.equal(result.costUsd, 0.00751554);
  assert.ok(result.results[0].structured);
});

type ProcessDetails = { pid: number; descendantPid?: number; cwd?: string };

async function readyProcess(t: TestContext) {
  const socket = join(root, `r-${Math.random().toString(16).slice(2)}.sock`);
  const server = createServer();
  let details: ProcessDetails | undefined;
  let readinessTimeout: ReturnType<typeof setTimeout>;
  t.after(async () => {
    clearTimeout(readinessTimeout);
    for (const pid of [details?.pid, details?.descendantPid]) {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const ready = new Promise<ProcessDetails>((resolve, reject) => {
    readinessTimeout = setTimeout(() => reject(new Error('fake executable did not report readiness')), 2000);
    server.on('error', reject);
    server.on('connection', (connection) => {
      let data = '';
      connection.on('data', (chunk) => { data += chunk; });
      connection.on('end', () => {
        clearTimeout(readinessTimeout);
        const reported: ProcessDetails = JSON.parse(data);
        details = reported;
        resolve(reported);
      });
      connection.on('error', reject);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  return { socket, ready };
}

function assertGone(pid: number) {
  assert.ok(Number.isInteger(pid) && pid > 0, 'fake process supplied its actual pid');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('abort rejects within two seconds only after the sleeping child pid is gone', { timeout: 5000 }, async (t) => {
  const { socket, ready } = await readyProcess(t);
  const controller = new AbortController();
  const running = runner.run({ ...req, prompt: JSON.stringify({ mode: 'sleep', socket }), signal: controller.signal });
  const rejected = assert.rejects(running, { name: 'RunAborted' });
  t.after(async () => { controller.abort(); await rejected; });
  const { pid } = await ready;
  const started = performance.now();
  controller.abort();
  await rejected;
  assert.ok(performance.now() - started < 2000);
  assertGone(pid);
});

test('timeout escalates to SIGKILL for a SIGTERM-resistant child and reaps its pid', { timeout: 6000 }, async (t) => {
  const { socket, ready } = await readyProcess(t);
  const running = runner.run({ ...req, timeoutMs: 500,
    prompt: JSON.stringify({ mode: 'sleep', socket, ignoreTerm: true }) });
  const rejected = assert.rejects(running, { name: 'RunTimeout' });
  t.after(async () => { await rejected; });
  const { pid } = await ready;
  await rejected;
  assertGone(pid);
});

// Cancellation must finish even when ignored descendant output lets the leader close first.
for (const [output, descendant] of [['inherit', 'a pipe-inheriting'], ['ignore', 'an output-ignoring']] as const) {
  for (const mode of ['abort', 'timeout'] as const) {
    test(`${mode} kills ${descendant} descendant after its parent exits and removes the owned cwd`,
      { timeout: 8000 }, async (t) => {
        const { socket, ready } = await readyProcess(t);
        const controller = new AbortController();
        const running = runner.run({ ...req, timeoutMs: mode === 'timeout' ? 750 : 10000,
          prompt: JSON.stringify({ mode: 'tree', socket, output }), signal: controller.signal });
        const settled = running.then(() => undefined, (error: unknown) => error);
        // Kill both PIDs before awaiting pipe closure, including when the regression fails.
        t.after(async () => { controller.abort(); await settled; });
        const { pid, descendantPid, cwd } = await ready;
        assert.ok(descendantPid && cwd, 'fake executable reports the descendant and runner-owned cwd');
        assert.ok(existsSync(cwd));
        process.kill(descendantPid, 0);
        if (mode === 'abort') controller.abort();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          const error = await Promise.race([settled, new Promise<'pending'>((resolve) => {
            deadline = setTimeout(() => resolve('pending'), 3500);
          })]);
          assert.notEqual(error, 'pending', `${mode}: run did not settle within 3500ms with ${descendant} descendant`);
          assert.ok(error instanceof Error);
          assert.equal(error.name, mode === 'abort' ? 'RunAborted' : 'RunTimeout');
          assertGone(pid);
          assertGone(descendantPid);
          assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' }, 'the whole process group is gone before rejection');
          assert.ok(!existsSync(cwd), 'runner removes its owned cwd before rejecting');
        } finally {
          clearTimeout(deadline);
        }
      });
  }
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`run did not settle within ${milliseconds}ms`)), milliseconds);
    })]);
  } finally {
    clearTimeout(deadline);
  }
}

const activeTimeouts = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

// Catches endless post-SIGKILL polling or unsafe cwd deletion when group disappearance is unproven.
for (const mode of ['abort', 'timeout'] as const) {
  test(`${mode} settles after the post-SIGKILL deadline when group probes stay alive and retains its cwd`,
    { timeout: 10000 }, async (t) => {
      const timersBefore = activeTimeouts();
      const { socket, ready } = await readyProcess(t);
      const controller = new AbortController();
      const kill = process.kill.bind(process);
      let details: ProcessDetails | undefined;
      let reportAlive = true;
      let killedAt: number | undefined;
      // Only observation is injected; real signals still kill and reap the actual fake executable.
      const signal = t.mock.method(process, 'kill', (pid: number, value?: NodeJS.Signals | number) => {
        if (details && pid === -details.pid) {
          if (value === 0 && reportAlive) return true;
          if (value === 'SIGKILL') killedAt = performance.now();
        }
        return kill(pid, value);
      });
      const running = runner.run({ ...req, timeoutMs: mode === 'timeout' ? 750 : 60000,
        prompt: JSON.stringify({ mode: 'sleep', socket, ignoreTerm: true }), signal: controller.signal });
      const settled = running.then(() => undefined, (error: unknown) => error);
      try {
        details = await ready;
        assert.ok(details.cwd, 'fake executable reports the runner-owned cwd');
        if (mode === 'abort') controller.abort();
        const error = await within(settled, 6500);
        assert.ok(error instanceof Error);
        assert.equal(error.name, mode === 'abort' ? 'RunAborted' : 'RunTimeout');
        assert.equal(error.message, mode === 'abort' ? 'Claude run aborted' : 'Claude run timed out');
        assert.ok('processGroupMayRemain' in error);
        assert.equal(error.processGroupMayRemain, true);
        assert.ok('pid' in error);
        assert.equal(error.pid, details.pid);
        assert.ok(killedAt !== undefined, 'cancellation escalated before its final observation window');
        const observationMs = performance.now() - killedAt;
        assert.ok(observationMs >= 2900 && observationMs < 4000, `post-SIGKILL settlement took ${observationMs}ms`);
        assert.ok(existsSync(details.cwd), 'unproven disappearance must preserve the owned cwd');
        assert.throws(() => kill(-details!.pid, 0), { code: 'ESRCH' }, 'real process group was reaped');
        assertGone(details.pid);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        assert.equal(activeTimeouts(), timersBefore, 'no request or polling timers remain after rejection');
      } finally {
        // Restore truthful probes before awaiting anything, so even the pre-fix endless loop can exit.
        reportAlive = false;
        controller.abort();
        if (details) {
          try { kill(-details.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
        try { await within(settled, 1000); }
        finally {
          signal.mock.restore();
          if (details?.cwd) {
            assert.throws(() => kill(-details!.pid, 0), { code: 'ESRCH' });
            rmSync(details.cwd, { recursive: true, force: true });
          }
        }
      }
    });
}

test('already aborted requests reject without invoking even a nonexistent executable', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createSpawnRunner({ ...opts, claudeBin: join(root, 'missing') }).run({ ...req, signal: controller.signal }),
    { name: 'RunAborted' });
});

test('spawn errors reject instead of waiting for timeout', { timeout: 5000 }, async () => {
  await assert.rejects(createSpawnRunner({ ...opts, claudeBin: join(root, 'missing') }).run(req), { code: 'ENOENT' });
});
