export type Preflight = { ok: true; version: string; org: string; plan: string }
  | { ok: false; message: string };
export type PreflightExec = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{
  code: number | null; stdout: string; stderr: string;
}>;

export async function preflight(exec: PreflightExec, configDir: string, env: NodeJS.ProcessEnv): Promise<Preflight> {
  const childEnv: NodeJS.ProcessEnv = { ...env, CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_ARTIFACT: '1', CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0' };
  delete childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  try {
    const versionResult = await exec('claude', ['--version'], childEnv);
    const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(versionResult.stdout.trim());
    if (versionResult.code !== 0 || !match) {
      return { ok: false, message: 'Could not determine Claude Code version. Install Claude Code 2.1.312 or newer and try again.' };
    }
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    const [major, minor, patch] = match.slice(1, 4).map(Number);
    if (major < 2 || (major === 2 && (minor < 1 || (minor === 1 && patch < 312)))) {
      return { ok: false, message: `Claude Code ${version} is too old. Update to 2.1.312 or newer and try again.` };
    }
    const auth = await exec('claude', ['auth', 'status', '--json'], childEnv);
    let status: unknown;
    try { status = JSON.parse(auth.stdout); } catch { /* A diagnostic is returned below for invalid CLI output. */ }
    if (typeof status === 'object' && status !== null && 'loggedIn' in status) {
      if (status.loggedIn === false) {
        return { ok: false, message: `Not logged in for ${configDir}. Run /claude-artifacts-login.` };
      }
      if (auth.code === 0 && status.loggedIn === true) {
        const org = 'orgName' in status && typeof status.orgName === 'string' && status.orgName ? status.orgName : 'unknown';
        const plan = 'subscriptionType' in status && typeof status.subscriptionType === 'string' && status.subscriptionType
          ? status.subscriptionType : 'unknown';
        return { ok: true, version, org, plan };
      }
    }
    return { ok: false, message: `Could not read claude auth status for ${configDir}. Run /claude-artifacts-login and try again.` };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { ok: false, message: "Claude Code (claude) was not found on Pi's PATH. Install it or start Pi from a shell where claude works." };
    }
    return { ok: false, message: `Claude Code preflight failed: ${error instanceof Error ? error.message : String(error)}. Check claude in your terminal and try again.` };
  }
}
