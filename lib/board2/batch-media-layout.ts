export type BatchMediaSize = { id: string; width: number; height: number };
export type BatchMediaPlacement = BatchMediaSize & { x: number; y: number };

export function layoutUploadedImageBatch(options: {
  images: BatchMediaSize[];
  boardWidth: number;
  boardHeight: number;
  existingBottom: number;
}): { placements: BatchMediaPlacement[]; boardWidth: number; boardHeight: number } {
  if (!options.images.length) return { placements: [], boardWidth: options.boardWidth, boardHeight: options.boardHeight };
  const margin = 120;
  const gap = 28;
  const cellWidth = 548;
  const cellHeight = 418;
  const availableWidth = Math.max(options.boardWidth, 1800) - margin * 2;
  const columns = Math.max(1, Math.min(options.images.length, Math.floor((availableWidth + gap) / cellWidth)));
  const requiredWidth = margin * 2 + columns * cellWidth - gap;
  const firstRowY = options.existingBottom > margin ? options.existingBottom + 90 : margin;
  const rows = Math.ceil(options.images.length / columns);
  const placements = options.images.map((image, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      ...image,
      x: margin + column * cellWidth + (cellWidth - gap - image.width) / 2,
      y: firstRowY + row * cellHeight + (cellHeight - gap - image.height) / 2,
    };
  });
  return {
    placements,
    boardWidth: Math.max(options.boardWidth, Math.ceil(requiredWidth / 500) * 500),
    boardHeight: Math.max(options.boardHeight, Math.ceil((firstRowY + rows * cellHeight + margin) / 500) * 500),
  };
}
