import { isAbsolute, join } from 'node:path';

export function resolveConfigDir(
  env: Record<string, string | undefined>,
  home: string,
  readFile: (p: string) => string | undefined,
): string {
  let configDir = env.PI_CLAUDE_ARTIFACTS_CONFIG_DIR || undefined;
  let source = 'PI_CLAUDE_ARTIFACTS_CONFIG_DIR';

  if (!configDir) {
    const configPath = join(home, '.config', 'pi-claude-artifacts', 'config.json');
    const contents = readFile(configPath);
    if (contents !== undefined) {
      try {
        const config: unknown = JSON.parse(contents);
        if (typeof config === 'object' && config !== null && 'configDir' in config
          && typeof config.configDir === 'string') {
          configDir = config.configDir;
          source = `configDir in ${configPath}`;
        }
      } catch {
        // A malformed optional config file must not prevent using the default login directory.
      }
    }
  }

  configDir ??= join(home, '.claude-artifacts');
  const expanded = configDir === '~' ? home : configDir.startsWith('~/') ? join(home, configDir.slice(2)) : configDir;
  if (!isAbsolute(expanded)) {
    throw new Error(`${source} must be an absolute path after ~/ expansion; received ${JSON.stringify(configDir)}.`);
  }
  return expanded;
}
