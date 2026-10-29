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
