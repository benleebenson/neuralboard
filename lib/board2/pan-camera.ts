export type PanCameraMediaRect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PanCameraWaypoint = {
  mediaId: string;
  cameraX: number;
  cameraY: number;
  boardZoom: number;
  progress: number;
};

export type SerpentinePanPathOptions = {
  media: readonly PanCameraMediaRect[];
  canvasWidth: number;
  canvasHeight: number;
  boardWidth: number;
  boardHeight: number;
  imageFocusRatio: number;
  panZoomRatio?: number;
};

const DEFAULT_PAN_ZOOM_RATIO = 0.82;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function clampCameraCenter(value: number, boardExtent: number, halfViewportExtent: number): number {
  if (boardExtent <= halfViewportExtent * 2) return boardExtent / 2;
  return Math.max(halfViewportExtent, Math.min(boardExtent - halfViewportExtent, value));
}

/**
 * Builds a readable, distance-timed camera route through board media.
 * Media is grouped into visual rows, then visited in alternating horizontal directions so a
 * multi-row or clustered board is traversed instead of reduced to one fit-everything shot.
 */
export function buildSerpentinePanPath(options: SerpentinePanPathOptions): PanCameraWaypoint[] {
  const canvasWidth = Math.max(1, options.canvasWidth);
  const canvasHeight = Math.max(1, options.canvasHeight);
  const boardWidth = Math.max(1, options.boardWidth);
  const boardHeight = Math.max(1, options.boardHeight);
  const imageFocusRatio = Math.max(0.01, options.imageFocusRatio);
  const panZoomRatio = Math.max(0.01, options.panZoomRatio ?? DEFAULT_PAN_ZOOM_RATIO);
  const media = options.media
    .filter((rect) =>
      Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
      Number.isFinite(rect.width) && rect.width > 0 &&
      Number.isFinite(rect.height) && rect.height > 0
    )
    .map((rect) => ({
      ...rect,
      centerX: rect.x + rect.width / 2,
      centerY: rect.y + rect.height / 2,
    }));
  if (media.length === 0) return [];

  // Match the scale of an ordinary per-image focus shot, then step modestly wider so nearby
  // context remains visible. A median prevents one unusually large/small asset from dominating.
  const focusZooms = media.map((rect) => {
    const screenScale = imageFocusRatio * Math.min(canvasWidth / rect.width, canvasHeight / rect.height);
    return screenScale * boardWidth / canvasWidth;
  });
  const readableZoom = Math.max(0.01, median(focusZooms) * panZoomRatio);
  const medianHeight = Math.max(1, median(media.map((rect) => rect.height)));
  const rowThreshold = medianHeight * 0.8;

  type Row = { centerY: number; members: typeof media };
  const rows: Row[] = [];
  for (const rect of [...media].sort((left, right) => left.centerY - right.centerY || left.centerX - right.centerX)) {
    const row = rows[rows.length - 1];
    if (!row || rect.centerY - row.centerY > rowThreshold) {
      rows.push({ centerY: rect.centerY, members: [rect] });
      continue;
    }
    row.members.push(rect);
    row.centerY = row.members.reduce((sum, member) => sum + member.centerY, 0) / row.members.length;
  }

  const ordered = rows.flatMap((row, rowIndex) =>
    [...row.members].sort((left, right) =>
      rowIndex % 2 === 0
        ? left.centerX - right.centerX
        : right.centerX - left.centerX
    )
  );

  const scale = readableZoom * canvasWidth / boardWidth;
  const halfViewportWidth = canvasWidth / (2 * scale);
  const halfViewportHeight = canvasHeight / (2 * scale);
  const centered = ordered.map((rect) => ({
    mediaId: rect.id,
    cameraX: clampCameraCenter(rect.centerX, boardWidth, halfViewportWidth),
    cameraY: clampCameraCenter(rect.centerY, boardHeight, halfViewportHeight),
    boardZoom: readableZoom,
  }));

  const cumulativeDistance = [0];
  for (let index = 1; index < centered.length; index++) {
    cumulativeDistance.push(cumulativeDistance[index - 1] + Math.hypot(
      centered[index].cameraX - centered[index - 1].cameraX,
      centered[index].cameraY - centered[index - 1].cameraY,
    ));
  }
  const totalDistance = cumulativeDistance[cumulativeDistance.length - 1];

  return centered.map((point, index) => ({
    ...point,
    progress: centered.length === 1
      ? 0
      : totalDistance > 0
        ? cumulativeDistance[index] / totalDistance
        : index / (centered.length - 1),
  }));
}
