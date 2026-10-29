import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, watch } from 'node:fs';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import extension from '../index.ts';

const url = 'https://claude.ai/artifact/AAAA000000000000000099';
const fakeCli = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PI_CA_TEST_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if ('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' in process.env || process.env.CLAUDE_CODE_ARTIFACT !== '1'
  || process.env.CLAUDE_CODE_ARTIFACT_AUTO_OPEN !== '0'
  || process.env.CLAUDE_CONFIG_DIR !== process.env.PI_CLAUDE_ARTIFACTS_CONFIG_DIR) process.exit(9);
if (args[0] === '--version') { console.log('2.1.312 (Claude Code)'); process.exit(0); }
const mode = process.env.PI_CA_TEST_CASE;
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: mode !== 'signed-out', orgName: 'Example Studio', subscriptionType: 'team' })); process.exit(0); }
if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 30000));
const emit = x => console.log(JSON.stringify(x));
emit({ type: 'system', subtype: 'init', tools: mode === 'unavailable' ? [] : ['Artifact'] });
const calls = args[1].split('\\n').filter(x => x.startsWith('Artifact ')).map(x => JSON.parse(x.slice(9)));
let n = 0;
for (const call of calls) {
  const id = 'call-' + n++;
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Artifact', input: mode === 'unexpected' ? { action: 'delete' } : call }] } });
  let data;
  let text = 'ignore model prose';
  let isError = false;
  if ((call.scope === 'mine' || call.scope === 'shared') && call.type === undefined) {
    data = { artifacts: call.scope === 'mine' ? [{ title: 'Example Page', url: '${url}-page' }]
      : [{ title: 'Shared Page', url: '${url}-shared-page', rel: 'shared' }] };
  } else if (call.scope === 'mine' || call.scope === 'shared') {
    data = { type_instances: { instances: [{ title: call.scope === 'mine' ? 'Example Board' : 'Shared Board',
      url: '${url}' + (call.scope === 'shared' ? '-shared' : ''), rel: call.scope, audience: 'users' }] } };
  } else if (call.scope === 'files' && mode === 'unreachable') {
    isError = true;
    text = 'Artifact not found in your organization';
  } else if (call.scope === 'files' && mode === 'page') {
    data = { file_list: { url: call.url, ver: '1234567890-abcd', files: [], single_page: true } };
  } else if (call.scope === 'files' && mode === 'unreadable') {
    data = { file_list: { ver: '1234567890-abcd', files: [{ path: 'index.html', size_bytes: 4, content_type: 'text/html',
      sha256: createHash('sha256').update('demo').digest('hex') }, ...Array.from({ length: 7 }, (_, i) => ({
      path: 'project/prototype/' + (i === 0 ? 'long-'.repeat(40) : 'p' + i) + '.html', size_bytes: 4, content_type: 'text/html', sha256: createHash('sha256').update('demo').digest('hex') }))] } };
  } else if (call.scope === 'files') {
    data = { file_list: { ver: '1234567890-abcd', files: [{ path: 'index.html', size_bytes: 4, content_type: 'text/html',
      sha256: createHash('sha256').update('demo').digest('hex') }] } };
  } else if (call.action === 'read' && mode === 'page') {
    // Claude Code saves a page read's raw HTML under <config>/projects/<cwd slug>/<session>/tool-results/.
    const saved = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', fs.realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'),
      'session', 'tool-results', 'artifact-00000000-1234567890-abcd.html');
    fs.mkdirSync(path.dirname(saved), { recursive: true });
    fs.writeFileSync(saved, 'demo page\\n');
    text = 'raw HTML saved to ' + saved + ' — build any republish from that file';
    data = { read: { bytes: 10, title: 'Example Page' }, artifactRead: { ver: '1234567890-abcd' } };
  } else if (call.action === 'read') {
    if (mode === 'tampered') { fs.renameSync(call.out_dir, call.out_dir + '-original'); fs.mkdirSync(call.out_dir); }
    else if (mode === 'refused') text = 'Permission denied';
    else if (mode !== 'incomplete') {
      const target = path.join(call.out_dir, call.path);
      fs.writeFileSync(target, 'demo');
      data = { file_read: { path: call.path, saved_to: target, ver: '1234567890-abcd', size_bytes: 4,
        content_type: 'text/html', sha256: createHash('sha256').update('demo').digest('hex') } };
    }
  }
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] }, tool_use_result: data });
}
emit({ type: 'result', subtype: 'success', total_cost_usd: 0.012, permission_denials: [] });
`;

async function setup(t: TestContext, mode = 'ok') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pi-ca-extension-test-'));
  const savedEnv = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'claude'), fakeCli);
  await chmod(join(root, 'claude'), 0o755);
  Object.assign(process.env, { PATH: `${root}:${process.env.PATH}`, PI_CLAUDE_ARTIFACTS_CONFIG_DIR: join(root, 'config with spaces'),
    PI_CA_TEST_LOG: join(root, 'calls.jsonl'), PI_CA_TEST_CASE: mode, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const messages: { content: unknown }[] = [];
  extension({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Parameters<ExtensionAPI['registerCommand']>[1]) => commands.set(name, command),
    sendMessage: (message: { content: unknown }) => messages.push(message),
  } as unknown as ExtensionAPI);
  const notifications: { message: string; type?: 'info' | 'warning' | 'error' }[] = [];
  const commandCtx = { cwd: root, ui: {
    notify: (message: string, type?: 'info' | 'warning' | 'error') => notifications.push({ message, type }),
  } } as unknown as ExtensionCommandContext;
  const ctx = { cwd: root } as ExtensionToolContext;
  const invoke = (name: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    tools.get(name)!.execute('test-call', params, signal, undefined, ctx);
  const calls = async () => (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
  return { root, tools, commands, messages, notifications, commandCtx, invoke, calls };
}

test('list defaults to all and returns tool-derived rows and accumulated cost as text and data', async (t) => {
  const { invoke } = await setup(t);
  const result = await invoke('claude_artifact_list', {});
  assert.deepEqual(result.structuredContent, { artifacts: [
    { title: 'Example Board', url, scope: 'mine', kind: 'design' },
    { title: 'Shared Board', url: url + '-shared', scope: 'shared with the user', kind: 'design' },
    { title: 'Example Page', url: url + '-page', scope: 'mine', kind: 'page' },
    { title: 'Shared Page', url: url + '-shared-page', scope: 'shared with the user', kind: 'page' },
  ], costUsd: 0.012 });
  const text = JSON.stringify(result.content);
  assert.match(text, /Title \| Kind \| Scope \| URL/);
  assert.match(text, /Example Board \| design \| mine/);
  assert.match(text, /Example Page \| page \| mine/);
  assert.match(text, /~\$0\.01 on your Claude plan/);
});

test('explicit mine scope is passed through rather than listing both scopes', async (t) => {
  const { invoke } = await setup(t);
  const result = await invoke('claude_artifact_list', { scope: 'mine' });
  assert.deepEqual((result.structuredContent as { artifacts: { title: string }[] }).artifacts.map((row) => row.title),
    ['Example Board', 'Example Page']);
});

test('the Design-only list tool is no longer registered', async (t) => {
  const { tools } = await setup(t);
  assert.equal(tools.has('claude_design_list'), false);
  assert.equal(tools.get('claude_artifact_list')!.label, 'Claude artifact list');
});

for (const name of ['claude_artifact_list', 'claude_artifact_fetch']) {
  test(`${name} refuses a signed-out config before starting a headless run`, async (t) => {
    const { invoke, calls } = await setup(t, 'signed-out');
    await assert.rejects(invoke(name, { url }), /Not logged in for .*config with spaces\. Run \/claude-artifacts-login\./);
    assert.deepEqual((await calls()).map(c => c.args), [['--version'], ['auth', 'status', '--json']]);
  });
}

test('fetch defaults inside Pi cwd, returns the verified manifest and sums both runs costs', async (t) => {
  const { root, invoke } = await setup(t);
  const result = await invoke('claude_artifact_fetch', { url });
  assert.deepEqual(result.structuredContent, { url, version: '1234567890-abcd', dest: join(root, 'design/design'),
    kind: 'design', checksum: 'service', files: [{ path: 'index.html', bytes: 4, sha256: '2a97516c354b68848cdbd8f54a226a0a55b21ed138e207ad6c5cbb9c00aa5aea' }], artboards: [], skipped: [], unreadable: [], costUsd: 0.024 });
  assert.equal(await readFile(join(root, 'design/design/index.html'), 'utf8'), 'demo');
  const text = JSON.stringify(result.content);
  assert.match(text, /1 file/);
  assert.match(text, /0 artboards/);
  assert.match(text, /0 skipped/);
  assert.match(text, /~\$0\.02 on your Claude plan/);
});

test('the fetch url pattern accepts both artifact forms and Cowork links, nothing else', async (t) => {
  const { tools } = await setup(t);
  const pattern = new RegExp((tools.get('claude_artifact_fetch')!.parameters as any).properties.url.pattern);
  for (const ok of [url, 'https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000000',
    'https://claude.ai/cowork/cse_000000000000?artifact=00000000-0000-4000-8000-000000000000']) assert.match(ok, pattern);
  for (const bad of ['https://claude.ai/chat/00000000', 'https://claude.ai/project/00000000', 'https://example.com/cowork/x']) {
    assert.doesNotMatch(bad, pattern);
  }
});

test('fetch text names unreadable files, bounded, and the manifest lists them all', async (t) => {
  const { invoke } = await setup(t, 'unreadable');
  const result = await invoke('claude_artifact_fetch', { url });
  const all = Array.from({ length: 7 }, (_, i) => `project/prototype/${i === 0 ? 'long-'.repeat(40) : `p${i}`}.html`);
  assert.deepEqual((result.structuredContent as { unreadable: string[] }).unreadable, all);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /1 files, 0 artboards, 0 skipped, 7 not readable through Claude Code \(export manually\): project\/prototype\/(long-)+l…, project\/prototype\/p1\.html, .*project\/prototype\/p4\.html and 2 more\./);
  assert.doesNotMatch(text, /p5\.html/);
  // Each named path is cut short too: a listing's paths come from claude.ai and are unbounded.
  assert.doesNotMatch(text, new RegExp(all[0].replaceAll('.', '\\.')));
});

test('the Design-only fetch tool is no longer registered', async (t) => {
  const { tools } = await setup(t);
  assert.equal(tools.has('claude_design_fetch'), false);
  assert.equal(tools.get('claude_artifact_fetch')!.label, 'Claude artifact fetch');
});

test('page fetch saves index.html, reports a locally computed checksum and says so in the text', async (t) => {
  const { root, invoke } = await setup(t, 'page');
  const result = await invoke('claude_artifact_fetch', { url, dest: './design/example-page' });
  const dest = join(root, 'design/example-page');
  assert.deepEqual(result.structuredContent, { url, version: '1234567890-abcd', dest, kind: 'page', checksum: 'local',
    files: [{ path: 'index.html', bytes: 10, sha256: createHash('sha256').update('demo page\n').digest('hex') }],
    artboards: [], skipped: [], unreadable: [], costUsd: 0.024 });
  assert.equal(await readFile(join(dest, 'index.html'), 'utf8'), 'demo page\n');
  assert.equal((result.content[0] as { text: string }).text,
    `Saved page to ${dest}/index.html: 10 bytes, sha256 computed locally (claude.ai gives none).\n~$0.02 on your Claude plan`);
});

test('an unreachable artifact passes the ArtifactUnreachableError message through unchanged', async (t) => {
  const { invoke } = await setup(t, 'unreachable');
  await assert.rejects(invoke('claude_artifact_fetch', { url }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'claude.ai refused this artifact: Artifact not found in your organization');
    return true;
  });
});

test('fetch honours a distinct dest and overwrite refusal without any headless run', async (t) => {
  const { root, invoke, calls } = await setup(t);
  await invoke('claude_artifact_fetch', { url, dest: './design/example-board' });
  assert.equal(existsSync(join(root, 'design/example-board/index.html')), true);
  const count = (await calls()).length;
  await assert.rejects(invoke('claude_artifact_fetch', { url, dest: './design/example-board' }), /non-empty/);
  assert.equal((await calls()).length, count + 2);
  await invoke('claude_artifact_fetch', { url, dest: './design/example-board', overwrite: true });
});

for (const [mode, message] of [['unavailable', /Export the artifact manually from claude\.ai/], ['refused', /read refused.*Export the artifact manually/],
  ['unexpected', /Unexpected call/], ['incomplete', /Fetch incomplete.*Staging kept at/], ['tampered', /Staging.*kept at/]] as const) {
  test(`fetch maps ${mode} to a clear error with no stack and retains staging when required`, async (t) => {
    const { invoke } = await setup(t, mode);
    await assert.rejects(invoke('claude_artifact_fetch', { url }), asyncError => {
      assert.ok(asyncError instanceof Error);
      assert.match(asyncError.message, message);
      assert.doesNotMatch(asyncError.message, /\n\s+at /);
      if (mode === 'incomplete' || mode === 'tampered') {
        const path = /Staging kept at (.+?)\.(?:$|\s)/.exec(asyncError.message)?.[1];
        assert.ok(path, asyncError.message);
        assert.equal(existsSync(path), true);
        t.after(() => rm(dirname(path), { recursive: true, force: true }));
      }
      return true;
    });
  });
}

test('Pi abort signal cancels execution instead of starting a headless list', async (t) => {
  const { invoke } = await setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(invoke('claude_artifact_list', {}, controller.signal), /abort/i);
});

for (const name of ['claude_artifact_list', 'claude_artifact_fetch']) {
  test(`${name} forwards cancellation into an active headless run and cleans its temporary cwd`, { timeout: 10_000 }, async (t) => {
    const { root, invoke, calls } = await setup(t, 'slow');
    const controller = new AbortController();
    const log = join(root, 'calls.jsonl');
    await writeFile(log, '');
    const watcher = watch(log, () => {
      const entries = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (entries.some(call => call.args[0] === '-p')) {
        watcher.close();
        controller.abort();
      }
    });
    t.after(() => watcher.close());
    await assert.rejects(invoke(name, { url }, controller.signal), /Claude run aborted/);
    const run = (await calls()).find(call => call.args[0] === '-p');
    assert.ok(run);
    assert.equal(existsSync(run.cwd), false);
  });
}

test('login notifies four safely quoted terminal instructions as info without spawning claude or sending messages', async (t) => {
  const { root, commands, messages, notifications, commandCtx } = await setup(t);
  await commands.get('claude-artifacts-login')!.handler('', commandCtx);
  assert.deepEqual(notifications, [{
    message: `CLAUDE_CONFIG_DIR='${root}/config with spaces' claude\n/login\npick the organisation whose artifacts you want\n/exit`,
    type: 'info',
  }]);
  assert.deepEqual(messages, []);
  assert.equal(existsSync(join(root, 'calls.jsonl')), false);
});

test('status notifies version, organisation and plan as info without sending messages', async (t) => {
  const { commands, messages, notifications, commandCtx } = await setup(t);
  await commands.get('claude-artifacts-status')!.handler('', commandCtx);
  assert.deepEqual(notifications, [{
    message: 'Claude Code 2.1.312: logged in; organisation: Example Studio; plan: team.',
    type: 'info',
  }]);
  assert.deepEqual(messages, []);
});

test('status notifies an unsuccessful preflight message as warning without sending messages', async (t) => {
  const { root, commands, messages, notifications, commandCtx } = await setup(t, 'signed-out');
  await commands.get('claude-artifacts-status')!.handler('', commandCtx);
  assert.deepEqual(notifications, [{
    message: `Not logged in for ${root}/config with spaces. Run /claude-artifacts-login.`,
    type: 'warning',
  }]);
  assert.deepEqual(messages, []);
});

test('status catches thrown config errors and notifies only their message as error', async (t) => {
  const { root, commands, messages, notifications, commandCtx } = await setup(t);
  process.env.PI_CLAUDE_ARTIFACTS_CONFIG_DIR = './relative-config';
  await commands.get('claude-artifacts-status')!.handler('', commandCtx);
  assert.deepEqual(notifications, [{
    message: 'PI_CLAUDE_ARTIFACTS_CONFIG_DIR must be an absolute path after ~/ expansion; received "./relative-config".',
    type: 'error',
  }]);
  assert.deepEqual(messages, []);
  assert.equal(existsSync(join(root, 'calls.jsonl')), false);
});
