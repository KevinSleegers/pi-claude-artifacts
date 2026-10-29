export type Artboard = { file: string; title: string; w: number; h: number; page?: string };

export function readArtboards(canvasJson: string): Artboard[] {
  let canvas: unknown;
  try {
    canvas = JSON.parse(canvasJson);
  } catch {
    return [];
  }
  if (typeof canvas !== 'object' || canvas === null || !('boards' in canvas) || !('order' in canvas)
    || !Array.isArray(canvas.order) || typeof canvas.boards !== 'object'
    || canvas.boards === null || Array.isArray(canvas.boards)) return [];

  const boards = canvas.boards as Record<string, unknown>;
  const result: Artboard[] = [];
  for (const file of canvas.order) {
    if (typeof file !== 'string' || !Object.hasOwn(boards, file)) continue;
    const board = boards[file];
    if (typeof board !== 'object' || board === null || !('title' in board) || typeof board.title !== 'string'
      || !('w' in board) || typeof board.w !== 'number' || !Number.isFinite(board.w) || board.w <= 0
      || !('h' in board) || typeof board.h !== 'number' || !Number.isFinite(board.h) || board.h <= 0) continue;
    result.push({ file, title: board.title, w: board.w, h: board.h,
      ...('page' in board && typeof board.page === 'string' ? { page: board.page } : {}) });
  }
  return result;
}
