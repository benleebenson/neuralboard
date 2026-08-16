export type CameraFrame = {
  cameraX: number;
  cameraY: number;
  boardZoom: number;
};

export type BoardRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CameraFrameBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export function cameraFrameBounds(
  camera: CameraFrame,
  outputWidth: number,
  outputHeight: number,
  boardWidth: number,
): CameraFrameBounds {
  const safeOutputWidth = Math.max(1, outputWidth);
  const safeOutputHeight = Math.max(1, outputHeight);
  const safeBoardWidth = Math.max(1, boardWidth);
  const zoom = Math.max(0.05, camera.boardZoom);
  const width = safeBoardWidth / zoom;
  const height = width * safeOutputHeight / safeOutputWidth;
  return {
    left: camera.cameraX - width / 2,
    right: camera.cameraX + width / 2,
    top: camera.cameraY - height / 2,
    bottom: camera.cameraY + height / 2,
    width,
    height,
  };
}

export function boardRectIntersectsCameraFrame(
  rect: BoardRect,
  camera: CameraFrame,
  outputWidth: number,
  outputHeight: number,
  boardWidth: number,
  marginRatio = 0,
): boolean {
  const frame = cameraFrameBounds(camera, outputWidth, outputHeight, boardWidth);
  const safeMarginRatio = Number.isFinite(marginRatio) ? Math.max(0, marginRatio) : 0;
  const marginX = frame.width * safeMarginRatio;
  const marginY = frame.height * safeMarginRatio;
  return rect.x + rect.width >= frame.left - marginX &&
    rect.x <= frame.right + marginX &&
    rect.y + rect.height >= frame.top - marginY &&
    rect.y <= frame.bottom + marginY;
}
