import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConfigDir } from '../src/config.ts';

const home = '/home/example';
const configPath = '/home/example/.config/pi-claude-artifacts/config.json';

test('env var wins', () => {
  assert.equal(resolveConfigDir({ PI_CLAUDE_ARTIFACTS_CONFIG_DIR: '/x' }, home, () => {
    throw new Error('The config file must not be read when the environment overrides it');
  }), '/x');
});

test('config file used when no env', () => {
  assert.equal(resolveConfigDir({}, home, (path) => {
    return path === configPath ? '{"configDir":"~/.claude-example"}' : undefined;
  }), '/home/example/.claude-example');
});

test('default', () => {
  assert.equal(resolveConfigDir({}, home, () => undefined), '/home/example/.claude-artifacts');
});

for (const value of ['./.claude-work', 'profiles/work', '~someone/profile']) {
  test(`rejects relative environment config directory ${value} with its source and value`, () => {
    assert.throws(() => resolveConfigDir({ PI_CLAUDE_ARTIFACTS_CONFIG_DIR: value }, home, () => undefined),
      (error: unknown) => error instanceof Error && /absolute/.test(error.message)
        && error.message.includes('PI_CLAUDE_ARTIFACTS_CONFIG_DIR') && error.message.includes(JSON.stringify(value)));
  });
}

for (const value of ['./.claude-work', 'profiles/work', '~someone/profile', '']) {
  test(`rejects relative file config directory ${JSON.stringify(value)} with its source and value`, () => {
    assert.throws(() => resolveConfigDir({}, home, () => JSON.stringify({ configDir: value })),
      (error: unknown) => error instanceof Error && /absolute/.test(error.message)
        && error.message.includes(configPath) && error.message.includes('configDir')
        && error.message.includes(JSON.stringify(value)));
  });
}

test('environment home expansion and file absolute paths remain supported', () => {
  assert.equal(resolveConfigDir({ PI_CLAUDE_ARTIFACTS_CONFIG_DIR: '~/.claude-work' }, home, () => undefined),
    '/home/example/.claude-work');
  assert.equal(resolveConfigDir({}, home, () => '{"configDir":"/profiles/work"}'), '/profiles/work');
});

test('invalid JSON in config file falls back to default', () => {
  assert.equal(resolveConfigDir({}, home, (path) => {
    return path === configPath ? '{invalid JSON' : undefined;
  }), '/home/example/.claude-artifacts');
});
