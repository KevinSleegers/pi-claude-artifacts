import type { ListedFile } from './parse.ts';

export function selectFiles(files: ListedFile[]): ListedFile[] {
  return files.filter(({ path }) => path.startsWith('project/') || path === 'index.html'
    || path === 'SKILL.md' || path.startsWith('artifact-type/reference/'));
}

export function batchFiles(files: ListedFile[], maxBytes: number): ListedFile[][] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Batch limit must be a positive integer.');
  const batches: ListedFile[][] = [];
  let batch: ListedFile[] = [];
  let bytes = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid listed file size.');
    if (file.bytes > maxBytes) {
      if (batch.length) batches.push(batch);
      batches.push([file]);
      batch = [];
      bytes = 0;
      continue;
    }
    if (bytes + file.bytes > maxBytes) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.bytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
