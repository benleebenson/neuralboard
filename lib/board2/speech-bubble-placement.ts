export const SPEECH_BUBBLE_FRAME_MARGIN_RATIO = 0.07;

export type SpeechBubblePlacementRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SpeechBubblePlacementAnchor = { x: number; y: number };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function intersectionArea(a: SpeechBubblePlacementRect, b: SpeechBubblePlacementRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function placementInRegion(
  region: SpeechBubblePlacementRect,
  boxWidth: number,
  boxHeight: number,
  anchor: SpeechBubblePlacementAnchor | null | undefined,
  seed: number,
): SpeechBubblePlacementRect | null {
  if (region.width < boxWidth || region.height < boxHeight) return null;
  const preferredCenterX = anchor?.x ?? region.x + region.width * (0.38 + seed * 0.24);
  const preferredCenterY = anchor?.y ?? region.y + region.height * (0.38 + seed * 0.24);
  return {
    x: clamp(preferredCenterX - boxWidth / 2, region.x, region.x + region.width - boxWidth),
    y: clamp(preferredCenterY - boxHeight / 2, region.y, region.y + region.height - boxHeight),
    width: boxWidth,
    height: boxHeight,
  };
}

/**
 * Places a bubble in screen space. Clear frame regions are preferred in this order:
 * above the focused image, a deterministic side order, then below it. Only the
 * final fallback may overlap the image. Every result is inset from the live frame.
 */
export function placeSpeechBubbleInFrame(
  frameWidth: number,
  frameHeight: number,
  boxWidth: number,
  boxHeight: number,
  focusedImage: SpeechBubblePlacementRect | null | undefined,
  anchor: SpeechBubblePlacementAnchor | null | undefined,
  seed: number,
): SpeechBubblePlacementRect {
  const margin = Math.min(frameWidth, frameHeight) * SPEECH_BUBBLE_FRAME_MARGIN_RATIO;
  const safeFrame = {
    x: margin,
    y: margin,
    width: Math.max(0, frameWidth - margin * 2),
    height: Math.max(0, frameHeight - margin * 2),
  };
  const clampedBoxWidth = Math.min(boxWidth, safeFrame.width);
  const clampedBoxHeight = Math.min(boxHeight, safeFrame.height);

  if (focusedImage) {
    const gap = margin * 0.35;
    const imageLeft = clamp(focusedImage.x, safeFrame.x, safeFrame.x + safeFrame.width);
    const imageTop = clamp(focusedImage.y, safeFrame.y, safeFrame.y + safeFrame.height);
    const imageRight = clamp(focusedImage.x + focusedImage.width, safeFrame.x, safeFrame.x + safeFrame.width);
    const imageBottom = clamp(focusedImage.y + focusedImage.height, safeFrame.y, safeFrame.y + safeFrame.height);
    const above = { x: safeFrame.x, y: safeFrame.y, width: safeFrame.width, height: Math.max(0, imageTop - gap - safeFrame.y) };
    const right = { x: imageRight + gap, y: safeFrame.y, width: Math.max(0, safeFrame.x + safeFrame.width - imageRight - gap), height: safeFrame.height };
    const left = { x: safeFrame.x, y: safeFrame.y, width: Math.max(0, imageLeft - gap - safeFrame.x), height: safeFrame.height };
    const below = { x: safeFrame.x, y: imageBottom + gap, width: safeFrame.width, height: Math.max(0, safeFrame.y + safeFrame.height - imageBottom - gap) };
    const sides = seed < 0.5 ? [left, right] : [right, left];
    for (const region of [above, ...sides, below]) {
      const placement = placementInRegion(region, clampedBoxWidth, clampedBoxHeight, anchor, seed);
      if (placement) return placement;
    }
  }

  const fallbackCenters = [
    { x: 0.5, y: 0.22 },
    { x: 0.78, y: 0.42 },
    { x: 0.22, y: 0.42 },
    { x: 0.5, y: 0.76 },
    { x: 0.76, y: 0.76 },
    { x: 0.24, y: 0.76 },
  ];
  const rotation = Math.floor(seed * fallbackCenters.length) % fallbackCenters.length;
  const candidates = fallbackCenters.map((_, index) => {
    const center = fallbackCenters[(index + rotation) % fallbackCenters.length];
    return {
      x: clamp(safeFrame.x + safeFrame.width * center.x - clampedBoxWidth / 2, safeFrame.x, safeFrame.x + safeFrame.width - clampedBoxWidth),
      y: clamp(safeFrame.y + safeFrame.height * center.y - clampedBoxHeight / 2, safeFrame.y, safeFrame.y + safeFrame.height - clampedBoxHeight),
      width: clampedBoxWidth,
      height: clampedBoxHeight,
    };
  });
  if (!focusedImage) return candidates[0];
  return candidates.reduce((best, candidate) =>
    intersectionArea(candidate, focusedImage) < intersectionArea(best, focusedImage) ? candidate : best
  );
}
