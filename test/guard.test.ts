import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
const root = mkdtempSync(join(realpathSync(tmpdir()), 'guard-'));
const staging = join(root, 'staging');
mkdirSync(staging);
mkdirSync(join(root, 'other'));
symlinkSync(staging, join(root, 'alias'));
after(() => rmSync(root, { recursive: true, force: true }));
const pageUrl = 'https://claude.ai/artifact/AAAA000000000000000009';
const env = { PI_CA_STAGING: staging, PI_CA_PAGE_URL: pageUrl };
const designEnv = { PI_CA_STAGING: staging };
const hook = fileURLToPath(new URL('../hook/artifact-guard.mjs', import.meta.url));
const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
  `import { decide } from ${JSON.stringify(new URL('../hook/artifact-guard.mjs', import.meta.url).href)}; void decide;`],
{ input: '', encoding: 'utf8', timeout: 1000 });
assert.equal(imported.status, 0, `hook must export decide without running its CLI: ${imported.stderr}`);
assert.equal(imported.stdout, '');
assert.equal(imported.stderr, '');
const { decide } = await import(hook);
const cases: [string, unknown, boolean, Record<string, string>?][] = [
  ['list', { tool_name: 'Artifact', tool_input: { action: 'list' } }, true],
  ['read exact staging', { tool_name: 'Artifact', tool_input: { action: 'read', out_dir: staging } }, true, designEnv],
  ['read canonical staging alias', { tool_name: 'Artifact', tool_input: { action: 'read', out_dir: join(root, 'alias') } }, true, designEnv],
  ['read other directory', { tool_name: 'Artifact', tool_input: { action: 'read', out_dir: join(root, 'other') } }, false, designEnv],
  ['read missing out_dir', { tool_name: 'Artifact', tool_input: { action: 'read' } }, false, designEnv],
  ['read nonexistent out_dir', { tool_name: 'Artifact', tool_input: { action: 'read', out_dir: join(root, 'missing') } }, false, designEnv],
  ['read staging during a page run', { tool_name: 'Artifact', tool_input: { action: 'read', out_dir: staging } }, false],
  ['page read with out_dir', { tool_name: 'Artifact', tool_input: { action: 'read', url: pageUrl, out_dir: staging } }, false],
  ['page read exact url', { tool_name: 'Artifact', tool_input: { action: 'read', url: pageUrl } }, true],
  ['page read other url', { tool_name: 'Artifact', tool_input: { action: 'read', url: 'https://claude.ai/artifact/AAAA000000000000000010' } }, false],
  ['page read with prompt', { tool_name: 'Artifact', tool_input: { action: 'read', url: pageUrl, prompt: 'x' } }, false],
  ['page read with page', { tool_name: 'Artifact', tool_input: { action: 'read', url: pageUrl, page: 2 } }, false],
  ...['publish', 'delete', 'share', 'create', 'update', 'rename', 'pin', 'comment'].map((action): [string, unknown, boolean] =>
    [action, { tool_name: 'Artifact', tool_input: { action } }, false]),
  ['missing action', { tool_name: 'Artifact', tool_input: {} }, false],
  ...['Bash', 'ArtifactComments', 'ArtifactData'].map((tool_name): [string, unknown, boolean] =>
    [tool_name, { tool_name, tool_input: { action: 'list' } }, false]),
  ['null input', null, false],
  ['missing input', {}, false],
];

// Each case catches a widening of the read-only boundary or a missing canonical-path comparison.
for (const [name, input, allow, caseEnv = env] of cases) {
  test(`guard decision and CLI: ${name}`, () => {
    const decision = decide(input, caseEnv);
    assert.equal(decision.allow, allow);
    if (!allow) assert.equal(typeof decision.reason, 'string');
    const cli = spawnSync(process.execPath, [hook], {
      input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, PI_CA_PAGE_URL: '', ...caseEnv }, timeout: 2000,
    });
    assert.equal(cli.status, allow ? 0 : 2, cli.stderr);
    if (allow) assert.deepEqual(JSON.parse(cli.stdout), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    else {
      assert.equal(cli.stdout, '');
      assert.match(cli.stderr, /Artifact guard:/);
    }
  });
}

test('read fails closed for absent, unresolvable or invalid staging paths', () => {
  const input = { tool_name: 'Artifact', tool_input: { action: 'read', out_dir: staging } };
  assert.equal(decide(input, {}).allow, false);
  assert.equal(decide(input, { PI_CA_STAGING: join(root, 'missing') }).allow, false);
  assert.equal(decide({ tool_name: 'Artifact', tool_input: { action: 'read', out_dir: 1 } }, env).allow, false);
  assert.equal(decide(input, { PI_CA_STAGING: realpathSync(staging) }).allow, true);
});

test('page read is denied when no page URL was requested', () => {
  const input = { tool_name: 'Artifact', tool_input: { action: 'read', url: pageUrl } };
  assert.equal(decide(input, { PI_CA_STAGING: staging }).allow, false);
  assert.equal(decide(input, { PI_CA_STAGING: staging, PI_CA_PAGE_URL: '' }).allow, false);
});

// A page run sets both variables; the staging branch ignores extra keys, so it must not widen the page read.
test('staging read is denied during a page run and allowed otherwise', () => {
  const read = { tool_name: 'Artifact', tool_input: { action: 'read', url: pageUrl, out_dir: staging } };
  const other = { tool_name: 'Artifact', tool_input: { action: 'read', url: 'https://claude.ai/artifact/AAAA000000000000000010', path: 'index.html', out_dir: staging } };
  assert.equal(decide(read, env).allow, false);
  assert.equal(decide(other, env).allow, false);
  assert.equal(decide(other, { PI_CA_STAGING: staging }).allow, true);
  assert.equal(decide(other, { PI_CA_STAGING: staging, PI_CA_PAGE_URL: '' }).allow, true);
  assert.equal(decide({ tool_name: 'Artifact', tool_input: { action: 'read', url: pageUrl } }, env).allow, true);
});

test('CLI rejects malformed JSON with no allow output', () => {
  const result = spawnSync(process.execPath, [hook], { input: '{broken', encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /invalid hook input; denied/);
});
