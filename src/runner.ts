import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseStream } from './stream.ts';

export const PERMISSION_STRATEGY: string = 'hook-allow';
export const HOOK_SETTINGS_VIA = '--settings';
export const MAX_BATCH_BYTES = 100000;

export type RunRequest = {
  prompt: string;
  stagingDir?: string;
  pageUrl?: string;
  maxTurns: number;
  timeoutMs: number;
  signal?: AbortSignal;
};
export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
export type ToolResult = { toolUseId: string; text: string; isError: boolean; structured?: unknown };
export type RunResult = {
  calls: ToolCall[];
  results: ToolResult[];
  tools: string[];
  denials: ToolCall[];
  subtype: string;
  costUsd?: number;
  exitCode: number | null;
};
export interface ClaudeRunner { run(req: RunRequest): Promise<RunResult> }

type RunnerOptions = { configDir: string; hookPath: string; claudeBin?: string };
type Invocation = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  settingsFile?: { path: string; json: string };
};

export function buildInvocation(req: RunRequest, opts: RunnerOptions & { env: NodeJS.ProcessEnv }): Invocation {
  // --tools Artifact also exposes sidecars; they must pass through the deny-by-default guard.
  const settings = { hooks: { PreToolUse: [{ matcher: 'Artifact|ArtifactComments|ArtifactData',
    hooks: [{ type: 'command', command: `node '${opts.hookPath.replaceAll("'", "'\\''")}'`, onFailure: 'block' }],
  }] } };
  const args = ['-p', req.prompt, '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(req.maxTurns), '--tools', 'Artifact', '--strict-mcp-config', '--no-session-persistence'];
  if (PERMISSION_STRATEGY === 'auto') args.push('--permission-mode', 'auto');
  args.push(HOOK_SETTINGS_VIA, JSON.stringify(settings));
  const env: NodeJS.ProcessEnv = { ...opts.env, CLAUDE_CONFIG_DIR: opts.configDir,
    CLAUDE_CODE_ARTIFACT: '1', CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0' };
  delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  delete env.PI_CA_STAGING;
  delete env.PI_CA_PAGE_URL;
  if (req.stagingDir !== undefined) env.PI_CA_STAGING = realpathSync(req.stagingDir);
  if (req.pageUrl !== undefined) env.PI_CA_PAGE_URL = req.pageUrl;
  return { command: opts.claudeBin ?? 'claude', args, env };
}

function stopped(name: 'RunAborted' | 'RunTimeout'): Error {
  return Object.assign(new Error(name === 'RunAborted' ? 'Claude run aborted' : 'Claude run timed out'), { name });
}

export function createSpawnRunner(opts: RunnerOptions): ClaudeRunner {
  return { async run(req) {
    if (req.signal?.aborted) throw stopped('RunAborted');
    // Artifact only saves within the session scratchpad. Caller-owned staging is never removed here.
    const ownedCwd = req.stagingDir === undefined ? await mkdtemp(join(tmpdir(), 'pi-ca-')) : undefined;
    let processGroupMayRemain = false;
    try {
      const cwd = await realpath(ownedCwd ?? dirname(req.stagingDir!));
      if (req.signal?.aborted) throw stopped('RunAborted');
      const invocation = buildInvocation(req, { ...opts, env: process.env });
      return await new Promise<RunResult>((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, {
          cwd, env: invocation.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
        });
        let stdout = '';
        let failure: Error | undefined;
        let termination: Promise<void> | undefined;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        // Drain stderr even when the caller only consumes structured stdout.
        child.stderr.resume();
        const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
          if (child.pid === undefined) return false;
          try { process.kill(-child.pid, signal); return true; }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // Darwin answers EPERM for a group of unreaped zombies; keep polling until it is gone.
            if (code === 'EPERM') return true;
            if (code !== 'ESRCH') throw error;
            return false;
          }
        };
        const terminateGroup = async () => {
          signalGroup('SIGTERM');
          const killAt = performance.now() + 2000;
          let observeUntil: number | undefined;
          // Leader close says nothing about descendants with ignored/closed output.
          while (signalGroup(0)) {
            if (observeUntil !== undefined && performance.now() >= observeUntil) {
              processGroupMayRemain = true;
              Object.assign(failure!, { processGroupMayRemain: true, pid: child.pid });
              // Unproven disappearance must neither hold cancellation open nor remove a cwd still in use.
              cleanup();
              child.stdout.destroy();
              child.stderr.destroy();
              reject(failure);
              return;
            }
            if (observeUntil === undefined && performance.now() >= killAt) {
              signalGroup('SIGKILL');
              observeUntil = performance.now() + 3000;
            }
            const delay = observeUntil === undefined ? 10 : Math.min(10, Math.max(0, observeUntil - performance.now()));
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
          }
        };
        const stop = (name: 'RunAborted' | 'RunTimeout') => {
          if (failure) return;
          failure = stopped(name);
          termination = terminateGroup();
          // Close may still be waiting for inherited pipes; handle errors until it awaits termination.
          void termination.catch(() => {});
        };
        const abort = () => stop('RunAborted');
        const timeout = setTimeout(() => stop('RunTimeout'), req.timeoutMs);
        req.signal?.addEventListener('abort', abort, { once: true });
        const cleanup = () => {
          clearTimeout(timeout);
          req.signal?.removeEventListener('abort', abort);
        };
        child.once('error', (error) => { failure ??= error; });
        // Proven group disappearance permits owned-cwd cleanup; expiry preserves it instead.
        child.once('close', async (exitCode) => {
          cleanup();
          try {
            if (termination) await termination;
            if (failure) { reject(failure); return; }
            resolve({ ...parseStream(stdout), exitCode });
          } catch (error) { reject(error); }
        });
        if (req.signal?.aborted) abort();
      });
    } finally {
      if (ownedCwd && !processGroupMayRemain) await rm(ownedCwd, { recursive: true, force: true });
    }
  } };
}
