export const DEFAULT_MEDIA_MAX_WIDTH = 800;
export const DEFAULT_MEDIA_MAX_HEIGHT = 600;

export function fitMediaDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth = DEFAULT_MEDIA_MAX_WIDTH,
  maxHeight = DEFAULT_MEDIA_MAX_HEIGHT,
): { w: number; h: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) return { w: maxWidth, h: maxHeight };
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    w: Math.max(1, Math.round(sourceWidth * scale)),
    h: Math.max(1, Math.round(sourceHeight * scale)),
  };
}
