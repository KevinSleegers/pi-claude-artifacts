import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, sep, win32 } from 'node:path';

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'design';
}

export function assertSafeArtifactPath(p: string): void {
  if (!p || p.includes('\0') || isAbsolute(p) || win32.isAbsolute(p) || /^[a-z]:/i.test(p)
    || p.includes('\\') || p.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`Unsafe artifact path: ${JSON.stringify(p)}`);
  }
}

// Claude Code's Artifact tool takes only artifact URLs, not a Cowork session link; the uuid in a Cowork link's
// artifact parameter read as claude.ai/code/artifact/<uuid> (observed, not documented by Anthropic).
export function artifactUrl(url: string): string {
  if (!url.startsWith('https://claude.ai/cowork/')) return url;
  const id = new URL(url).searchParams.get('artifact') ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('This Cowork link does not name an artifact. Open the artifact in Cowork and copy a link that names it, or use claude_artifact_list.');
  }
  return `https://claude.ai/code/artifact/${id}`;
}

function absoluteFrom(root: string, p: string): string {
  // Do not normalize away symlink/.. before asking the filesystem where the symlink leads.
  return isAbsolute(p) ? p : `${root}/${p}`;
}

async function canonicalPath(p: string): Promise<string> {
  if (!p || p.includes('\0')) throw new Error('Invalid filesystem path.');
  const absolute = absoluteFrom(process.cwd(), p);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    const candidate = join(current, part);
    try {
      current = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // realpath also returns ENOENT for a dangling symlink; it is not a safe missing directory.
      try {
        await lstat(candidate);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        current = candidate;
        continue;
      }
      throw new Error(`Unresolvable filesystem path: ${candidate}`);
    }
  }
  return current;
}

function checkInside(root: string, p: string): void {
  const path = relative(root, p);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`Path is outside working directory: ${p}`);
  }
}

export async function assertInside(root: string, p: string): Promise<void> {
  const canonicalRoot = await canonicalPath(root);
  const canonicalTarget = await canonicalPath(absoluteFrom(root, p));
  checkInside(canonicalRoot, canonicalTarget);
}

export async function resolveDest(cwd: string, dest: string | undefined, title: string): Promise<string> {
  const root = await canonicalPath(cwd);
  const target = await canonicalPath(dest === undefined ? `${root}/design/${slugify(title)}`
    : absoluteFrom(cwd, dest));
  checkInside(root, target);
  return target;
}
