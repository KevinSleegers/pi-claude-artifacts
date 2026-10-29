import assert from 'node:assert/strict';
import test from 'node:test';
import { preflight } from '../src/preflight.ts';

const configDir = '/tmp/example-claude-config';
const authenticated = {
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', analyticsDisabled: false,
  projectsDirectory: '/tmp/example-projects', configDirectory: configDir,
  email: 'reader@example.invalid', orgId: 'example-org-id', orgName: 'Example Studio', subscriptionType: 'team',
};
const result = (stdout: string, code: number | null = 0) => ({ code, stdout, stderr: '' });

// Catches misclassified spawn failures and accidentally trying auth after a missing binary.
test('missing claude gives actionable PATH guidance', async () => {
  const got = await preflight(async () => {
    throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  }, configDir, {});
  assert.deepEqual(got, { ok: false, message: "Claude Code (claude) was not found on Pi's PATH. Install it or start Pi from a shell where claude works." });
});

for (const version of ['2.1.311', '2.0.999', '1.99.999']) {
  test(`version ${version} refuses before checking login and names the minimum`, async () => {
    let calls = 0;
    const got = await preflight(async (_cmd, args) => {
      calls++;
      assert.deepEqual(args, ['--version']);
      return result(`${version} (Claude Code)\n`);
    }, configDir, {});
    assert.equal(calls, 1);
    assert.equal(got.ok, false);
    if (!got.ok) assert.match(got.message, /2\.1\.312/);
  });
}

for (const version of ['2.1.312', '2.2.0', '3.0.0']) {
  test(`version ${version} returns the authenticated organisation and plan with isolated child env`, async () => {
    const env = { PATH: '/example/bin', CLAUDE_CONFIG_DIR: '/wrong/account',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ARTIFACT: '0', CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '1' };
    const before = { ...env };
    const calls: string[][] = [];
    const got = await preflight(async (cmd, args, childEnv) => {
      assert.equal(cmd, 'claude');
      calls.push(args);
      assert.equal(childEnv.CLAUDE_CONFIG_DIR, configDir);
      assert.equal(Object.hasOwn(childEnv, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'), false);
      assert.equal(childEnv.CLAUDE_CODE_ARTIFACT, '1');
      assert.equal(childEnv.CLAUDE_CODE_ARTIFACT_AUTO_OPEN, '0');
      assert.equal(childEnv.PATH, '/example/bin');
      return result(args[0] === '--version' ? `${version} (Claude Code)` : JSON.stringify(authenticated));
    }, configDir, env);
    assert.deepEqual(calls, [['--version'], ['auth', 'status', '--json']]);
    assert.deepEqual(env, before);
    assert.deepEqual(got, { ok: true, version, org: 'Example Studio', plan: 'team' });
  });
}

for (const code of [0, 1]) {
  test(`loggedIn false (exit ${code}) points to login for the selected config`, async () => {
    const got = await preflight(async (_cmd, args) => result(args[0] === '--version'
      ? '2.1.312 (Claude Code)' : JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }), args[0] === '--version' ? 0 : code), configDir, {});
    assert.deepEqual(got, { ok: false, message: `Not logged in for ${configDir}. Run /claude-artifacts-login.` });
  });
}

test('logged in without an organisation or plan reports unknown rather than inventing values', async () => {
  const got = await preflight(async (_cmd, args) => result(args[0] === '--version'
    ? '2.1.312 (Claude Code)' : JSON.stringify({ loggedIn: true })), configDir, {});
  assert.deepEqual(got, { ok: true, version: '2.1.312', org: 'unknown', plan: 'unknown' });
});

for (const auth of ['not JSON', 'null', '{}', '{"loggedIn":"true"}']) {
  test(`malformed auth status ${auth} fails closed`, async () => {
    const got = await preflight(async (_cmd, args) => result(args[0] === '--version' ? '2.1.312 (Claude Code)' : auth), configDir, {});
    assert.equal(got.ok, false);
    if (!got.ok) assert.match(got.message, /auth status|login/);
  });
}

test('nonzero auth status cannot claim success even with loggedIn true', async () => {
  const got = await preflight(async (_cmd, args) => result(args[0] === '--version'
    ? '2.1.312 (Claude Code)' : JSON.stringify(authenticated), args[0] === '--version' ? 0 : 2), configDir, {});
  assert.equal(got.ok, false);
});

for (const response of [result('not a version'), result('2.1.312 (Claude Code)', 1)]) {
  test(`unreadable or failed version command fails closed (${response.code}: ${response.stdout})`, async () => {
    const got = await preflight(async () => response, configDir, {});
    assert.equal(got.ok, false);
    if (!got.ok) assert.match(got.message, /version|2\.1\.312/);
  });
}

test('other exec failures are actionable and do not expose a stack', async () => {
  const got = await preflight(async () => { throw new Error('permission denied'); }, configDir, {});
  assert.equal(got.ok, false);
  if (!got.ok) {
    assert.match(got.message, /permission denied/);
    assert.doesNotMatch(got.message, /\n\s+at /);
  }
});
