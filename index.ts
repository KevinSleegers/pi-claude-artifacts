import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Type } from '@earendil-works/pi-ai';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { resolveConfigDir } from './src/config.ts';
import { fetchArtifact, listArtifacts } from './src/designs.ts';
import { resolveDest } from './src/paths.ts';
import { preflight } from './src/preflight.ts';
import type { PreflightExec } from './src/preflight.ts';
import { createSpawnRunner, MAX_BATCH_BYTES } from './src/runner.ts';
import type { ClaudeRunner } from './src/runner.ts';

const hookPath = fileURLToPath(new URL('./hook/artifact-guard.mjs', import.meta.url));
const scopes = Type.Union([Type.Literal('mine'), Type.Literal('shared'), Type.Literal('all')], {
  description: 'mine, shared, or all (default all).',
});
const artifactSchema = Type.Object({ title: Type.String(), url: Type.String(), scope: Type.Union([
  Type.Literal('mine'), Type.Literal('shared with the user'), Type.Literal('shared in the organization'),
]), kind: Type.Union([Type.Literal('design'), Type.Literal('page')]) });
const fetchSchema = Type.Object({
  url: Type.String(), version: Type.String(), dest: Type.String(), costUsd: Type.Number(),
  kind: Type.Union([Type.Literal('design'), Type.Literal('page')]),
  checksum: Type.Union([Type.Literal('service'), Type.Literal('local')]),
  files: Type.Array(Type.Object({ path: Type.String(), bytes: Type.Number(), sha256: Type.String() })),
  artboards: Type.Array(Type.Object({ file: Type.String(), title: Type.String(), w: Type.Number(), h: Type.Number(), page: Type.Optional(Type.String()) })),
  skipped: Type.Array(Type.String()),
  unreadable: Type.Array(Type.String()),
});

function configDir(): string {
  return resolveConfigDir(process.env, homedir(), (path) => {
    try { return readFileSync(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  });
}

function execPreflight(signal?: AbortSignal, cwd?: string): PreflightExec {
  // pi.exec has no env option; execFile can remove the inherited artifact-disabling variable.
  return (cmd, args, env) => new Promise((resolve, reject) => {
    execFile(cmd, args, { env, cwd, signal, timeout: 15_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error?.killed) { reject(new Error('Claude Code preflight timed out. Try again.')); return; }
      if (error && typeof error.code !== 'number') { reject(error); return; }
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

function meteredRunner(dir: string): { runner: ClaudeRunner; cost: () => number } {
  const delegate = createSpawnRunner({ configDir: dir, hookPath });
  let costUsd = 0;
  return { runner: { async run(request) {
    const result = await delegate.run(request);
    costUsd += result.costUsd ?? 0;
    return result;
  } }, cost: () => costUsd };
}

function toolError(error: unknown): Error {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error) {
    if (error.name === 'RunAborted' || error.name === 'AbortError') message = 'Claude run aborted. Try again when ready.';
    if (error.name === 'RunTimeout') message = 'Claude run timed out. Try again or export the artifact manually from claude.ai.';
    if ('stagingDir' in error && typeof error.stagingDir === 'string' && !message.includes('Staging kept at')) {
      message += ` Staging kept at ${error.stagingDir}.`;
    } else if ('rootDir' in error && typeof error.rootDir === 'string' && !('stagingDir' in error)) {
      message += ` Temporary directory kept at ${error.rootDir}.`;
    }
  }
  // Pi marks thrown errors as failed tool results; only the message, never error.stack, is returned.
  return new Error(message);
}

const cell = (text: string) => text.replace(/[\r\n]+/g, ' ').replaceAll('|', '\\|');
const unreadableText = (paths: string[]) => paths.length
  ? `, ${paths.length} not readable through Claude Code (export manually): ${paths.slice(0, 5).map((path) => cell(path.length > 100 ? `${path.slice(0, 99)}…` : path)).join(', ')}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}`
  : '';
const costText = (cost: number) => `~$${cost.toFixed(2)} on your Claude plan`;

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'claude_artifact_list', label: 'Claude artifact list',
    description: 'List claude.ai artifacts (Designs and single pages) from your Claude account using your own Claude Code. Read-only on claude.ai; each call uses Haiku on your Claude plan.',
    parameters: Type.Object({ scope: Type.Optional(scopes) }),
    outputSchema: Type.Object({ artifacts: Type.Array(artifactSchema), costUsd: Type.Number() }),
    annotations: { readOnlyHint: false, openWorldHint: true },
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const dir = configDir();
        const ready = await preflight(execPreflight(signal, ctx.cwd), dir, process.env);
        if (!ready.ok) throw new Error(ready.message);
        const { runner, cost } = meteredRunner(dir);
        const artifacts = await listArtifacts(runner, params.scope ?? 'all', signal);
        const costUsd = cost();
        const text = ['Title | Kind | Scope | URL', '--- | --- | --- | ---',
          ...artifacts.map(row => `${cell(row.title)} | ${row.kind} | ${cell(row.scope)} | ${cell(row.url)}`),
          ...(artifacts.length ? [] : ['No artifacts found.']), costText(costUsd)].join('\n');
        const data = { artifacts, costUsd };
        return { content: [{ type: 'text', text }], details: data, structuredContent: data };
      } catch (error) { throw toolError(error); }
    },
  });

  pi.registerTool({
    name: 'claude_artifact_fetch', label: 'Claude artifact fetch',
    description: 'Fetch and verify a claude.ai artifact (a Design or a single page) into the local project; never executes it or writes to claude.ai. Pass a distinct dest per artifact, e.g. ./design/<slug of the title from claude_artifact_list>, because the default ./design/design is shared. Each call uses Haiku on your Claude plan.',
    parameters: Type.Object({
      url: Type.String({ pattern: '^https://claude\\.ai/((code/)?artifact/|cowork/)', description: 'claude.ai artifact URL, or a Cowork link that names an artifact.' }),
      dest: Type.Optional(Type.String({ description: 'Project-local directory. Pass a distinct dest per artifact, e.g. ./design/<slug of the title from claude_artifact_list>; the default ./design/design is shared.' })),
      overwrite: Type.Optional(Type.Boolean({ description: 'Replace an existing non-empty destination (default false).' })),
    }),
    outputSchema: fetchSchema,
    annotations: { readOnlyHint: false, openWorldHint: true },
    executionMode: 'sequential',
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const dir = configDir();
        const ready = await preflight(execPreflight(signal, ctx.cwd), dir, process.env);
        if (!ready.ok) throw new Error(ready.message);
        const { runner, cost } = meteredRunner(dir);
        const dest = await resolveDest(ctx.cwd, params.dest, 'design');
        const manifest = await withFileMutationQueue(dest, () => fetchArtifact(runner, {
          url: params.url, dest: params.dest, overwrite: params.overwrite,
          cwd: ctx.cwd, maxBatchBytes: MAX_BATCH_BYTES, configDir: dir, signal,
        }));
        const costUsd = cost();
        const summary = manifest.kind === 'page'
          ? `Saved page to ${manifest.dest}/index.html: ${manifest.files[0].bytes} bytes, sha256 computed locally (claude.ai gives none).`
          : `Saved to ${manifest.dest}: ${manifest.files.length} files, ${manifest.artboards.length} artboards, ${manifest.skipped.length} skipped${unreadableText(manifest.unreadable)}.`;
        const text = `${summary}\n${costText(costUsd)}`;
        const data = { ...manifest, costUsd };
        return { content: [{ type: 'text', text }], details: data, structuredContent: data };
      } catch (error) { throw toolError(error); }
    },
  });

  pi.registerCommand('claude-artifacts-status', {
    description: 'Check Claude Code version and the artifact account login, organisation and plan.',
    handler: async (_args, ctx) => {
      try {
        const result = await preflight(execPreflight(ctx.signal, ctx.cwd), configDir(), process.env);
        const content = result.ok ? `Claude Code ${result.version}: logged in; organisation: ${result.org}; plan: ${result.plan}.` : result.message;
        ctx.ui.notify(content, result.ok ? 'info' : 'warning');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
  pi.registerCommand('claude-artifacts-login', {
    description: 'Show separate-account login instructions to run in a normal terminal; does not log in or out.',
    handler: async (_args, ctx) => {
      const quoted = `'${configDir().replaceAll("'", "'\\''")}'`;
      ctx.ui.notify(`CLAUDE_CONFIG_DIR=${quoted} claude\n/login\npick the organisation whose artifacts you want\n/exit`, 'info');
    },
  });
}
