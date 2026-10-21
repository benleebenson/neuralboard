// Animated GIF (and animated WebP) board images. A clip flagged `animatedImage` keeps its source
// file; its frames are decoded once into ImageBitmaps and every renderer — board overlay, preview,
// real-time and offline export — picks the frame for an instant with animatedImageFrameIndex, so
// the loop is anchored to timeline zero and frame N of an export is the same however it is reached.

// Browsers show GIF frame delays of 10ms or less as 100ms; match that so timing looks the same.
const MIN_FRAME_MS = 20;
const DEFAULT_FRAME_MS = 100;
// Decoded frames are uncompressed, so large or long GIFs are scaled down and, past MAX_FRAMES,
// merged into fewer frames, keeping each GIF's frame cache within FRAME_BYTES_BUDGET.
const MAX_LONG_EDGE = 1024;
const MAX_FRAMES = 400;
const FRAME_BYTES_BUDGET = 128 * 1024 * 1024;

export type AnimatedImage = {
  frames: ImageBitmap[];
  /** Start of each frame within one loop, in ms; ascending, frameStartsMs[0] === 0. */
  frameStartsMs: number[];
  loopMs: number;
  width: number;
  height: number;
};

export function isAnimatableImageType(type: string): boolean {
  const mime = type.split(";")[0].trim().toLowerCase();
  return mime === "image/gif" || mime === "image/webp";
}

export function isGifFile(file: Blob, name = ""): boolean {
  return file.type === "image/gif" || (!file.type && /\.gif$/i.test(name));
}

function isGiphyHost(hostname: string): boolean {
  return /(^|\.)giphy\.com$/i.test(hostname);
}

function isTenorHost(hostname: string): boolean {
  return /(^|\.)tenor\.com$/i.test(hostname) || /(^|\.)tenor\.googleapis\.com$/i.test(hostname);
}

/**
 * The URL to fetch for a pasted or dropped image when it may be an animated GIF, or null when it
 * isn't one. Browsers put a flattened single-frame bitmap on the clipboard for "Copy image", but
 * also the image's URL, which is the real file. Giphy pages display a .webp or .mp4 rendition of
 * the same GIF and its page links name the GIF id, so both are mapped to the .gif file.
 */
export function animatedImageSourceUrl(candidate: string | null | undefined): string | null {
  const value = candidate?.trim();
  if (!value) return null;
  if (/^data:image\/(gif|webp)[;,]/i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isGiphyHost(url.hostname)) {
    // giphy.com/gifs/some-title-<id> or giphy.com/gifs/<id>
    const page = /^\/(?:gifs|stickers)\/(?:[^/]*-)?([A-Za-z0-9]+)\/?$/.exec(url.pathname);
    if (page && !/^(media|i)\d*\./i.test(url.hostname)) return `https://media.giphy.com/media/${page[1]}/giphy.gif`;
    if (/\.(gif|webp|mp4)$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\.(webp|mp4)$/i, ".gif");
      url.searchParams.delete("rid");
      return url.toString();
    }
    return null;
  }
  if (isTenorHost(url.hostname)) return /\.(gif|webp)$/i.test(url.pathname) ? url.toString() : null;
  return /\.gif$/i.test(url.pathname) ? url.toString() : null;
}

/** The frame showing at `timeSec`, looping from time zero. */
export function animatedImageFrameIndex(frameStartsMs: readonly number[], loopMs: number, timeSec: number): number {
  if (frameStartsMs.length <= 1 || !(loopMs > 0)) return 0;
  const ms = ((timeSec * 1000) % loopMs + loopMs) % loopMs;
  let low = 0;
  let high = frameStartsMs.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (frameStartsMs[mid] <= ms) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Groups consecutive frames so at most `maxFrames` remain; each group shows its first frame for the group's total time. */
export function mergeFrameDurations(durationsMs: readonly number[], maxFrames = MAX_FRAMES): { keep: number[]; durationsMs: number[] } {
  const step = Math.max(1, Math.ceil(durationsMs.length / maxFrames));
  const keep: number[] = [];
  const merged: number[] = [];
  for (let index = 0; index < durationsMs.length; index += step) {
    keep.push(index);
    merged.push(durationsMs.slice(index, index + step).reduce((sum, value) => sum + value, 0));
  }
  return { keep, durationsMs: merged };
}

export function normalizedFrameDurationMs(durationUs: number | null | undefined): number {
  const ms = (durationUs ?? 0) / 1000;
  return ms >= MIN_FRAME_MS ? ms : DEFAULT_FRAME_MS;
}

export function animatedImageSupported(): boolean {
  return typeof ImageDecoder !== "undefined" && typeof createImageBitmap !== "undefined";
}

/**
 * Decodes every frame of an animated GIF/WebP. Resolves null for a single-frame image, a type
 * that isn't GIF/WebP, or a browser without ImageDecoder (the clip then shows as a still).
 */
export async function decodeAnimatedImage(blob: Blob): Promise<AnimatedImage | null> {
  if (!animatedImageSupported()) return null;
  const sniffed = await sniffAnimatableType(blob);
  if (!sniffed || !(await ImageDecoder.isTypeSupported(sniffed))) return null;
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: sniffed });
  const bitmaps: ImageBitmap[] = [];
  try {
    // `selectedTrack` stays null until `tracks.ready`; the frame count is final after `completed`.
    await Promise.all([decoder.tracks.ready, decoder.completed]);
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount < 2) return null;

    const durations: number[] = [];
    let width = 0;
    let height = 0;
    for (let index = 0; index < track.frameCount; index++) {
      const { image } = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
      if (index === 0) { width = image.displayWidth; height = image.displayHeight; }
      durations.push(normalizedFrameDurationMs(image.duration));
      image.close();
    }
    const { keep, durationsMs } = mergeFrameDurations(durations);
    const budgetScale = Math.sqrt(FRAME_BYTES_BUDGET / Math.max(1, keep.length * width * height * 4));
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(width, height), budgetScale);
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));
    for (const index of keep) {
      const { image } = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
      try {
        bitmaps.push(await createImageBitmap(image, scale < 1 ? { resizeWidth: outWidth, resizeHeight: outHeight, resizeQuality: "medium" } : {}));
      } finally {
        image.close();
      }
    }
    const frameStartsMs: number[] = [];
    let loopMs = 0;
    for (const duration of durationsMs) {
      frameStartsMs.push(loopMs);
      loopMs += duration;
    }
    return { frames: bitmaps, frameStartsMs, loopMs, width: outWidth, height: outHeight };
  } catch (error) {
    for (const bitmap of bitmaps) bitmap.close();
    console.warn("[animated-image] Could not decode frames; showing a still image", error);
    return null;
  } finally {
    decoder.close();
  }
}

export function releaseAnimatedImage(image: AnimatedImage) {
  for (const frame of image.frames) frame.close();
}

// Files from the web often arrive with a missing or generic MIME type, and shared boards store
// GIFs as animated WebP, so the type comes from the file's leading bytes.
async function sniffAnimatableType(blob: Blob): Promise<"image/gif" | "image/webp" | null> {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = String.fromCharCode(...head);
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}
