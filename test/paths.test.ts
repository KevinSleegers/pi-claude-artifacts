import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { artifactUrl, assertInside, assertSafeArtifactPath, readableByClaudeCode, resolveDest, slugify } from '../src/paths.ts';

test('slugify produces deterministic directory names', () => {
  for (const [title, expected] of [['Untitled', 'untitled'], ['  ', 'design'],
    ['Acme Pack – Checklist / v2', 'acme-pack-checklist-v2'], ['../', 'design']]) {
    assert.equal(slugify(title), expected);
  }
});

// Each rejection catches an independent path-escape spelling.
for (const path of ['../x', '/etc/x', 'a/../../x', 'a\\..\\x', '', 'C:\\x', 'C:/x', 'C:x',
  '\\\\server\\share', 'a\0b', 'a/../x', './x']) {
  test(`unsafe artifact path rejected: ${JSON.stringify(path)}`, () => {
    assert.throws(() => assertSafeArtifactPath(path));
  });
}
test('relative nested artifact paths pass', () => {
  assert.doesNotThrow(() => assertSafeArtifactPath('project/ds/x/tokens.css'));
});

test('destination and containment guards canonicalize ancestors without creating anything', async () => {
  const temp = await mkdtemp(join(await realpath(tmpdir()), 'pi-ca-paths-'));
  try {
    const cwd = join(temp, 'cwd');
    const outside = join(temp, 'outside');
    await mkdir(cwd);
    await mkdir(outside);
    await mkdir(join(cwd, 'inside'));
    await symlink(outside, join(cwd, 'escape'));
    await symlink(join(cwd, 'inside'), join(cwd, 'internal'));
    await symlink(join(outside, 'missing'), join(cwd, 'dangling'));
    await writeFile(join(cwd, 'file'), 'example');

    assert.equal(await resolveDest(cwd, undefined, 'Acme Pack – Checklist / v2'), join(cwd, 'design/acme-pack-checklist-v2'));
    assert.equal(await resolveDest(cwd, undefined, 'Untitled'), await resolveDest(cwd, undefined, 'Untitled'));
    assert.equal(await resolveDest(cwd, 'internal/new/deep', 'Unused'), join(cwd, 'inside/new/deep'));
    await assertInside(cwd, join(cwd, 'internal/new/file'));
    await assertInside(cwd, cwd);
    await assertInside(join(cwd, 'missing-root'), join(cwd, 'missing-root/new/file'));
    for (const dest of ['/tmp/elsewhere', '../out', outside, `${cwd}-sibling/file`, 'escape/new/deep', 'escape', 'dangling/new']) {
      await assert.rejects(resolveDest(cwd, dest, 'Unused'));
      await assert.rejects(assertInside(cwd, dest));
    }
    // A lexical normalize before realpath would erase the escape symlink here.
    await assert.rejects(assertInside(cwd, join(cwd, 'escape') + '/../escaped'));
    await assert.rejects(resolveDest(cwd, 'escape/../escaped', 'Unused'));
    await assert.rejects(resolveDest(cwd, 'file/child', 'Unused'));
    assert.deepEqual((await readdir(cwd)).sort(), ['dangling', 'escape', 'file', 'inside', 'internal']);
    await assert.rejects(lstat(join(cwd, 'design')), { code: 'ENOENT' });

    // Simulates /tmp -> /private/tmp even on hosts where tmpdir is already canonical.
    const alias = join(temp, 'alias');
    await symlink(cwd, alias);
    assert.equal(await resolveDest(alias, undefined, 'Untitled'), join(cwd, 'design/untitled'));
    await assertInside(alias, join(cwd, 'inside/new'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('artifactUrl converts a Cowork link to its code artifact URL and keeps the artifact forms', () => {
  const id = '00000000-0000-4000-8000-0000000000aA';
  assert.equal(artifactUrl(`https://claude.ai/cowork/cse_000000000000?artifact=${id}`), `https://claude.ai/code/artifact/${id}`);
  assert.equal(artifactUrl(`https://claude.ai/cowork/x/y?tab=1&artifact=${id}#z`), `https://claude.ai/code/artifact/${id}`);
  for (const kept of ['https://claude.ai/artifact/AAAA000000000000000001', `https://claude.ai/code/artifact/${id}`]) {
    assert.equal(artifactUrl(kept), kept);
  }
  for (const refused of ['https://claude.ai/cowork/cse_000000000000', `https://claude.ai/cowork/cse_0?artifact=${id}x`,
    'https://claude.ai/cowork/cse_0?artifact=../../artifact/AAAA']) {
    assert.throws(() => artifactUrl(refused), /Cowork link does not name an artifact/);
  }
});

test('readableByClaudeCode judges the NFC form, as Claude Code does', () => {
  // U+037E GREEK QUESTION MARK normalizes to ";", which Claude Code refuses.
  assert.equal(readableByClaudeCode('project/a\u037eb.html'), false);
  assert.equal(readableByClaudeCode('project/caf\u00e9.html'), true);
});
