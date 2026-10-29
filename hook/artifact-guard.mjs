#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function decide(input, env) {
  const reason = 'only list, read with out_dir exactly equal to PI_CA_STAGING (not during a page read), or read of exactly the requested page URL (PI_CA_PAGE_URL) is allowed.';
  if (input?.tool_name !== 'Artifact') return { allow: false, reason };
  const tool = input.tool_input;
  if (tool?.action === 'list') return { allow: true };
  // A page run also sets PI_CA_STAGING (it is the run's cwd); its only permitted read is the page itself.
  if (tool?.action === 'read' && typeof tool.out_dir === 'string' && tool.out_dir && !env.PI_CA_PAGE_URL &&
      typeof env.PI_CA_STAGING === 'string' && env.PI_CA_STAGING) {
    try {
      // macOS /tmp aliases and symlinked paths must refer to the same existing staging directory.
      if (realpathSync(tool.out_dir) === realpathSync(env.PI_CA_STAGING)) return { allow: true };
    } catch {
      // Missing or unresolvable paths cannot establish the read boundary.
    }
  }
  // A single-page artifact is read by URL; any extra key (prompt, page, out_dir) widens the read.
  if (tool?.action === 'read' && typeof tool.url === 'string' && tool.url &&
      Object.keys(tool).length === 2 && tool.url === env.PI_CA_PAGE_URL) return { allow: true };
  return { allow: false, reason };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  try {
    for await (const chunk of process.stdin) input += chunk;
    const decision = decide(JSON.parse(input), process.env);
    if (decision.allow) {
      console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'allow',
      } }));
    } else {
      console.error(`Artifact guard: ${decision.reason}`);
      process.exitCode = 2;
    }
  } catch {
    console.error('Artifact guard: invalid hook input; denied.');
    process.exitCode = 2;
  }
}
