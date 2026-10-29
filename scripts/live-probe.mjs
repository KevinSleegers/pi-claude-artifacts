#!/usr/bin/env node
// Dev-only: raw output and fetched content must never be committed or executed.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const [outputArg, promptTemplate, settingsVia = '--settings', artifactOption, ...extra] = process.argv.slice(2);
if (!outputArg || !promptTemplate || !['--settings', 'project-settings'].includes(settingsVia) ||
    (artifactOption && artifactOption !== '--no-artifact') || extra.length || !/read.only/i.test(promptTemplate)) {
  throw new Error('Usage: node scripts/live-probe.mjs <raw.jsonl> <read-only prompt with {{STAGING}}> [--settings|project-settings] [--no-artifact]');
}
const configDir = process.env.PI_CLAUDE_ARTIFACTS_CONFIG_DIR;
if (!configDir) throw new Error('PI_CLAUDE_ARTIFACTS_CONFIG_DIR is required; set it to the config directory to use.');
const expandedConfigDir = configDir === '~' || configDir.startsWith('~/')
  ? homedir() + configDir.slice(1) : configDir;
const root = '/tmp/pi-claude-artifacts-probe';
await mkdir(root, { recursive: true });
const output = resolve(outputArg);
await mkdir(dirname(output), { recursive: true });
if (!(await realpath(dirname(output))).startsWith((await realpath(root)) + sep)) {
  if (await realpath(dirname(output)) !== await realpath(root)) throw new Error('Raw output must stay under '+root);
}
const cwd = await realpath(await mkdtemp(root + '/cwd-'));
// Artifact's ownership check requires local output inside this session's scratchpad.
const staging = cwd + '/staging';
await mkdir(staging);
const prompt = promptTemplate.replaceAll('{{STAGING}}', staging);
const hook = fileURLToPath(new URL('../hook/artifact-guard.mjs', import.meta.url));
// Claude Code 2.1.312 exposes sidecar tools even with --tools Artifact.
// Match them too: the guard rejects every tool other than Artifact itself.
const settings = { hooks: { PreToolUse: [{ matcher: 'Artifact|ArtifactComments|ArtifactData', hooks: [{ type: 'command', command: `node ${JSON.stringify(hook)}` }] }] } };
const args = ['-p', prompt, '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--max-turns', '12',
  '--tools', 'Artifact', '--strict-mcp-config', '--no-session-persistence'];
if (settingsVia === '--settings') args.push('--settings', JSON.stringify(settings));
else {
  await mkdir(cwd + '/.claude');
  await writeFile(cwd + '/.claude/settings.json', JSON.stringify(settings));
}
const env = { ...process.env, CLAUDE_CONFIG_DIR: expandedConfigDir,
  CLAUDE_CODE_ARTIFACT: '1', CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0', PI_CA_STAGING: staging };
delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
if (artifactOption === '--no-artifact') delete env.CLAUDE_CODE_ARTIFACT;
await writeFile(output + '.command.json', JSON.stringify({ cwd, args, env: {
  CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_ARTIFACT: env.CLAUDE_CODE_ARTIFACT ?? 'removed', CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0', PI_CA_STAGING: staging,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'removed',
} }, null, 2));
const stdout = createWriteStream(output, { flags: 'wx' });
const stderr = createWriteStream(output + '.stderr', { flags: 'wx' });
await Promise.all([new Promise((ok, fail) => stdout.once('open', ok).once('error', fail)),
  new Promise((ok, fail) => stderr.once('open', ok).once('error', fail))]);
const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);
const timeout = setTimeout(() => child.kill('SIGTERM'), 180_000);
const result = await new Promise((ok, fail) => { child.once('error', fail); child.once('close', (code, signal) => ok({ code, signal })); });
clearTimeout(timeout);
await writeFile(output + '.exit.json', JSON.stringify(result));
console.log(JSON.stringify({ output, cwd, staging, ...result }));
process.exitCode = result.code ?? 1;
