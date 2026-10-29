import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('../scripts/live-probe.mjs', import.meta.url));
await mkdir('/tmp/pi-claude-artifacts-probe', { recursive: true });
const root = await mkdtemp('/tmp/pi-claude-artifacts-probe/helper-continuation-');
await mkdir(join(root, 'bin'));
// Only replace the external model process; run the real helper and inspect its child boundary.
await writeFile(join(root, 'bin/claude'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.env.PI_CA_SPAWN_MARKER) writeFileSync(process.env.PI_CA_SPAWN_MARKER, 'spawned');
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: {
  config: process.env.CLAUDE_CONFIG_DIR, artifact: process.env.CLAUDE_CODE_ARTIFACT,
  staging: process.env.PI_CA_STAGING, blocked: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
} }));
`, { mode: 0o700 });

for (const via of ['--settings', 'project-settings']) {
  test(`read staging is inside a fresh child cwd (${via})`, async () => {
    const output = join(root, `${via}.jsonl`);
    const result = spawnSync(process.execPath, [helper, output, 'Read-only: save to {{STAGING}}.', via], {
      encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
        PI_CLAUDE_ARTIFACTS_CONFIG_DIR: '~/.claude-example',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    const child = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(child.env.staging, join(child.cwd, 'staging'));
    assert.equal(dirname(child.cwd), await realpath('/tmp/pi-claude-artifacts-probe'));
    assert.equal(child.args[1], `Read-only: save to ${child.cwd}/staging.`);
    assert.equal(child.env.config, join(homedir(), '.claude-example'));
    assert.equal(child.env.artifact, '1');
    assert.equal(child.env.blocked, undefined);
    assert.ok(!child.args.includes('--permission-mode'));
    assert.ok(child.args.includes('--strict-mcp-config'));
    assert.ok(child.args.includes('--no-session-persistence'));
    const settings = via === '--settings'
      ? JSON.parse(child.args[child.args.indexOf('--settings') + 1])
      : JSON.parse(await readFile(join(child.cwd, '.claude/settings.json'), 'utf8'));
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Artifact|ArtifactComments|ArtifactData');
  });
}

test('no-artifact probe removes the inherited enabling variable', async () => {
  const output = join(root, 'no-artifact.jsonl');
  const result = spawnSync(process.execPath, [helper, output, 'Read-only: no tool calls.', '--settings', '--no-artifact'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
      PI_CLAUDE_ARTIFACTS_CONFIG_DIR: '/tmp/claude-example',
      CLAUDE_CODE_ARTIFACT: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(child.env.config, '/tmp/claude-example');
  assert.equal(child.env.artifact, undefined);
  assert.equal(child.env.blocked, undefined);
});

test('missing config environment variable is rejected before starting a child', async () => {
  const marker = join(root, 'missing-config-spawned');
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, PI_CA_SPAWN_MARKER: marker };
  delete env.PI_CLAUDE_ARTIFACTS_CONFIG_DIR;
  const result = spawnSync(process.execPath, [helper, join(root, 'missing-config.jsonl'), 'Read-only test'], {
    encoding: 'utf8', env,
  });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PI_CLAUDE_ARTIFACTS_CONFIG_DIR.*required/);
});

test('auto permission mode is rejected before starting a child', () => {
  const result = spawnSync(process.execPath, [helper, join(root, 'auto.jsonl'), 'Read-only test', '--settings', 'auto'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});
