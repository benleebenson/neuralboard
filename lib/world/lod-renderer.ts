import { assetStoragePath, itemSelectionKey, previewStoragePath, rectIntersects, regionSelectionKey } from "./world-model.ts";
import type { FarLod, WorldMediaPlacement, WorldRect, WorldRegion } from "./world-model.ts";

/**
 * Level of detail for the world canvas.
 *
 *   FAR   no media at all. Each region is one pre-rendered ink-wash bitmap (FarBlobCache) plus its
 *         name. One drawImage per region per frame.
 *   MID   the region's media as ≤320px previews, in their real positions. Originals are never touched.
 *   NEAR  full-size media, as the editor renders it — but only for items big enough on screen to
 *         need the pixels; smaller ones keep using the preview that MID already loaded.
 *
 * The three levels are drawn as layers whose opacity comes from `lodWeights(zoom)`, so crossing a
 * threshold is a crossfade, never a pop. Regions outside the viewport are skipped before any of this.
 */

export type LodWeights = { far: number; mid: number; near: number };

export const INK = "#28251f";
export const LABEL_FONT = "'Caveat', Georgia, serif";

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function lodWeights(zoom: number): LodWeights {
  const farToMid = smoothstep(0.075, 0.16, zoom);
  const midToNear = smoothstep(0.34, 0.62, zoom);
  return { far: 1 - farToMid, mid: farToMid * (1 - midToNear), near: midToNear };
}

/** Above this weight a level is considered "the" level: used for hit-testing items and for the readout. */
export const NEAR_INTERACTIVE_WEIGHT = 0.18;

// ── far level: cached ink-wash bitmaps ───────────────────────────────────────

const BLOB_LONG_SIDE = 160;
const BLOB_PAD = 0.14;
/** Bitmaps are ~80 KB each; this caps the cache near 32 MB however large the world grows. */
const MAX_BLOBS = 400;

type BlobSurface = HTMLCanvasElement | OffscreenCanvas;
type BlobEntry = { key: string; surface: BlobSurface; lastUsed: number };

function createSurface(width: number, height: number): BlobSurface | null {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  return null;
}

/** `getContext` is callable on both canvas kinds, but TypeScript will not resolve the overloads across the union. */
function context2d(surface: BlobSurface): CanvasRenderingContext2D | null {
  return (surface as HTMLCanvasElement).getContext("2d");
}

function renderBlob(far: FarLod): BlobSurface | null {
  const aspect = far.extentWidth / far.extentHeight;
  const width = aspect >= 1 ? BLOB_LONG_SIDE : BLOB_LONG_SIDE * aspect;
  const height = aspect >= 1 ? BLOB_LONG_SIDE / aspect : BLOB_LONG_SIDE;
  const surface = createSurface(width * (1 + 2 * BLOB_PAD), height * (1 + 2 * BLOB_PAD));
  const grid = createSurface(far.cols, far.rows);
  if (!surface || !grid) return null;
  const context = context2d(surface);
  const gridContext = context2d(grid);
  if (!context || !gridContext) return null;
  for (let index = 0; index < far.density.length; index += 1) {
    const density = far.density[index] / 100;
    if (density <= 0) continue;
    gridContext.fillStyle = `rgba(53,66,53,${(0.14 + density * 0.5).toFixed(3)})`;
    gridContext.fillRect(index % far.cols, Math.floor(index / far.cols), 1, 1);
  }
  // The coverage grid is a tiny image; stretching it with smoothing gives soft edges, and three
  // progressively larger, fainter copies add the wash-like halo around the dense core.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const centerX = surface.width / 2;
  const centerY = surface.height / 2;
  for (const [scale, alpha] of [[1, 0.6], [1.3, 0.28], [1.8, 0.14]] as const) {
    context.globalAlpha = alpha;
    context.drawImage(grid as CanvasImageSource, centerX - (width * scale) / 2, centerY - (height * scale) / 2, width * scale, height * scale);
  }
  context.globalAlpha = 1;
  return surface;
}

/**
 * Pre-rendered far-zoom blob per region, keyed by the region's content fingerprint. A blob is built
 * once (idle-time via `prewarm`, or on first sight) and rebuilt only when the region's contents
 * change; drawing it costs one drawImage.
 */
export class FarBlobCache {
  private entries = new Map<string, BlobEntry>();
  private built = 0;

  get(region: WorldRegion, now: number): BlobSurface | null {
    const key = `${region.lod.contentFingerprint}:${region.lod.far.cols}x${region.lod.far.rows}`;
    const existing = this.entries.get(region.id);
    if (existing && existing.key === key) {
      existing.lastUsed = now;
      return existing.surface;
    }
    const surface = renderBlob(region.lod.far);
    if (!surface) return null;
    this.built += 1;
    this.entries.set(region.id, { key, surface, lastUsed: now });
    if (this.entries.size > MAX_BLOBS) this.evictOldest();
    return surface;
  }

  /** Builds missing blobs until the time budget is spent. Returns how many regions still need one. */
  prewarm(regions: readonly WorldRegion[], budgetMs: number, now: number): number {
    const deadline = performance.now() + budgetMs;
    let remaining = 0;
    for (const region of regions) {
      const key = `${region.lod.contentFingerprint}:${region.lod.far.cols}x${region.lod.far.rows}`;
      if (this.entries.get(region.id)?.key === key) continue;
      if (performance.now() >= deadline) { remaining += 1; continue; }
      this.get(region, now);
    }
    return remaining;
  }

  stats(): { cached: number; built: number } {
    return { cached: this.entries.size, built: this.built };
  }

  clear(): void {
    this.entries.clear();
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldest = Infinity;
    for (const [id, entry] of this.entries) if (entry.lastUsed < oldest) { oldest = entry.lastUsed; oldestId = id; }
    if (oldestId) this.entries.delete(oldestId);
  }
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** The slice of the image store the renderer needs. */
export type LodImages = {
  want(path: string, kind: "preview" | "full", priority: number): void;
  get(path: string | undefined, now: number): HTMLImageElement | undefined;
  isFailed(path: string | undefined): boolean;
};

export type LodFrame = {
  camera: { x: number; y: number; zoom: number };
  viewport: WorldRect;
  weights: LodWeights;
  now: number;
  images: LodImages;
  blobs: FarBlobCache;
  isSelected: (key: string) => boolean;
};

/** Below this on-screen size an item is a speck: MID does not even ask for its preview. */
const MIN_PREVIEW_SCREEN_PX = 28;
/** NEAR swaps a preview for the original only once the item is larger on screen than the preview's own resolution. */
const FULL_RESOLUTION_SCREEN_PX = 320;

export function regionMediaRect(region: WorldRegion, media: WorldMediaPlacement): WorldRect {
  return { x: region.bounds.x + media.x, y: region.bounds.y + media.y, width: media.width, height: media.height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function drawFar(context: CanvasRenderingContext2D, region: WorldRegion, frame: LodFrame): void {
  context.save();
  context.globalAlpha = frame.weights.far;
  const blob = frame.blobs.get(region, frame.now);
  const far = region.lod.far;
  if (blob) {
    const padX = far.extentWidth * BLOB_PAD;
    const padY = far.extentHeight * BLOB_PAD;
    context.drawImage(blob as CanvasImageSource, region.bounds.x - padX, region.bounds.y - padY, far.extentWidth + padX * 2, far.extentHeight + padY * 2);
  }
  const labelSize = clamp(250 + region.lod.media.length * 10, 280, Math.min(760, region.bounds.width * 0.18));
  context.fillStyle = INK;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `700 ${labelSize}px ${LABEL_FONT}`;
  context.fillText(region.name, region.bounds.x + region.bounds.width / 2, region.bounds.y + region.bounds.height / 2, region.bounds.width * 0.82);
  context.restore();
}

function drawMedia(context: CanvasRenderingContext2D, region: WorldRegion, frame: LodFrame, detail: "mid" | "near", alpha: number): void {
  if (alpha <= 0.002) return;
  const { camera, viewport, images, now } = frame;
  context.save();
  context.globalAlpha = alpha;
  for (const media of region.lod.media) {
    const rect = regionMediaRect(region, media);
    if (!rectIntersects(viewport, rect)) continue;
    const screenSize = Math.max(rect.width, rect.height) * camera.zoom;
    if (screenSize < 1.5) continue;
    // Only still images are handed to the loader; videos and unknown media get a placeholder.
    const previewPath = media.type === "image" && media.asset && media.preview ? previewStoragePath(media.asset) : undefined;
    const fullPath = media.type === "image" && media.asset ? assetStoragePath(media.asset) : undefined;
    const wantFull = detail === "near" && !!fullPath && (!previewPath || screenSize > FULL_RESOLUTION_SCREEN_PX);
    const path = wantFull ? fullPath : screenSize >= MIN_PREVIEW_SCREEN_PX ? previewPath : undefined;
    if (path) images.want(path, wantFull ? "full" : "preview", (rect.x - camera.x) ** 2 + (rect.y - camera.y) ** 2);
    const image = images.get(path, now) ?? (wantFull ? images.get(previewPath, now) : undefined);
    context.save();
    context.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
    context.rotate((media.rotation * Math.PI) / 180);
    if (image?.complete && image.naturalWidth > 0) context.drawImage(image, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
    else {
      context.fillStyle = media.type !== "image" ? "#8f8a7e" : images.isFailed(path) ? "#c9a9a0" : detail === "mid" ? "#b9b4a8" : "#d2cdc2";
      context.fillRect(-rect.width / 2, -rect.height / 2, rect.width, rect.height);
    }
    if (frame.isSelected(itemSelectionKey(region.id, media.id))) {
      context.strokeStyle = "#688600";
      context.lineWidth = 5 / camera.zoom;
      context.strokeRect(-rect.width / 2, -rect.height / 2, rect.width, rect.height);
    }
    context.restore();
  }
  context.restore();
}

/** Draws one visible region: frame, then the far/mid/near layers at their crossfade weights, then the name. */
export function drawRegion(context: CanvasRenderingContext2D, region: WorldRegion, frame: LodFrame): void {
  const { camera, weights } = frame;
  const selected = frame.isSelected(regionSelectionKey(region.id));
  context.fillStyle = "rgba(255,253,245,.38)";
  context.strokeStyle = selected ? "#688600" : "rgba(40,37,31,.35)";
  context.lineWidth = (selected ? 5 : 2) / camera.zoom;
  context.setLineDash(selected ? [16 / camera.zoom, 10 / camera.zoom] : []);
  context.fillRect(region.bounds.x, region.bounds.y, region.bounds.width, region.bounds.height);
  context.strokeRect(region.bounds.x, region.bounds.y, region.bounds.width, region.bounds.height);
  context.setLineDash([]);
  if (weights.far > 0.002) drawFar(context, region, frame);
  drawMedia(context, region, frame, "mid", weights.mid);
  drawMedia(context, region, frame, "near", weights.near);
  if (weights.far < 0.72) {
    context.fillStyle = INK;
    context.font = `700 ${clamp(48 / camera.zoom, 42, 180)}px ${LABEL_FONT}`;
    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.fillText(region.name, region.bounds.x + 30 / camera.zoom, region.bounds.y - 12 / camera.zoom);
  }
}
