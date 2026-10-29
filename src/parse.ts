export type DesignScope = 'mine' | 'shared with the user' | 'shared in the organization';
export type ArtifactKind = 'design' | 'page';
export type ArtifactRow = { title: string; url: string; scope: DesignScope; kind: ArtifactKind };
export type ListedFile = { path: string; mime: string; bytes: number; sha256?: string };
export type SavedFile = { savedPath: string; path: string; bytes: number; mime: string; sha256: string; version: string };
export type PageRead = { savedPath: string; bytes: number; version: string; title: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function byteSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function parseDesignList(text: string, structured?: unknown): ArtifactRow[] {
  const instances = record(record(structured)?.type_instances)?.instances;
  if (Array.isArray(instances)) {
    const rows: ArtifactRow[] = [];
    for (const instance of instances) {
      const item = record(instance);
      const scope: DesignScope | undefined = item?.rel === 'mine' ? 'mine'
        : item?.rel === 'shared' && item.audience === 'users' ? 'shared with the user'
        : item?.rel === 'shared' && item.audience === 'org' ? 'shared in the organization' : undefined;
      if (!item || typeof item.title !== 'string' || typeof item.url !== 'string' || !scope) break;
      rows.push({ title: item.title, url: item.url, scope, kind: 'design' });
    }
    if (rows.length === instances.length) return rows;
  }

  const rows: ArtifactRow[] = [];
  for (const match of text.matchAll(/^- \((mine|shared with the user|shared in the organization)\) (.+) — (https:\/\/claude\.ai\/artifact\/[\w-]+)\s*$/gm)) {
    rows.push({ title: match[2].split(' — ')[0].trim(), url: match[3], scope: match[1] as DesignScope, kind: 'design' });
  }
  return rows;
}

// The untyped list gives no audience, so a shared row is always "shared with the user"; owned rows carry no rel.
export function parseArtifactList(text: string, structured?: unknown): ArtifactRow[] {
  const artifacts = record(structured)?.artifacts;
  if (Array.isArray(artifacts)) {
    const rows: ArtifactRow[] = [];
    for (const artifact of artifacts) {
      const item = record(artifact);
      if (!item || typeof item.title !== 'string' || typeof item.url !== 'string'
        || (item.rel !== undefined && item.rel !== 'shared')) break;
      rows.push({ title: item.title, url: item.url, scope: item.rel === 'shared' ? 'shared with the user' : 'mine', kind: 'page' });
    }
    if (rows.length === artifacts.length) return rows;
  }

  const rows: ArtifactRow[] = [];
  for (const match of text.matchAll(/^- \((mine|shared)\) (.+) — (https:\/\/claude\.ai\/artifact\/[\w-]+)(?: — updated \S+)?\s*$/gm)) {
    rows.push({ title: match[2].trim(), url: match[3], scope: match[1] === 'mine' ? 'mine' : 'shared with the user', kind: 'page' });
  }
  return rows;
}

export function parseFileList(text: string, structured?: unknown): { version: string; files: ListedFile[]; singlePage: boolean } {
  const list = record(record(structured)?.file_list);
  if (list && typeof list.ver === 'string' && list.ver && Array.isArray(list.files)) {
    const files: ListedFile[] = [];
    for (const value of list.files) {
      const item = record(value);
      if (!item || typeof item.path !== 'string' || typeof item.content_type !== 'string'
        || !byteSize(item.size_bytes) || (item.sha256 !== undefined && !hash(item.sha256))) break;
      files.push({ path: item.path, mime: item.content_type, bytes: item.size_bytes,
        ...(item.sha256 !== undefined ? { sha256: item.sha256 as string } : {}) });
    }
    if (files.length === list.files.length) return { version: list.ver, files, singlePage: list.single_page === true };
  }

  const version = /^Published files of https:\/\/claude\.ai\/artifact\/[\w-]+ \(version ([^)]+)\)/m.exec(text)?.[1];
  if (!version) throw new Error('Unable to parse artifact file list version.');
  const files: ListedFile[] = [];
  for (const match of text.matchAll(/^- ("(?:[^"\\\r\n]|\\.)*")\s+(\S+)\s+(\d+) bytes\s*$/gm)) {
    const bytes = Number(match[3]);
    if (!byteSize(bytes)) throw new Error('Invalid artifact file size.');
    files.push({ path: JSON.parse(match[1]), mime: match[2], bytes });
  }
  // File paths are untrusted and only appear on quoted "- " lines, so anchoring to the header line keeps them out of the flag.
  const singlePage = /^Published files of \S+ \(version [^)]+\): none — this version is a single page\b/m.test(text);
  return { version, files, singlePage };
}

export function parseFileSaved(text: string, structured?: unknown): SavedFile | undefined {
  const read = record(record(structured)?.file_read);
  if (read && typeof read.saved_to === 'string' && typeof read.path === 'string'
    && byteSize(read.size_bytes) && typeof read.content_type === 'string'
    && hash(read.sha256) && typeof read.ver === 'string' && read.ver) {
    return { savedPath: read.saved_to, path: read.path, bytes: read.size_bytes,
      mime: read.content_type, sha256: read.sha256, version: read.ver };
  }

  const match = /^File saved: ("(?:[^"\\\r\n]|\\.)*") \((\d+) bytes, ("(?:[^"\\\r\n]|\\.)*"), sha256 ([a-f0-9]{64})\) — ("(?:[^"\\\r\n]|\\.)*") from version ([\w-]+)(?:\.|$)/mi.exec(text);
  if (!match || !byteSize(Number(match[2]))) return undefined;
  return { savedPath: JSON.parse(match[1]), bytes: Number(match[2]), mime: JSON.parse(match[3]),
    sha256: match[4], path: JSON.parse(match[5]), version: match[6] };
}

export function parsePageRead(text: string, structured?: unknown): PageRead | undefined {
  const root = record(structured);
  const read = record(root?.read);
  const version = record(root?.artifactRead)?.ver;
  // The path is only in the prose; it ends at the em dash that introduces the "build from that file" advice.
  const savedPath = /raw HTML saved to (\/.+?) — /.exec(text)?.[1];
  if (!read || !byteSize(read.bytes) || typeof read.title !== 'string'
    || typeof version !== 'string' || !version || !savedPath) return undefined;
  return { savedPath, bytes: read.bytes, version, title: read.title };
}
