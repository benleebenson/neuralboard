// Shared types, constants, and pure utilities used by both /editor and /board.

// ─── Types ───────────────────────────────────────────────────────────────────

export type ClipType = "audio" | "video" | "image" | "text" | "countdown";
export type ClipTransform = { x: number; y: number; scaleX: number; scaleY: number };
export type CurvePoint = { time: number; volume: number };

export type Clip = {
  id: string;
  type: ClipType;
  name: string;
  blobUrl: string;
  sourceDuration: number;
  durationSec: number;
  startTime: number;
  layer: number;
  trimStart: number;
  playbackRate: number;
  transform: ClipTransform;
  muted: boolean;
  volumeCurve: CurvePoint[];
  waveform?: number[];
  text?: string;
  textFontFamily?: string;
  textFontSize?: number;
  textColor?: string;
  cropZoom?: number;
  cropX?: number;
  cropY?: number;
  removeGreenScreen?: boolean;
  chromaSimilarity?: number;
  chromaSmoothness?: number;
  chromaAmount?: number;
  countdownTitle?: string;
  countdownItems?: Array<{ rank: number; label: string }>;
  revealOffsets?: number[];
};

export type AudioEntry =
  | { kind: "element"; elem: HTMLMediaElement; source: MediaElementAudioSourceNode; gainNode: GainNode }
  | { kind: "buffer"; bufNode: AudioBufferSourceNode; gainNode: GainNode };

// ─── Constants ───────────────────────────────────────────────────────────────

export const IMAGE_DEFAULT_DURATION = 3;
export const TEXT_DEFAULT_DURATION = 4;
export const TEXT_SOURCE_DURATION = 600;
export const SNAP = 0.1;
export const MIN_DURATION = 0.5;
export const MIN_PLAYBACK_RATE = 0.25;
export const MAX_PLAYBACK_RATE = 4;
export const MASTER_PLAYBACK_RATE = 1;
export const MAX_EXPORT_DURATION = 90;

export const DEFAULT_TRANSFORM: ClipTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
export const DEFAULT_CURVE: CurvePoint[] = [{ time: 0, volume: 100 }];

export const DEFAULT_CROP_ZOOM = 1;
export const DEFAULT_CROP_X = 0;
export const DEFAULT_CROP_Y = 0;

export const DEFAULT_CHROMA_SIMILARITY = 0.42;
export const DEFAULT_CHROMA_SMOOTHNESS = 0.08;
export const DEFAULT_CHROMA_AMOUNT = 0.55;

export const DEFAULT_TEXT = "Double click to edit";
export const DEFAULT_TEXT_FONT = "Arial";
export const DEFAULT_TEXT_SIZE = 56;
export const DEFAULT_TEXT_COLOR = "#ffffff";
export const COUNTDOWN_COLOR = "#cde7f5";

export const CLIP_COLORS: Record<ClipType, string> = {
  audio: "#c8f135",
  video: "#a0d8ef",
  image: "#f5c6a0",
  text: "#f6f1a2",
  countdown: COUNTDOWN_COLOR,
};

// ─── Timeline math ───────────────────────────────────────────────────────────

export const snapTo = (t: number) => Math.round(t / SNAP) * SNAP;
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function clipsOverlap(s1: number, d1: number, s2: number, d2: number): boolean {
  return s1 < s2 + d2 - 0.001 && s1 + d1 > s2 + 0.001;
}

export function findFreeLayer(existing: Clip[], startTime: number, duration: number, layerCount: number): number {
  for (let l = 1; l <= layerCount; l++) {
    if (!existing.some((c) => c.layer === l && clipsOverlap(startTime, duration, c.startTime, c.durationSec))) {
      return l;
    }
  }
  return layerCount + 1;
}

export function findFreeLayerOrNull(existing: Clip[], startTime: number, duration: number, layerCount: number): number | null {
  for (let l = 1; l <= layerCount; l++) {
    if (!existing.some((c) => c.layer === l && clipsOverlap(startTime, duration, c.startTime, c.durationSec))) {
      return l;
    }
  }
  return null;
}

export function magneticSnap(value: number, candidates: number[], threshold: number): { snapped: number; target: number | null } {
  let bestSnapped = value;
  let bestDist = threshold;
  let bestTarget: number | null = null;
  for (const c of candidates) {
    const d = Math.abs(value - c);
    if (d <= bestDist) {
      bestSnapped = c;
      bestDist = d;
      bestTarget = c;
    }
  }
  return { snapped: bestSnapped, target: bestTarget };
}

export function allOtherClipEdges(clips: Clip[], clipId: string): number[] {
  return clips
    .filter((c) => c.id !== clipId)
    .flatMap((c) => [c.startTime, c.startTime + c.durationSec]);
}

// ─── Clip accessors ──────────────────────────────────────────────────────────

export function isVisualClip(clip: Pick<Clip, "type">): boolean {
  return clip.type === "video" || clip.type === "image" || clip.type === "text" || clip.type === "countdown";
}

export function hasClipAudio(clip: Pick<Clip, "type">): boolean {
  return clip.type === "audio" || clip.type === "video";
}

export function isCroppableClip(clip: Pick<Clip, "type">): boolean {
  return clip.type === "image" || clip.type === "video";
}

export function clipCropZoom(clip: Pick<Clip, "cropZoom">): number {
  return clamp(clip.cropZoom ?? DEFAULT_CROP_ZOOM, 1, 4);
}

export function clipCropX(clip: Pick<Clip, "cropX">): number {
  return clamp(clip.cropX ?? DEFAULT_CROP_X, -100, 100);
}

export function clipCropY(clip: Pick<Clip, "cropY">): number {
  return clamp(clip.cropY ?? DEFAULT_CROP_Y, -100, 100);
}

export function clipPlaybackRate(clip: Pick<Clip, "playbackRate">): number {
  return clamp(clip.playbackRate || 1, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
}

export function mediaPlaybackRate(clip: Pick<Clip, "playbackRate">): number {
  return clipPlaybackRate(clip) * MASTER_PLAYBACK_RATE;
}

export function clipSourceSpan(clip: Pick<Clip, "durationSec" | "playbackRate" | "sourceDuration" | "trimStart">): number {
  const available = Math.max(0, clip.sourceDuration - clip.trimStart);
  return Math.min(available, Math.max(0, clip.durationSec * clipPlaybackRate(clip)));
}

export function clipSourceTimeAtTimeline(
  clip: Pick<Clip, "trimStart" | "startTime" | "durationSec" | "playbackRate" | "sourceDuration">,
  timelineSec: number,
): number {
  const sourceOffset = Math.max(0, timelineSec - clip.startTime) * clipPlaybackRate(clip);
  const sourceEnd = clip.trimStart + clipSourceSpan(clip);
  return clamp(clip.trimStart + sourceOffset, clip.trimStart, sourceEnd);
}

export function setElementPlaybackRate(elem: HTMLMediaElement, clip: Pick<Clip, "playbackRate">) {
  const rate = mediaPlaybackRate(clip);
  elem.playbackRate = rate;
  const pitchy = elem as HTMLMediaElement & { preservesPitch?: boolean; mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };
  pitchy.preservesPitch = false;
  pitchy.mozPreservesPitch = false;
  pitchy.webkitPreservesPitch = false;
}

export function waveformValueAtSourceSec(clip: Clip, sourceSec: number): number {
  if (!clip.waveform?.length || clip.sourceDuration <= 0) return 0;
  const idx = clamp(Math.floor((sourceSec / clip.sourceDuration) * clip.waveform.length), 0, clip.waveform.length - 1);
  return clip.waveform[idx] ?? 0;
}

// ─── Format helpers ──────────────────────────────────────────────────────────

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export function parseDurationSec(dur: string | number | undefined): number {
  if (typeof dur === "number") return dur > 0 ? dur : 600;
  if (!dur) return 600;
  const parts = dur.split(":").map(Number);
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  const asNum = Number(dur);
  return Number.isFinite(asNum) && asNum > 0 ? asNum : 600;
}

export function parseTimestampSec(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":").map((p) => p.trim());
  if (parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) return nums[0]! * 60 + nums[1]!;
  if (nums.length === 3) return nums[0]! * 3600 + nums[1]! * 60 + nums[2]!;
  return null;
}

export function formatTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function interpolateVolume(curve: CurvePoint[], t: number): number {
  if (curve.length === 0) return 1;
  const sorted = curve.slice().sort((a, b) => a.time - b.time);
  if (t <= sorted[0].time) return sorted[0].volume / 100;
  if (t >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].volume / 100;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (t >= sorted[i].time && t <= sorted[i + 1].time) {
      const frac = (t - sorted[i].time) / (sorted[i + 1].time - sorted[i].time);
      return (sorted[i].volume + frac * (sorted[i + 1].volume - sorted[i].volume)) / 100;
    }
  }
  return 1;
}

// ─── Canvas / chroma key ─────────────────────────────────────────────────────

export function chromaSettings(clip: Clip) {
  return {
    enabled: !!clip.removeGreenScreen,
    similarity: clip.chromaSimilarity ?? DEFAULT_CHROMA_SIMILARITY,
    smoothness: clip.chromaSmoothness ?? DEFAULT_CHROMA_SMOOTHNESS,
    amount: clip.chromaAmount ?? DEFAULT_CHROMA_AMOUNT,
  };
}

function chromaAlpha(r: number, g: number, b: number, similarity: number, smoothness: number, amount: number): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const greenDistance = Math.sqrt(rn * rn + (gn - 1) * (gn - 1) + bn * bn);
  const greenDominance = Math.max(0, gn - Math.max(rn, bn));
  const strength = Math.max(0, Math.min(1, amount));
  const effectiveSimilarity = similarity + strength * 0.28;
  const effectiveDominance = 1.15 + strength * 0.95;
  const edge0 = Math.max(0.01, effectiveSimilarity - smoothness);
  const edge1 = Math.min(1.5, effectiveSimilarity + smoothness);
  const byDistance = Math.max(0, Math.min(1, (greenDistance - edge0) / (edge1 - edge0)));
  const byDominance = Math.max(0, Math.min(1, 1 - greenDominance * effectiveDominance));
  return Math.max(byDistance, byDominance);
}

export function applyGreenScreenToImageData(data: Uint8ClampedArray, similarity: number, smoothness: number, amount: number) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a <= 0) continue;
    const alpha = chromaAlpha(data[i], data[i + 1], data[i + 2], similarity, smoothness, amount);
    data[i + 3] = Math.round(data[i + 3] * alpha);
    if (alpha < 1) {
      const spill = 1 - alpha;
      data[i + 1] = Math.round(data[i + 1] * (1 - spill * (0.35 + amount * 0.35)));
    }
  }
}

export function drawContainedRect(
  sourceW: number,
  sourceH: number,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
) {
  if (sourceW <= 0 || sourceH <= 0) return { x: boxX, y: boxY, w: boxW, h: boxH };
  const sourceAspect = sourceW / sourceH;
  const boxAspect = boxW / boxH;
  if (sourceAspect > boxAspect) {
    const h = boxW / sourceAspect;
    return { x: boxX, y: boxY + (boxH - h) / 2, w: boxW, h };
  }
  const w = boxH * sourceAspect;
  return { x: boxX + (boxW - w) / 2, y: boxY, w, h: boxH };
}

export function cropSourceRect(sourceW: number, sourceH: number, clip: Clip) {
  const zoom = clipCropZoom(clip);
  const sw = sourceW / zoom;
  const sh = sourceH / zoom;
  const sx = clamp(
    (sourceW - sw) / 2 + (clipCropX(clip) / 100) * ((sourceW - sw) / 2),
    0,
    Math.max(0, sourceW - sw),
  );
  const sy = clamp(
    (sourceH - sh) / 2 + (clipCropY(clip) / 100) * ((sourceH - sh) / 2),
    0,
    Math.max(0, sourceH - sh),
  );
  return { sx, sy, sw, sh };
}

export function drawMaybeKeyedMedia(
  ctx: CanvasRenderingContext2D,
  media: HTMLVideoElement | HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  clip: Clip,
) {
  const sourceW = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const sourceH = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  const crop = sourceW > 0 && sourceH > 0 ? cropSourceRect(sourceW, sourceH, clip) : null;
  const settings = chromaSettings(clip);
  if (!settings.enabled) {
    if (crop) ctx.drawImage(media, crop.sx, crop.sy, crop.sw, crop.sh, dx, dy, dw, dh);
    else ctx.drawImage(media, dx, dy, dw, dh);
    return;
  }

  const w = Math.max(1, Math.round(dw));
  const h = Math.max(1, Math.round(dh));
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const offCtx = off.getContext("2d", { willReadFrequently: true });
  if (!offCtx) {
    if (crop) ctx.drawImage(media, crop.sx, crop.sy, crop.sw, crop.sh, dx, dy, dw, dh);
    else ctx.drawImage(media, dx, dy, dw, dh);
    return;
  }
  if (crop) offCtx.drawImage(media, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
  else offCtx.drawImage(media, 0, 0, w, h);
  const frame = offCtx.getImageData(0, 0, w, h);
  applyGreenScreenToImageData(frame.data, settings.similarity, settings.smoothness, settings.amount);
  offCtx.putImageData(frame, 0, 0);
  ctx.drawImage(off, dx, dy, dw, dh);
}

export function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  x: number,
  y: number,
  w: number,
  h: number,
  canvasH: number,
) {
  const text = clip.text || DEFAULT_TEXT;
  const fontFamily = clip.textFontFamily || DEFAULT_TEXT_FONT;
  const fontSize = clip.textFontSize ?? DEFAULT_TEXT_SIZE;
  const scaledFontSize = Math.max(8, fontSize * (canvasH / 720));
  const color = clip.textColor || DEFAULT_TEXT_COLOR;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  ctx.save();
  ctx.font = `700 ${scaledFontSize}px ${fontFamily}`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.65)";
  ctx.shadowBlur = Math.max(2, scaledFontSize * 0.08);
  ctx.shadowOffsetY = Math.max(1, scaledFontSize * 0.04);

  for (const word of words.length ? words : [text]) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > w && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const lineHeight = scaledFontSize * 1.12;
  const startY = y + h / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((textLine, idx) => {
    ctx.fillText(textLine, x + w / 2, startY + idx * lineHeight, w);
  });
  ctx.restore();
}

export function drawCountdownClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  x: number,
  y: number,
  w: number,
  h: number,
  canvasH: number,
  clipElapsed: number,
) {
  const title = clip.countdownTitle ?? "Top 5";
  const items = clip.countdownItems ?? [];
  const offsets = clip.revealOffsets ?? [];
  const n = items.length;
  if (n === 0) return;

  ctx.save();

  const scale = canvasH / 720;
  const titleFontSize = Math.max(14, 40 * scale);
  const itemFontSize = Math.max(10, 28 * scale);
  const lineH = itemFontSize * 1.9;

  ctx.textBaseline = "middle";

  ctx.font = `700 ${titleFontSize}px Arial, sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = titleFontSize * 0.18;
  ctx.shadowOffsetY = titleFontSize * 0.05;
  const titleY = y + h * 0.06 + titleFontSize * 0.6;
  ctx.fillText(title, x + w / 2, titleY, w * 0.9);

  for (let i = 0; i < n; i++) {
    const rankNum = n - i;
    const item = items.find((it) => it.rank === rankNum);
    const offset = offsets[i] ?? 0;
    const revealed = clipElapsed >= offset;

    const itemY = titleY + titleFontSize * 0.8 + (i + 0.7) * lineH;
    if (itemY + lineH / 2 > y + h * 0.98) break;

    ctx.font = `700 ${itemFontSize}px Arial, sans-serif`;
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = itemFontSize * 0.12;
    ctx.shadowOffsetY = 2 * scale;

    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText(`${rankNum}.`, x + w * 0.15, itemY, w * 0.13);

    if (revealed) {
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(item?.label ?? "", x + w * 0.18, itemY, w * 0.79);
    }
  }

  ctx.restore();
}

// ─── Media helpers ────────────────────────────────────────────────────────────

export async function getMediaDuration(blobUrl: string, type: ClipType): Promise<number> {
  if (type === "image") return IMAGE_DEFAULT_DURATION;
  if (type === "text") return TEXT_DEFAULT_DURATION;
  return new Promise((resolve) => {
    const el = type === "video" ? document.createElement("video") : document.createElement("audio");
    el.preload = "metadata";
    el.addEventListener("loadedmetadata", () => {
      resolve(isFinite(el.duration) && el.duration > 0 ? el.duration : 0);
    }, { once: true });
    el.addEventListener("error", () => resolve(0), { once: true });
    el.src = blobUrl;
  });
}

export async function generateWaveform(blobUrl: string, bins = 180): Promise<number[]> {
  const res = await fetch(blobUrl);
  const arrayBuffer = await res.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const channelCount = Math.max(1, buffer.numberOfChannels);
    const samplesPerBin = Math.max(1, Math.floor(buffer.length / bins));
    const peaks: number[] = [];

    for (let i = 0; i < bins; i++) {
      const start = i * samplesPerBin;
      const end = i === bins - 1 ? buffer.length : Math.min(buffer.length, start + samplesPerBin);
      let sum = 0;
      let count = 0;

      for (let channel = 0; channel < channelCount; channel++) {
        const data = buffer.getChannelData(channel);
        for (let sample = start; sample < end; sample++) {
          sum += data[sample] * data[sample];
          count++;
        }
      }

      peaks.push(count > 0 ? Math.sqrt(sum / count) : 0);
    }

    const max = Math.max(...peaks, 0.001);
    return peaks.map((peak) => clamp(peak / max, 0.03, 1));
  } finally {
    ctx.close().catch(() => {});
  }
}
