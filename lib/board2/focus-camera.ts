export type FocusRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FocusCamera = {
  cameraX: number;
  cameraY: number;
  boardZoom: number;
};

/** Leaves a 3% margin on each side of the focused rect's limiting axis. */
export const FOCUS_FILL_RATIO = 0.94;

/**
 * Returns the board-to-screen scale that keeps the whole rect visible while making it as large
 * as the output frame permits. The smaller axis fit is the constraint; the fill ratio then adds
 * a small, symmetric safety margin on that limiting axis.
 */
export function focusScreenScale(
  rectWidth: number,
  rectHeight: number,
  frameWidth: number,
  frameHeight: number,
  fillRatio = FOCUS_FILL_RATIO,
): number {
  const safeRectWidth = Math.max(1, rectWidth);
  const safeRectHeight = Math.max(1, rectHeight);
  const safeFrameWidth = Math.max(1, frameWidth);
  const safeFrameHeight = Math.max(1, frameHeight);
  return Math.min(1, Math.max(0.01, fillRatio)) * Math.min(
    safeFrameWidth / safeRectWidth,
    safeFrameHeight / safeRectHeight,
  );
}

export function cameraForFocusRect(
  rect: FocusRect,
  frameWidth: number,
  frameHeight: number,
  boardWidth: number,
  fillRatio = FOCUS_FILL_RATIO,
): FocusCamera {
  const screenScale = focusScreenScale(
    rect.width,
    rect.height,
    frameWidth,
    frameHeight,
    fillRatio,
  );
  return {
    cameraX: rect.x + rect.width / 2,
    cameraY: rect.y + rect.height / 2,
    boardZoom: screenScale * Math.max(1, boardWidth) / Math.max(1, frameWidth),
  };
}
