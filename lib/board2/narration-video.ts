// Narration video: a video of the narrator that lives on the board as an item while its audio is
// the narration track. The board item is a video clip linked to its narration clip; its playback
// position is always the narration's, so timing, the shape mask and the crop below are shared by
// the editor preview, real-time export and deterministic export.

export type NarrationVideoShape = "original" | "circle" | "rect" | "freeform";

export type NarrationVideoMask = {
  shape: NarrationVideoShape;
  // freeform only: closed polygon [x0, y0, x1, y1, …], each 0–1 within the item's board rect
  points?: number[];
};

// The same 45% per-edge limit the media editor's crop uses (MAX_MEDIA_CROP_PERCENT).
export const NARRATION_VIDEO_MAX_CROP_PERCENT = 45;
const MIN_KEPT_FRACTION = 0.05;

export type CropPercents = { left: number; right: number; top: number; bottom: number };
export type NormalizedRect = { x0: number; y0: number; x1: number; y1: number };

type NarrationTiming = { startTime: number; duration: number; sourceOffsetSec?: number };

/**
 * Where the narration video's media is at a timeline instant. Before the narration it holds its
 * first frame and after it its last; `inRange` says whether it should be playing.
 */
export function narrationVideoSourceTime(narration: NarrationTiming, time: number, sourceDuration?: number): { sourceTime: number; inRange: boolean } {
  const local = Math.min(Math.max(0, time - narration.startTime), Math.max(0, narration.duration));
  let sourceTime = Math.max(0, narration.sourceOffsetSec ?? 0) + local;
  if (sourceDuration !== undefined && Number.isFinite(sourceDuration) && sourceDuration > 0) {
    sourceTime = Math.min(sourceTime, Math.max(0, sourceDuration - 0.001));
  }
  return { sourceTime, inRange: time >= narration.startTime && time < narration.startTime + narration.duration };
}

/**
 * Adds the mask outline for an item drawn at (x, y, width, height) to the context's current path.
 * Returns false when the shape needs no clip (original and rectangle: the crop alone frames them).
 */
export function traceNarrationVideoMask(
  ctx: Pick<CanvasRenderingContext2D, "beginPath" | "ellipse" | "moveTo" | "lineTo" | "closePath">,
  mask: NarrationVideoMask | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  if (mask?.shape === "circle") {
    ctx.beginPath();
    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    return true;
  }
  const points = mask?.shape === "freeform" ? mask.points : undefined;
  if (!points || points.length < 6) return false;
  ctx.beginPath();
  ctx.moveTo(x + points[0] * width, y + points[1] * height);
  for (let i = 2; i + 1 < points.length; i += 2) ctx.lineTo(x + points[i] * width, y + points[i + 1] * height);
  ctx.closePath();
  return true;
}

/** The same mask as a CSS clip-path, for the board's DOM item. */
export function narrationVideoMaskCss(mask: NarrationVideoMask | undefined): string | undefined {
  if (mask?.shape === "circle") return "ellipse(50% 50% at 50% 50%)";
  const points = mask?.shape === "freeform" ? mask.points : undefined;
  if (!points || points.length < 6) return undefined;
  const pairs: string[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) pairs.push(`${(points[i] * 100).toFixed(3)}% ${(points[i + 1] * 100).toFixed(3)}%`);
  return `polygon(${pairs.join(", ")})`;
}

function clampCrop(rect: NormalizedRect): CropPercents {
  const clamp = (value: number) => Math.min(NARRATION_VIDEO_MAX_CROP_PERCENT, Math.max(0, value * 100));
  return {
    left: clamp(rect.x0),
    right: clamp(1 - rect.x1),
    top: clamp(rect.y0),
    bottom: clamp(1 - rect.y1),
  };
}

/**
 * Turns the shape picked at placement into the item's crop (percent of the source frame, like
 * the media editor) and, for freeform, the polygon relative to the cropped frame. Inputs are
 * normalized to the full source frame. `aspect` is the cropped frame's width / height, so the
 * board item can be sized without stretching.
 */
export function fitNarrationVideoShape(
  shape: NarrationVideoShape,
  sourceWidth: number,
  sourceHeight: number,
  drawn: { rect?: NormalizedRect; points?: number[] } = {},
): { crop: CropPercents; mask: NarrationVideoMask; aspect: number } {
  const w = Math.max(1, sourceWidth);
  const h = Math.max(1, sourceHeight);
  let crop: CropPercents = { left: 0, right: 0, top: 0, bottom: 0 };
  let mask: NarrationVideoMask = { shape };
  if (shape === "circle") {
    // Centered square, so the ellipse is a true circle.
    const side = Math.min(w, h);
    crop = clampCrop({ x0: (w - side) / 2 / w, y0: (h - side) / 2 / h, x1: (w + side) / 2 / w, y1: (h + side) / 2 / h });
  } else if (shape === "rect" && drawn.rect) {
    crop = clampCrop(orderedRect(drawn.rect));
  } else if (shape === "freeform" && drawn.points && drawn.points.length >= 6) {
    const xs = drawn.points.filter((_, index) => index % 2 === 0);
    const ys = drawn.points.filter((_, index) => index % 2 === 1);
    crop = clampCrop({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    const keptX = Math.max(MIN_KEPT_FRACTION, 1 - (crop.left + crop.right) / 100);
    const keptY = Math.max(MIN_KEPT_FRACTION, 1 - (crop.top + crop.bottom) / 100);
    mask = {
      shape,
      points: drawn.points.map((value, index) => {
        const relative = index % 2 === 0 ? (value - crop.left / 100) / keptX : (value - crop.top / 100) / keptY;
        return Math.round(Math.min(1, Math.max(0, relative)) * 10000) / 10000;
      }),
    };
  } else if (shape !== "original") {
    mask = { shape: "original" };
  }
  const keptW = w * Math.max(MIN_KEPT_FRACTION, 1 - (crop.left + crop.right) / 100);
  const keptH = h * Math.max(MIN_KEPT_FRACTION, 1 - (crop.top + crop.bottom) / 100);
  return { crop, mask, aspect: keptW / keptH };
}

function orderedRect(rect: NormalizedRect): NormalizedRect {
  return {
    x0: Math.min(rect.x0, rect.x1),
    y0: Math.min(rect.y0, rect.y1),
    x1: Math.max(rect.x0, rect.x1),
    y1: Math.max(rect.y0, rect.y1),
  };
}

/** Drops freehand points closer than `minDistance` (normalized) to the previous kept point. */
export function simplifyFreeformPoints(points: number[], minDistance = 0.01): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const n = out.length;
    if (n >= 2 && Math.hypot(points[i] - out[n - 2], points[i + 1] - out[n - 1]) < minDistance) continue;
    out.push(points[i], points[i + 1]);
  }
  return out;
}
