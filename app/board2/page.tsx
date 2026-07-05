"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSession, signIn } from "next-auth/react";
import rough from "roughjs";
import { ProGated } from "@/app/components/ProGated";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

// ─── Types ────────────────────────────────────────────────────────────────────

type CameraKeyframe = {
  time: number;
  cameraX: number;
  cameraY: number;
  boardZoom: number;
  easing?: 'linear' | 'ease-in-out'; // applied when interpolating TO this keyframe
};

type Clip = {
  id: string;
  type: "image" | "video" | "pan" | "narration";
  name: string;
  sourceUrl: string;
  startTime: number;
  duration: number;
  layer?: number;    // 0-4 for visual clips, undefined for narration. Default: 1
  volume?: number;   // 0-1, default 1. Applies to video and narration clips
  muted?: boolean;   // explicit mute (overrides volume). Default: false
  boardX?: number;
  boardY?: number;
  boardW?: number;
  boardH?: number;
  holdFraction?: number;
  sourceDurationSec?: number; // natural duration of the video blob (for ambient loop modulo)
  thumbnailBlobUrl?: string;  // URL.createObjectURL of the captured first frame (video clips)
  sourceBlob?: Blob;          // the actual video Blob backing sourceUrl (video clips only) — cloned
                               // per-instance on paste/duplicate so each <video> element gets its
                               // own independent blob instead of sharing one decoder-limited URL
  // narration-only:
  audioBlob?: Blob;
  waveform?: number[];
  // youtube save/restore:
  youtubeId?: string;
  ytStart?: number;
  ytEnd?: number;
  needsRedownload?: boolean;
};

type Annotation = {
  id: string;
  type: "text" | "arrow" | "circle" | "highlight" | "pen" | "emoji";
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  color: string;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: "normal" | "bold";
  strokeWidth?: number;
  arrowStartX?: number;
  arrowStartY?: number;
  arrowEndX?: number;
  arrowEndY?: number;
  highlightStyle?: "rect" | "underline" | "curlyBrace";
  points?: Array<{ x: number; y: number }>;  // pen
  emoji?: string;                              // emoji
};

type AnnotationTool = "pointer" | "text" | "arrow" | "circle" | "highlight" | "pen" | "emoji";

type CharacterAction = {
  id: string;
  type: "walkTo" | "jumpTo" | "flip" | "zipline" | "wallClimb" | "grapple"
      | "pointAt" | "sitAndWatch" | "explainGesture" | "emote" | "idle";
  startTime: number;
  duration: number;
  targetX?: number;
  targetY?: number;
  targetClipId?: string;  // AI-choreographed actions target a clip id instead of raw coords — resolved
                           // to boardX/Y lazily in resolveCharActions so a clip move never staleifies it.
                           // Explicit targetX/Y (set by manual placement) always takes precedence.
  emoji?: string;
  startX?: number;        // explicit start-position override (entrance/exit flips start offscreen, not chained)
  startY?: number;
  entranceFlip?: boolean; // marks the auto-derived flip onto the first media clip — used to hide the
                           // character before this action starts (see characterEntranceTime)
  aiGenerated?: boolean;  // produced by /api/board2/character-choreography — shown with a ✨ badge and
                           // removable in bulk via "Clear AI choreography", otherwise a normal manual action
};

type ResolvedCharAction = CharacterAction & { fromX: number; fromY: number };

type CharTimelineDrag = {
  kind: "move" | "resize-left" | "resize-right";
  actionId: string;
  origStartTime: number;
  origDuration: number;
  cursorOffsetSec: number;
};

type MediaItem = {
  id: string;
  name: string;
  type: "image" | "video";
  url: string;
  duration?: number;
  blob?: Blob; // video only — source for cloning a fresh blob when placed on the board
};

type TimelineDrag = {
  kind: "move" | "resize-left" | "resize-right";
  clipId: string;
  origStartTime: number;
  origDuration: number;
  origLayer: number;
  cursorOffsetSec: number;
};

type BoardMarquee = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
} | null;

type TimelineMarquee = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
} | null;

type YtSearchResult = {
  id: string;
  title: string;
  channel: string;
  duration: string | number;
  thumbnail: string;
  // Set when this selection originated from a Neural Search placeholder click, so
  // handleYtConfirm knows to reuse the placeholder's board position and remove it on success.
  placeholderId?: string;
  boardX?: number;
  boardY?: number;
};
type YtModalView = "search" | "trim";
type YtTab = "paste" | "search";

type DownloadToast = { id: string; title: string; status: "downloading" | "done" | "error"; error?: string };

// Neural Search: a not-yet-downloaded YouTube candidate placed on the board as a clickable
// thumbnail. Lives outside `clips` — no timeline presence, ignored by camera keyframes/export.
type NeuralPlaceholder = {
  id: string;
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  videoId: string;
  title: string;
  channel: string;
  thumbnailUrl: string;
  viewCount: number;
  durationSec: number;
};

// Neural Search: a not-yet-downloaded Google Image candidate placed on the board as a
// clickable thumbnail. Lives outside `clips` — no timeline presence, ignored by camera
// keyframes/export, same as NeuralPlaceholder.
type ImagePlaceholder = {
  id: string;
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  imageUrl: string;
  title: string;
  sourceUrl: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const CANVAS_W_LAND = 1920;
const CANVAS_H_LAND = 1080;
const BOARD_W = 4000;
const BOARD_H = 3000;
const VIEWPORT_W = 800;
const VIEWPORT_H = 600;
const BOARD_CLIP_PAD = 30;
const BOARD_EDGE_MARGIN = 200;
const DEFAULT_PX_PER_SEC = 100;
const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 500;
const RULER_H = 28;
const N_LAYERS = 5;
const LAYER_H = 22;
const TRACK_H = N_LAYERS * LAYER_H; // 110
const TIMELINE_H = 370;
const NARRATION_TRACK_H = 44;
const NARRATION_COLOR = "#ffd6e8";
const HANDLE_W = 6;
const BOARD_RESIZE_PX = 10;
const EMOJI_SET = ["🤔","⭐","🎯","❗","💡","🔥","✨","📈","📉","⚠️","❓","💬","👀","🚀","❤️","✅","❌","🌍","🧠","🎨","🏆","💎","🔑","📌","🎬","📊","💰","🔍","🤝","🌟","💥","🎤","📣","🌈","⏰","🎁","😂"];
const MAGNETIC_SNAP_PX = 10;
const CLIP_COLORS = ["#c8f135", "#5ec4ff", "#ff9f5e", "#d4a8ff", "#ff6b9d", "#7df5b0"];
const PAN_CLIP_COLOR = "#f0e6a8";
const HOLD_FRACTION = 0.6;
const FRAME_ALL_PADDING = 0.1;
const CLIP_FOCUS_RATIO = 0.7;
const EXPORT_FPS = 60;
const PREVIEW_H_PX = 135;
const CHARACTER_TRACK_H = 36;
const CHARACTER_COLOR = "#cdeac0";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 0;
function generateId(): string {
  return `b2_${Date.now()}_${++_idCounter}`;
}

function mimeToExt(mime: string, fallbackName: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
    "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/wav": "wav", "audio/wave": "wav", "audio/mpeg": "mp3",
    "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/webm": "webm",
  };
  if (map[mime]) return map[mime];
  const m = fallbackName.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "bin";
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function shadeColor(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `#${clamp(Math.round(r * factor), 0, 255).toString(16).padStart(2, "0")}${clamp(Math.round(g * factor), 0, 255).toString(16).padStart(2, "0")}${clamp(Math.round(b * factor), 0, 255).toString(16).padStart(2, "0")}`;
}

function getVideoMeta(url: string): Promise<{ duration: number; w: number; h: number }> {
  return new Promise((resolve) => {
    const vid = document.createElement("video");
    vid.preload = "metadata";
    vid.onloadedmetadata = () => {
      const duration = isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 5;
      const w = vid.videoWidth || 0;
      const h = vid.videoHeight || 0;
      vid.src = "";
      resolve({ duration, w, h });
    };
    vid.onerror = () => resolve({ duration: 5, w: 0, h: 0 });
    vid.src = url;
  });
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function interpolateCameraKeyframes(
  kfs: CameraKeyframe[],
  time: number
): { cameraX: number; cameraY: number; boardZoom: number } {
  if (kfs.length === 0) return { cameraX: BOARD_W / 2, cameraY: BOARD_H / 2, boardZoom: 1 };
  const sorted = [...kfs].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) {
    const { cameraX, cameraY, boardZoom } = sorted[0];
    return { cameraX, cameraY, boardZoom };
  }
  if (time >= sorted[sorted.length - 1].time) {
    const last = sorted[sorted.length - 1];
    return { cameraX: last.cameraX, cameraY: last.cameraY, boardZoom: last.boardZoom };
  }
  let lo = 0;
  while (lo < sorted.length - 2 && sorted[lo + 1].time <= time) lo++;
  const a = sorted[lo];
  const b = sorted[lo + 1];
  const rawT = (time - a.time) / (b.time - a.time);
  const t = b.easing === 'linear' ? rawT : easeInOutCubic(rawT);
  return {
    cameraX: lerp(a.cameraX, b.cameraX, t),
    cameraY: lerp(a.cameraY, b.cameraY, t),
    boardZoom: lerp(a.boardZoom, b.boardZoom, t),
  };
}

function magneticSnap(
  t: number,
  candidates: number[],
  threshold: number
): { snapped: number; target: number | null } {
  let best: number | null = null;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = Math.abs(t - c);
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return { snapped: best ?? t, target: best };
}

function allClipEdges(clips: Clip[], excludeId: string): number[] {
  const edges: number[] = [];
  for (const c of clips) {
    if (c.id === excludeId) continue;
    edges.push(c.startTime, c.startTime + c.duration);
  }
  return edges;
}

function layerOverlap(clips: Clip[], start: number, duration: number, excludeId: string, layer: number): boolean {
  return clips.some(
    (c) => c.id !== excludeId && (c.layer ?? 1) === layer && c.type !== "narration" &&
      start < c.startTime + c.duration && start + duration > c.startTime
  );
}

function freeLayerAtTime(clips: Clip[], start: number, duration: number, excludeId: string, preferLayer: number): number {
  for (let l = preferLayer; l < N_LAYERS; l++) {
    if (!layerOverlap(clips, start, duration, excludeId, l)) return l;
  }
  for (let l = 0; l < preferLayer; l++) {
    if (!layerOverlap(clips, start, duration, excludeId, l)) return l;
  }
  return preferLayer;
}

function endOfLayer(clips: Clip[], layer: number, excludeId: string): number {
  return clips
    .filter((c) => c.id !== excludeId && (c.layer ?? 1) === layer && c.type !== "narration")
    .reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
}

function findFreeBoardPos(
  existing: Array<{ boardX?: number; boardY?: number; boardW?: number; boardH?: number }>,
  clipW: number,
  clipH: number,
  camX: number = BOARD_W / 2,
  camY: number = BOARD_H / 2
): { boardX: number; boardY: number } {
  const visuals = existing.filter((c) => c.boardX !== undefined);
  const overlaps = (bx: number, by: number, pad: number) =>
    visuals.some(
      (c) =>
        !(
          bx + clipW + pad < c.boardX! ||
          bx > c.boardX! + c.boardW! + pad ||
          by + clipH + pad < c.boardY! ||
          by > c.boardY! + c.boardH! + pad
        )
    );
  const candidate = (rx: number, ry: number) => ({
    boardX: clamp(camX - clipW / 2 + rx, 0, BOARD_W - clipW),
    boardY: clamp(camY - clipH / 2 + ry, 0, BOARD_H - clipH),
  });
  // Phase 1: near camera with padding
  for (let i = 0; i < 50; i++) {
    const { boardX: bx, boardY: by } = candidate(
      (Math.random() - 0.5) * VIEWPORT_W,
      (Math.random() - 0.5) * VIEWPORT_H
    );
    if (!overlaps(bx, by, BOARD_CLIP_PAD)) return { boardX: bx, boardY: by };
  }
  // Phase 2: near camera, no padding
  for (let i = 0; i < 50; i++) {
    const { boardX: bx, boardY: by } = candidate(
      (Math.random() - 0.5) * VIEWPORT_W,
      (Math.random() - 0.5) * VIEWPORT_H
    );
    if (!overlaps(bx, by, 0)) return { boardX: bx, boardY: by };
  }
  // Phase 3: 2× radius, no padding
  for (let i = 0; i < 50; i++) {
    const { boardX: bx, boardY: by } = candidate(
      (Math.random() - 0.5) * VIEWPORT_W * 2,
      (Math.random() - 0.5) * VIEWPORT_H * 2
    );
    if (!overlaps(bx, by, 0)) return { boardX: bx, boardY: by };
  }
  // Phase 4: anywhere on board
  for (let i = 0; i < 50; i++) {
    const bx = BOARD_EDGE_MARGIN + Math.random() * (BOARD_W - BOARD_EDGE_MARGIN * 2 - clipW);
    const by = BOARD_EDGE_MARGIN + Math.random() * (BOARD_H - BOARD_EDGE_MARGIN * 2 - clipH);
    if (!overlaps(bx, by, 0)) return { boardX: bx, boardY: by };
  }
  const last = visuals.at(-1);
  if (last)
    return {
      boardX: Math.min(last.boardX! + 20, BOARD_W - clipW),
      boardY: Math.min(last.boardY! + 20, BOARD_H - clipH),
    };
  return {
    boardX: clamp(camX - clipW / 2, 0, BOARD_W - clipW),
    boardY: clamp(camY - clipH / 2, 0, BOARD_H - clipH),
  };
}

function parseDurationSec(d: string | number | undefined): number {
  if (typeof d === "number") return isFinite(d) ? d : 0;
  if (!d) return 0;
  const parts = d.split(":").map(Number);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  return parseFloat(d) || 0;
}

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatViewCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K views`;
  if (n > 0) return `${n} views`;
  return "";
}

function parseTimestampSec(s: string): number | null {
  const parts = s.split(":").map((p) => parseFloat(p.trim()));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return parts[0] * 60 + parts[1];
  if (parts.length === 1 && !isNaN(parts[0]) && parts[0] >= 0) return parts[0];
  return null;
}

function extractYouTubeId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ─── Annotation canvas helpers ────────────────────────────────────────────────

function drawCurlyBrace(
  ctx: CanvasRenderingContext2D,
  x: number, y1: number, y2: number,
  color: string, sw: number
) {
  const h = y2 - y1;
  const mid = (y1 + y2) / 2;
  const q = Math.max(8, Math.min(30, h * 0.15));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = sw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x, y1);
  ctx.bezierCurveTo(x + q, y1, x + q, mid - h * 0.05, x, mid);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, mid);
  ctx.bezierCurveTo(x + q, mid + h * 0.05, x + q, y2, x, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, mid);
  ctx.lineTo(x + q * 1.5, mid);
  ctx.stroke();
  ctx.restore();
}

function drawAnnotationsToCanvas(
  ctx: CanvasRenderingContext2D,
  annotations: Annotation[],
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  sf: number,
  W: number,
  H: number
) {
  const rc = rough.canvas(ctx.canvas);
  const toSX = (bx: number) => (bx - cam.cameraX) * sf + W / 2;
  const toSY = (by: number) => (by - cam.cameraY) * sf + H / 2;
  for (const ann of annotations) {
    const sw = Math.max(1, (ann.strokeWidth ?? 3) * sf);
    const roughSeed = ann.id.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0) & 0xffff;
    const roughOpts = { stroke: ann.color, strokeWidth: sw, roughness: 1.4, bowing: 1.2, seed: roughSeed };
    if (ann.type === "text" && ann.text) {
      const fs = Math.max(8, (ann.fontSize ?? 80) * sf);
      ctx.save();
      ctx.font = `${ann.fontWeight ?? "normal"} ${fs}px '${ann.fontFamily ?? "Caveat"}', cursive`;
      ctx.fillStyle = ann.color;
      ctx.textBaseline = "top";
      ctx.fillText(ann.text, toSX(ann.boardX), toSY(ann.boardY));
      ctx.restore();
    } else if (ann.type === "arrow" && ann.arrowStartX !== undefined) {
      const ax = toSX(ann.arrowStartX), ay = toSY(ann.arrowStartY!);
      const ex = toSX(ann.arrowEndX!), ey = toSY(ann.arrowEndY!);
      rc.line(ax, ay, ex, ey, roughOpts);
      const angle = Math.atan2(ey - ay, ex - ax);
      const hl = Math.max(12, sw * 5);
      rc.line(ex, ey, ex - hl * Math.cos(angle - Math.PI / 6), ey - hl * Math.sin(angle - Math.PI / 6), roughOpts);
      rc.line(ex, ey, ex - hl * Math.cos(angle + Math.PI / 6), ey - hl * Math.sin(angle + Math.PI / 6), roughOpts);
    } else if (ann.type === "circle") {
      rc.ellipse(
        toSX(ann.boardX) + ann.boardW * sf / 2,
        toSY(ann.boardY) + ann.boardH * sf / 2,
        ann.boardW * sf, ann.boardH * sf,
        { ...roughOpts, fill: "none" }
      );
    } else if (ann.type === "highlight") {
      const sx = toSX(ann.boardX), sy = toSY(ann.boardY);
      const bw = ann.boardW * sf, bh = ann.boardH * sf;
      const style = ann.highlightStyle ?? "rect";
      if (style === "rect") {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = ann.color;
        ctx.fillRect(sx, sy, bw, bh);
        ctx.globalAlpha = 1;
        ctx.restore();
      } else if (style === "underline") {
        rc.line(sx, sy + bh, sx + bw, sy + bh, roughOpts);
      } else {
        drawCurlyBrace(ctx, sx + bw, sy, sy + bh, ann.color, sw);
      }
    } else if (ann.type === "pen" && ann.points && ann.points.length >= 2) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(toSX(ann.points[0].x), toSY(ann.points[0].y));
      for (let i = 1; i < ann.points.length; i++) {
        ctx.lineTo(toSX(ann.points[i].x), toSY(ann.points[i].y));
      }
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = Math.max(1, (ann.strokeWidth ?? 4) * sf);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    } else if (ann.type === "emoji" && ann.emoji) {
      const fs = Math.max(8, (ann.fontSize ?? 120) * sf);
      ctx.save();
      ctx.font = `${fs}px serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(ann.emoji, toSX(ann.boardX + ann.boardW / 2), toSY(ann.boardY + ann.boardH / 2));
      ctx.restore();
    }
  }
}

// ─── Character — module-level helpers ────────────────────────────────────────

// Distance thresholds for auto-mode travel type selection
const CHAR_WALK_DIST = 500;   // board px — below this: walkTo
const CHAR_JUMP_DIST = 1500;  // board px — below this: jumpTo; above: grapple
const CHAR_POINT_BEAT = 1.5;  // seconds of pointing per clip hold

// Travel-type action kinds — these change the character's resting board position
const CHAR_TRAVEL_TYPES = new Set<CharacterAction["type"]>(["walkTo", "jumpTo", "flip", "zipline", "wallClimb", "grapple"]);

// Deterministic pseudo-random in [0,1) seeded by a string (clip.id) — same seed always
// yields the same value, so regenerating the auto-choreography doesn't reshuffle emotes.
function seededRandom(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
  return ((h >>> 0) % 100000) / 100000;
}

function getCharInitPos(clips: { boardX?: number; boardY?: number; boardW?: number; boardH?: number }[]): { x: number; y: number } {
  const placed = clips.filter((c) => c.boardX !== undefined);
  if (placed.length === 0) return { x: BOARD_W / 2, y: BOARD_H * 0.75 };
  const minX = Math.min(...placed.map((c) => c.boardX!));
  const maxX = Math.max(...placed.map((c) => c.boardX! + (c.boardW ?? 0)));
  const maxY = Math.max(...placed.map((c) => c.boardY! + (c.boardH ?? 0)));
  return { x: (minX + maxX) / 2, y: maxY + 80 };
}

// Snap a desired Y position to the nearest clip top edge at x, if any clip spans that x.
// Returns the clip's boardY (feet land on the top surface). Falls back to desiredY if no clip.
function resolveGroundY(
  x: number,
  desiredY: number,
  clips: { boardX?: number; boardY?: number; boardW?: number; boardH?: number; type?: string }[]
): number {
  const PAD = 40; // don't stand on the extreme corners of an image
  const candidates = clips.filter((c) =>
    c.boardX !== undefined && c.boardY !== undefined && c.boardW !== undefined &&
    (c.type === "image" || c.type === "video") &&
    x >= c.boardX! + PAD && x <= c.boardX! + (c.boardW ?? 0) - PAD &&
    c.boardY! <= desiredY  // top edge must be at or above the target point
  );
  if (candidates.length === 0) return desiredY;
  // When clips overlap horizontally (stacked images), stand on the topmost one (smallest boardY).
  // Among all candidates whose top edge is <= desiredY, pick the one with the LARGEST boardY
  // (highest top edge, closest to desiredY from above).
  return Math.max(...candidates.map((c) => c.boardY!));
}

// Snap a board position to the top surface of the clip under x (for action placement).
function snapToClipTop(
  tx: number, ty: number,
  clips: { boardX?: number; boardY?: number; boardW?: number; boardH?: number; type?: string }[]
): { x: number; y: number } {
  const PAD = 40;
  const candidates = clips.filter((c) =>
    c.boardX !== undefined && c.boardY !== undefined && c.boardW !== undefined && c.boardH !== undefined &&
    (c.type === "image" || c.type === "video") &&
    tx >= c.boardX! && tx <= c.boardX! + (c.boardW ?? 0)
  );
  if (candidates.length === 0) return { x: tx, y: ty };
  // Pick topmost clip whose body contains the click point (boardY <= ty <= boardY + boardH)
  const hit = candidates
    .filter((c) => ty >= c.boardY! && ty <= c.boardY! + (c.boardH ?? 0))
    .sort((a, b) => a.boardY! - b.boardY!)[0];  // topmost
  if (hit) {
    // Clamp x to the inner span (not on extreme edges)
    const cx = Math.max(hit.boardX! + PAD, Math.min(hit.boardX! + (hit.boardW ?? 0) - PAD, tx));
    return { x: cx, y: hit.boardY! };
  }
  return { x: tx, y: ty };
}

// Resolve an action's targetClipId to board coordinates, using the clip's CURRENT position —
// called fresh every resolveCharActions pass so a clip move is reflected on the very next render,
// never stale. pointAt targets a point inside the clip (to point AT something); every other
// targeted type targets the clip's top surface (a place to stand).
function resolveClipTarget(
  action: CharacterAction,
  clips: { id: string; boardX?: number; boardY?: number; boardW?: number; boardH?: number }[]
): { x: number; y: number } | undefined {
  if (!action.targetClipId) return undefined;
  const c = clips.find((cl) => cl.id === action.targetClipId);
  if (!c || c.boardX === undefined || c.boardY === undefined) return undefined;
  const cx = c.boardX + (c.boardW ?? 0) / 2;
  if (action.type === "pointAt") return { x: cx, y: c.boardY + (c.boardH ?? 0) * 0.35 };
  return { x: cx, y: c.boardY };
}

// Resolve fromX/fromY for each action (position continuity pass).
// Handles both manual and auto-derived actions merged in time order.
function resolveCharActions(
  actions: CharacterAction[],
  initX: number,
  initY: number,
  clips: { id: string; boardX?: number; boardY?: number; boardW?: number; boardH?: number }[]
): ResolvedCharAction[] {
  const sorted = [...actions].sort((a, b) => a.startTime - b.startTime);
  let x = initX, y = initY;
  const result: ResolvedCharAction[] = [];
  for (const a of sorted) {
    // Explicit targetX/Y (manual placement) always wins; otherwise resolve targetClipId against
    // the clip's current position (AI-choreographed actions).
    const resolvedTarget = resolveClipTarget(a, clips);
    const targetX = a.targetX ?? resolvedTarget?.x;
    const targetY = a.targetY ?? resolvedTarget?.y;
    // startX/startY (entrance/exit flips) override the chained position for this action only —
    // the chain continues from targetX/targetY afterward, same as any other travel action.
    result.push({ ...a, targetX, targetY, fromX: a.startX ?? x, fromY: a.startY ?? y });
    if (CHAR_TRAVEL_TYPES.has(a.type) && targetX !== undefined) {
      x = targetX; y = targetY ?? y;
    }
    // pointAt/sitAndWatch/explainGesture/emote/idle don't change position
  }
  return result;
}

// Merge auto-derived actions with manual overrides:
// manual actions take priority — any derived action overlapping a manual one is suppressed.
function mergeCharActions(derived: CharacterAction[], manual: CharacterAction[]): CharacterAction[] {
  return [
    ...derived.filter((d) => !manual.some((m) =>
      d.startTime < m.startTime + m.duration && d.startTime + d.duration > m.startTime
    )),
    ...manual,
  ].sort((a, b) => a.startTime - b.startTime);
}

// Derive character actions automatically from the clip timeline (auto-follow mode).
// Recomputed fresh every call — callers should memoize on [clips] so a clip reorder, add/delete,
// holdFraction change, or board-position move always produces an up-to-date plan (no stored/stale
// derived actions).
//
// Pan clips never carry the character: if a pan comes before he's entered, he simply isn't rendered
// yet (see entranceFlip / characterEntranceTime in the component); if a pan falls mid-timeline, he
// idles in place on whatever clip he last landed on and resumes once the pan ends.
function deriveAutoCharActions(
  clips: Clip[],
  initX: number,
  initY: number
): CharacterAction[] {
  const focusClips = clips
    .filter((c) => c.type !== "narration" && (c.type === "pan" || c.boardX !== undefined))
    .sort((a, b) => a.startTime - b.startTime);
  if (focusClips.length === 0) return [];

  const actions: CharacterAction[] = [];
  let curX = initX, curY = initY;
  let prev: Clip | null = null;
  let hasEntered = false;
  const OFFSCREEN_PAD = 900; // heuristic — this pure fn has no canvas W/H, so "offscreen" is a generous fixed offset

  for (const clip of focusClips) {
    const hf = clip.holdFraction ?? HOLD_FRACTION;
    const holdStart = clip.startTime;
    const holdEnd = clip.startTime + clip.duration * hf;
    const transEnd = clip.startTime + clip.duration;
    const isPan = clip.type === "pan";

    if (isPan) {
      // Character is either not on yet (handled by characterEntranceTime hiding him) or idling in
      // place on his last landing spot — no action, no position change, just skip past it.
      prev = clip;
      continue;
    }

    // Where the character needs to be standing when the camera finishes settling on this clip
    const arriveX = clip.boardX! + (clip.boardW ?? 0) / 2;
    const arriveY = clip.boardY!;

    // Travel is timed to the camera's OWN transition window so he arrives exactly when it settles:
    // the camera moves from the previous clip's stop during [prevHoldEnd, prevTransEnd] (see
    // generateCameraKeyframes) — mirror that window here rather than a fixed travel duration. The
    // entrance flip onto the first media clip follows the same rule using the preceding pan's window
    // (if any); with nothing preceding it at all, it starts at t=0 and lands at holdStart.
    let travelStart: number, travelEnd: number;
    if (!prev) {
      travelStart = 0;
      travelEnd = Math.max(travelStart + 0.15, holdStart);
    } else {
      const prevHf = prev.holdFraction ?? HOLD_FRACTION;
      travelStart = prev.startTime + prev.duration * prevHf;
      travelEnd = Math.max(travelStart + 0.15, prev.startTime + prev.duration);
    }

    if (!hasEntered) {
      // Entrance: flip in from offscreen-left, landing exactly as the camera settles into the hold.
      actions.push({
        id: `auto_${clip.id}_mv`,
        type: "flip",
        startTime: travelStart,
        duration: travelEnd - travelStart,
        targetX: arriveX, targetY: arriveY,
        startX: arriveX - OFFSCREEN_PAD, startY: arriveY,
        entranceFlip: true,
      });
      hasEntered = true;
    } else {
      const dx = arriveX - curX, dy = arriveY - curY;
      const dist = Math.hypot(dx, dy);
      if (dist > 20 && travelEnd - travelStart > 0.1) {
        let moveType: CharacterAction["type"];
        if (dy > 300 && Math.abs(dx) > 150) moveType = "zipline";     // big drop — slide down a line
        else if (dy < -300 && dist < CHAR_JUMP_DIST * 1.3) moveType = "wallClimb"; // big climb, short reach
        else if (dist < CHAR_WALK_DIST) moveType = "walkTo";
        else if (dist < CHAR_JUMP_DIST) moveType = "jumpTo";
        else moveType = "grapple";

        actions.push({
          id: `auto_${clip.id}_mv`,
          type: moveType,
          startTime: travelStart,
          duration: travelEnd - travelStart,
          targetX: arriveX, targetY: arriveY,
        });
      }
    }

    // Hold behavior: pointAt beat, then sitAndWatch (video) / explainGesture (long holds) for the rest
    const holdDur = clip.duration * hf;
    const pointDur = Math.min(CHAR_POINT_BEAT, holdDur - 0.1);
    if (pointDur > 0.2) {
      actions.push({
        id: `auto_${clip.id}_pt`,
        type: "pointAt",
        startTime: holdStart,
        duration: pointDur,
        targetX: clip.boardX! + (clip.boardW ?? 0) / 2,
        targetY: clip.boardY! + (clip.boardH ?? 0) * 0.35,
      });
      const restStart = holdStart + pointDur;
      const restDur = holdEnd - restStart;
      if (restDur > 0.6) {
        if (clip.type === "video") {
          actions.push({ id: `auto_${clip.id}_watch`, type: "sitAndWatch", startTime: restStart, duration: restDur, targetX: arriveX, targetY: arriveY });
        } else {
          // Any image hold with meaningful time left after the point beat gets talking gestures —
          // previously gated on holdDur > 4s, which almost no image clip hit, so idle silently won.
          actions.push({ id: `auto_${clip.id}_gest`, type: "explainGesture", startTime: restStart, duration: restDur, targetX: arriveX, targetY: arriveY });
        }
      }
    }

    // Auto emotes — deterministic per clip.id so regenerating the plan never reshuffles them.
    // Max one per hold.
    if (clip.type === "video") {
      if (holdDur > 1.5 && seededRandom(clip.id + ":emoteVideo") < 0.3) {
        const vidStart = holdStart + holdDur * (0.3 + seededRandom(clip.id + ":emoteVideoPos") * 0.4);
        const emoji = seededRandom(clip.id + ":emoteVideoChoice") < 0.5 ? "😂" : "👀";
        if (vidStart + 1.5 < transEnd) actions.push({ id: `auto_${clip.id}_emote`, type: "emote", startTime: vidStart, duration: 1.5, emoji });
      }
    } else if (pointDur > 0.2 && seededRandom(clip.id + ":emoteArrive") < 0.3) {
      const emoji = seededRandom(clip.id + ":emoteChoice") < 0.5 ? "💡" : "❗";
      const emoteStart = holdStart + pointDur + 0.3;
      if (emoteStart + 1.5 < transEnd) actions.push({ id: `auto_${clip.id}_emote`, type: "emote", startTime: emoteStart, duration: 1.5, emoji });
    } else if (holdDur > 4 && seededRandom(clip.id + ":emoteMid") < 0.35) {
      const midStart = holdStart + holdDur * 0.5;
      if (midStart + 1.5 < transEnd) actions.push({ id: `auto_${clip.id}_emote`, type: "emote", startTime: midStart, duration: 1.5, emoji: "🤔" });
    }

    curX = arriveX; curY = arriveY;
    prev = clip;
  }

  // Exit: flip offscreen after the last clip's transition ends. Skipped entirely if he never
  // entered (e.g. the timeline is pan-only — nothing to exit from).
  if (prev && hasEntered) {
    const lastTransEnd = prev.startTime + prev.duration;
    const dir = curX >= initX ? 1 : -1;
    actions.push({
      id: `auto_exit`,
      type: "flip",
      startTime: lastTransEnd,
      duration: 1.0,
      targetX: curX + OFFSCREEN_PAD * dir,
      targetY: curY,
    });
  }

  return actions;
}

type CharPoseResult = {
  boardX: number; boardY: number;
  facing: 1 | -1;
  headBob: number;
  bodyLean: number;
  spinAngle?: number; // full-body rotation around the torso center (flip only) — separate from bodyLean's upper-body-only lean
  leftLegA: number; rightLegA: number;
  leftArmA: number; rightArmA: number;
  leftForeA: number; rightForeA: number;
  airY: number;
  emojiText?: string;
  emojiAlpha?: number;
  pointTargetBX?: number;
  pointTargetBY?: number;
  grappleAnchorBX?: number;
  grappleAnchorBY?: number;
  grappleRopeAlpha?: number;
};

function evalCharAtTime(
  time: number,
  resolved: ResolvedCharAction[],
  initX: number,
  initY: number,
  clips: { boardX?: number; boardY?: number; boardW?: number; boardH?: number; type?: string }[]
): CharPoseResult {
  // Standing/idle pose — angles measured from vertical-down, positive = outward from body midline.
  // Legs +0.12/-0.12 (feet slightly apart), upper arms +0.08/-0.08 (hanging at sides), forearms
  // continue the same line with +0.05 additional bend. Body lean 0, no rotation. The idle bob below
  // is a headBob/breathing offset ONLY — it never touches arm/leg angles.
  const idlePose = (rx: number, ry: number): CharPoseResult => {
    const t = time * 2;
    return {
      boardX: rx, boardY: ry, facing: 1,
      headBob: Math.sin(t) * 2, bodyLean: 0,
      leftLegA: 0.12, rightLegA: -0.12,
      leftArmA: 0.08, rightArmA: -0.08,
      leftForeA: 0.13, rightForeA: -0.13,
      airY: 0,
    };
  };

  const active = resolved.find((a) => time >= a.startTime && time < a.startTime + a.duration);

  if (!active) {
    let rx = initX, ry = initY;
    let lastEnd = -1;
    for (const a of resolved) {
      const end = a.startTime + a.duration;
      if (end <= time && end > lastEnd) {
        lastEnd = end;
        if (CHAR_TRAVEL_TYPES.has(a.type) && a.targetX !== undefined) {
          rx = a.targetX; ry = a.targetY ?? ry;
        } else {
          rx = a.fromX; ry = a.fromY;
        }
      }
    }
    return idlePose(rx, ry);
  }

  const progress = Math.max(0, Math.min(1, (time - active.startTime) / active.duration));

  if (active.type === "walkTo") {
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const bx = active.fromX + (tx - active.fromX) * progress;
    // Ground-resolve the feet Y along the path so he steps UP onto clip surfaces
    const rawBy = active.fromY + (ty - active.fromY) * progress;
    const by = resolveGroundY(bx, rawBy, clips);
    const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
    const dist = Math.hypot(tx - active.fromX, ty - active.fromY);
    const stepFreq = Math.max(4, dist * 0.015);
    const phase = progress * stepFreq * Math.PI * 2;
    const swing = 0.5;
    return {
      boardX: bx, boardY: by, facing,
      headBob: Math.sin(phase * 2) * 2, bodyLean: Math.sin(phase) * 0.05,
      leftLegA: Math.sin(phase) * swing, rightLegA: Math.sin(phase + Math.PI) * swing,
      leftArmA: Math.sin(phase + Math.PI) * 0.35, rightArmA: Math.sin(phase) * 0.35,
      leftForeA: Math.sin(phase + Math.PI) * 0.15, rightForeA: Math.sin(phase) * 0.15,
      airY: 0,
    };
  }

  if (active.type === "jumpTo") {
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const bx = active.fromX + (tx - active.fromX) * progress;
    const by = active.fromY + (ty - active.fromY) * progress;
    const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
    const airY = -150 * 4 * progress * (1 - progress);

    // Three-phase jump: takeoff / mid-air / landing — limbs never collapse toward center
    let leftLegA: number, rightLegA: number, leftArmA: number, rightArmA: number;
    let leftForeA = 0, rightForeA = 0, headBob = 0;

    if (progress < 0.15) {
      // Takeoff crouch: legs push off (spread slightly), arms swing back
      const t = progress / 0.15;
      leftLegA  = lerp(0,    0.3,  t);
      rightLegA = lerp(0,   -0.3,  t);
      leftArmA  = lerp(0.15,-0.45, t);
      rightArmA = lerp(-0.15,-0.45, t);
    } else if (progress < 0.75) {
      // Mid-air: both legs trail back (symmetric tuck), both arms raised forward for balance
      const t = (progress - 0.15) / 0.6;
      leftLegA  = lerp(0.3, -0.55, t);
      rightLegA = lerp(-0.3,-0.45, t);
      leftForeA  = lerp(0, -0.3, t);
      rightForeA = lerp(0, -0.3, t);
      leftArmA  = lerp(-0.45, -0.5, t);
      rightArmA = lerp(-0.45, -0.5, t);
      headBob   = -Math.sin(Math.PI * t) * 4;
    } else {
      // Landing: legs extend down ahead, arms splay for balance, then settle
      const t = (progress - 0.75) / 0.25;
      leftLegA  = lerp(-0.55, 0.25, t);
      rightLegA = lerp(-0.45, 0.15, t);
      leftArmA  = lerp(-0.5,  0.4,  t);
      rightArmA = lerp(-0.5, -0.4,  t);
      leftForeA  = lerp(-0.3, 0, t);
      rightForeA = lerp(-0.3, 0, t);
    }

    return {
      boardX: bx, boardY: by, facing,
      headBob, bodyLean: 0,
      leftLegA, rightLegA, leftArmA, rightArmA, leftForeA, rightForeA,
      airY,
    };
  }

  if (active.type === "grapple") {
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
    // Anchor point: above and between start+end, biased toward destination
    const anchorBX = active.fromX + (tx - active.fromX) * 0.55;
    const anchorBY = Math.min(active.fromY, ty) - 380;

    if (progress < 0.15) {
      // Aim + fire: arms raise toward anchor, rope extends
      const t = progress / 0.15;
      return {
        boardX: active.fromX, boardY: active.fromY, facing,
        headBob: 0, bodyLean: 0,
        leftLegA: 0.1, rightLegA: -0.1,
        leftArmA: lerp(0.15, -1.1, t), rightArmA: lerp(-0.15, -1.1, t),
        leftForeA: lerp(0.2, -0.25, t), rightForeA: lerp(-0.2, -0.25, t),
        airY: 0,
        grappleAnchorBX: anchorBX, grappleAnchorBY: anchorBY,
        grappleRopeAlpha: t,
      };
    } else if (progress < 0.85) {
      // Swing: pendulum bezier arc from start to end dipping below anchor
      const t = (progress - 0.15) / 0.7;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      // Bezier control point sags downward mid-swing
      const ctrlBX = (active.fromX + tx) / 2;
      const ctrlBY = Math.max(active.fromY, ty) + 180;
      const bx = (1-eased)*(1-eased)*active.fromX + 2*(1-eased)*eased*ctrlBX + eased*eased*tx;
      const by = (1-eased)*(1-eased)*active.fromY + 2*(1-eased)*eased*ctrlBY + eased*eased*ty;
      return {
        boardX: bx, boardY: by, facing,
        headBob: -3, bodyLean: 0,
        leftLegA: -0.45, rightLegA: -0.35,
        leftArmA: -1.1, rightArmA: -1.1,
        leftForeA: -0.25, rightForeA: -0.25,
        airY: 0,
        grappleAnchorBX: anchorBX, grappleAnchorBY: anchorBY,
        grappleRopeAlpha: 1,
      };
    } else {
      // Release + land
      const t = (progress - 0.85) / 0.15;
      return {
        boardX: tx, boardY: ty, facing,
        headBob: 0, bodyLean: 0,
        leftLegA: lerp(-0.45, 0.2, t), rightLegA: lerp(-0.35, 0.15, t),
        leftArmA: lerp(-1.1, 0.3, t), rightArmA: lerp(-1.1, -0.3, t),
        leftForeA: 0, rightForeA: 0,
        airY: 0,
        grappleAnchorBX: anchorBX, grappleAnchorBY: anchorBY,
        grappleRopeAlpha: 1 - t,
      };
    }
  }

  if (active.type === "flip") {
    // Entrance/exit — a full airborne rotation while flying to/from offscreen.
    // Three phases: crouch takeoff (no rotation), airborne arc with an eased 0→2π whole-body
    // spin held in a fixed tuck, then a landing recovery with rotation already resolved to 0.
    // The spin itself is applied as `spinAngle` (rotated around the torso center in the draw
    // step below) — NOT via bodyLean, which only ever rotates the upper body around the hip and
    // reads as a cartwheel-smear when used for a full flip.
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const bx = lerp(active.fromX, tx, progress);
    const by = lerp(active.fromY, ty, progress);
    const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
    const airY = -180 * 4 * progress * (1 - progress);

    const TUCK_LEG = 1.2, TUCK_ARM = 0.9;
    let spinAngle = 0;
    let leftLegA: number, rightLegA: number, leftArmA: number, rightArmA: number;

    if (progress < 0.15) {
      // Takeoff: crouch, arms swing back — no rotation yet
      const t = progress / 0.15;
      leftLegA  = lerp(0, 0.5, t);
      rightLegA = lerp(0, -0.5, t);
      leftArmA  = lerp(0.15, -0.6, t);
      rightArmA = lerp(-0.15, -0.6, t);
    } else if (progress < 0.8) {
      // Airborne: eased 0→2π rotation across THIS window only; limbs hold a fixed tuck throughout
      const t = (progress - 0.15) / 0.65;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      spinAngle = eased * Math.PI * 2 * facing;
      leftLegA = TUCK_LEG; rightLegA = -TUCK_LEG;
      leftArmA = TUCK_ARM; rightArmA = -TUCK_ARM;
    } else {
      // Landing: rotation already at 2π ≡ 0 (set to 0 outright — no visible tilt) before feet
      // touch; legs extend to meet the ground, crouch-absorb impact, then recover to standing.
      const t = (progress - 0.8) / 0.2;
      spinAngle = 0;
      if (t < 0.5) {
        const lt = t / 0.5;
        leftLegA  = lerp(TUCK_LEG, 0.45, lt);
        rightLegA = lerp(-TUCK_LEG, -0.35, lt);
        leftArmA  = lerp(TUCK_ARM, 0.35, lt);
        rightArmA = lerp(-TUCK_ARM, -0.3, lt);
      } else {
        const lt = (t - 0.5) / 0.5;
        leftLegA  = lerp(0.45, 0.12, lt);
        rightLegA = lerp(-0.35, -0.12, lt);
        leftArmA  = lerp(0.35, 0.08, lt);
        rightArmA = lerp(-0.3, -0.08, lt);
      }
    }

    return {
      boardX: bx, boardY: by, facing,
      headBob: 0, bodyLean: 0, spinAngle,
      leftLegA, rightLegA, leftArmA, rightArmA, leftForeA: 0, rightForeA: 0,
      airY,
    };
  }

  if (active.type === "zipline") {
    // Slides down a taut line from a fixed anchor near the start — reuses the grapple rope draw
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
    const bx = lerp(active.fromX, tx, progress);
    const by = lerp(active.fromY, ty, progress);
    return {
      boardX: bx, boardY: by, facing,
      headBob: Math.sin(progress * Math.PI * 6) * 1.5, bodyLean: 0.15 * facing,
      leftLegA: 0.25, rightLegA: 0.35,
      leftArmA: -0.9, rightArmA: -0.9,
      leftForeA: -0.1, rightForeA: -0.1,
      airY: 0,
      grappleAnchorBX: active.fromX, grappleAnchorBY: active.fromY - 260,
      grappleRopeAlpha: 1,
    };
  }

  if (active.type === "wallClimb") {
    // Mostly-vertical climb, alternating limbs
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
    const bx = lerp(active.fromX, tx, progress);
    const by = lerp(active.fromY, ty, progress);
    const climbPhase = progress * 10;
    return {
      boardX: bx, boardY: by, facing,
      headBob: 0, bodyLean: -0.12,
      leftLegA: Math.sin(climbPhase) * 0.4 + 0.15, rightLegA: Math.sin(climbPhase + Math.PI) * 0.4 - 0.15,
      leftArmA: Math.sin(climbPhase + Math.PI) * 0.5 - 0.3, rightArmA: Math.sin(climbPhase) * 0.5 - 0.3,
      leftForeA: 0.1, rightForeA: 0.1,
      airY: 0,
    };
  }

  if (active.type === "sitAndWatch") {
    // Sits down at fromX/fromY and watches — knees bent, hands resting, gentle idle bob
    const t = time * 1.5;
    return {
      boardX: active.fromX, boardY: active.fromY, facing: 1,
      headBob: Math.sin(t) * 1.5, bodyLean: 0,
      leftLegA: 1.3, rightLegA: -1.3,
      leftArmA: 0.5, rightArmA: -0.5,
      leftForeA: 0.3, rightForeA: -0.3,
      airY: 0,
    };
  }

  if (active.type === "explainGesture") {
    // Animated talking-with-hands loop for image holds: arms alternate raising to gesture height
    // on independent, slightly-drifting periods (~1s each) so the beats don't lock into a
    // metronome, punctuated by an occasional two-arm "you see?" spread. Feet stay planted; head
    // bob / lean / leg weight-shift ride along with the beats to sell it as talking, not idling.
    const lPhase = time * (Math.PI * 2 / 1.0) + Math.sin(time * 0.17) * 0.6;
    const rPhase = time * (Math.PI * 2 / 1.15) + Math.PI + Math.sin(time * 0.13 + 1.7) * 0.5;
    const lRaise = Math.pow(Math.max(0, Math.sin(lPhase)), 1.6);
    const rRaise = Math.pow(Math.max(0, Math.sin(rPhase)), 1.6);

    // Two-arm spread roughly every ~4.3s (non-integer period to avoid syncing with the arm beats)
    const spreadCycle = time % 4.3;
    const spread = Math.max(0, 1 - Math.abs(spreadCycle - 2.0) / 0.5);

    const leftArmA = 0.15 + lRaise * 0.95 + spread * 0.35;
    const rightArmA = -0.15 - rRaise * 0.95 - spread * 0.35;
    const leftForeA = 0.15 + lRaise * 0.35 + spread * 0.15;
    const rightForeA = -0.15 - rRaise * 0.35 - spread * 0.15;

    return {
      boardX: active.fromX, boardY: active.fromY, facing: 1,
      headBob: Math.sin(time * 1.1) * 1.5 + (lRaise + rRaise) * 1.5,
      bodyLean: Math.sin(time * 0.6) * 0.05 + (lRaise - rRaise) * 0.06,
      leftLegA: 0.1 + Math.sin(time * 0.5) * 0.06,
      rightLegA: -0.1 - Math.sin(time * 0.5 + 1.3) * 0.06,
      leftArmA, rightArmA, leftForeA, rightForeA,
      airY: 0,
    };
  }

  if (active.type === "pointAt") {
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const facing: 1 | -1 = (tx - active.fromX) >= 0 ? 1 : -1;
    const armProgress = Math.min(1, progress / 0.3);
    // Weight shift: stance leg slightly offset toward target side
    const stanceShift = facing === 1 ? 0.08 : -0.08;
    return {
      boardX: active.fromX, boardY: active.fromY, facing,
      headBob: 0, bodyLean: 0,
      leftLegA: stanceShift, rightLegA: -stanceShift * 0.5,
      // Arm defaults — will be overridden in draw for the pointing arm
      leftArmA: 0.15, rightArmA: 0.15,
      leftForeA: 0.2, rightForeA: 0.2,
      airY: 0,
      pointTargetBX: active.fromX + (tx - active.fromX) * armProgress,
      pointTargetBY: active.fromY + (ty - active.fromY) * armProgress,
    };
  }

  if (active.type === "emote") {
    const hop = Math.sin(Math.PI * Math.min(1, progress * 3)) * -20;
    const emojiAlpha = progress <= 0.2
      ? progress / 0.2
      : progress <= 0.8 ? 1
      : Math.max(0, 1 - (progress - 0.8) / 0.2);
    return {
      boardX: active.fromX, boardY: active.fromY, facing: 1,
      headBob: hop * 0.4, bodyLean: Math.sin(progress * Math.PI * 4) * 0.08,
      leftLegA: 0, rightLegA: 0,
      leftArmA: 0.5, rightArmA: -0.5,
      leftForeA: 0.2, rightForeA: -0.2,
      airY: hop,
      emojiText: active.emoji, emojiAlpha,
    };
  }

  return idlePose(active.fromX, active.fromY);
}

function drawCharacterToCanvas(
  ctx: CanvasRenderingContext2D,
  time: number,
  resolved: ResolvedCharAction[],
  showChar: boolean,
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  sf: number,
  W: number,
  H: number,
  initX: number,
  initY: number,
  clips: { boardX?: number; boardY?: number; boardW?: number; boardH?: number; type?: string }[],
  entranceTime: number
) {
  if (!showChar || time < entranceTime) return;
  const p = evalCharAtTime(time, resolved, initX, initY, clips);
  const { facing } = p;

  const sx = (p.boardX - cam.cameraX) * sf + W / 2;
  const sy = (p.boardY - cam.cameraY) * sf + H / 2;
  const S = sf;
  const lw = Math.max(1, 3 * S);

  // Raw (unscaled) body proportions — single source of truth reused below for both the S-scaled
  // draw geometry and the raw board-space magic numbers (grapple hand height, pointAt shoulder
  // height) that need to stay in sync with them.
  const HIP_RAW = 76;
  const TORSO_RAW = 53;     // shortened by NECK_RAW from the original 65 so total height is unchanged
  const NECK_RAW = 12;
  const HEAD_R_RAW = 20;
  const STAND_HEIGHT_RAW = HIP_RAW + TORSO_RAW + NECK_RAW + HEAD_R_RAW * 2; // feet to head-top

  // ── Grapple / zipline rope (drawn before character transform so coords are screen-space) ──
  if (p.grappleAnchorBX !== undefined && p.grappleRopeAlpha && p.grappleRopeAlpha > 0) {
    const anchorSX = (p.grappleAnchorBX - cam.cameraX) * sf + W / 2;
    const anchorSY = (p.grappleAnchorBY! - cam.cameraY) * sf + H / 2;
    // Rope exits from roughly the raised-hand point, just above the head
    const handSX = sx;
    const handSY = sy - (STAND_HEIGHT_RAW + 5) * S;
    const ctrlSX = (handSX + anchorSX) / 2;
    const ctrlSY = Math.min(handSY, anchorSY) - 20 * S;
    ctx.save();
    ctx.globalAlpha = p.grappleRopeAlpha;
    ctx.strokeStyle = "#5a3a1a";
    ctx.lineWidth = Math.max(1, 1.8 * S);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(handSX, handSY);
    ctx.quadraticCurveTo(ctrlSX, ctrlSY, anchorSX, anchorSY);
    ctx.stroke();
    // Anchor spike
    ctx.fillStyle = "#5a3a1a";
    ctx.beginPath();
    ctx.arc(anchorSX, anchorSY, 3 * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  ctx.translate(sx, sy + p.airY * S);
  ctx.scale(facing, 1);
  ctx.strokeStyle = "#2a2a2a";
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const legLen = 38 * S;
  const torsoLen = TORSO_RAW * S;
  const neckLen = NECK_RAW * S;
  const armLen = 32 * S;
  const headR = HEAD_R_RAW * S;
  const bobS = p.headBob * S;
  const hipY = -HIP_RAW * S + bobS * 0.25;

  // Whole-body spin (flip only): rotates legs + torso group together around the torso midpoint,
  // so a flip reads as the whole character turning over rather than the cartwheel-smear you get
  // rotating just the upper body around the hip. No-op for every other pose (spinAngle undefined).
  if (p.spinAngle) {
    const spinCenterY = hipY - torsoLen / 2;
    ctx.translate(0, spinCenterY);
    ctx.rotate(p.spinAngle);
    ctx.translate(0, -spinCenterY);
  }

  // Legs (two-segment: thigh + shin with independent shin angle). Local-x sign is negated so that
  // a POSITIVE angle always means "outward from body midline" for both legs — the un-negated form
  // (x = +sin(angle)) makes positive-left/negative-right cross at the ankles instead of spreading.
  const drawLeg = (thighA: number, shinA: number) => {
    const kx = -Math.sin(thighA) * legLen;
    const ky = hipY + Math.cos(thighA) * legLen;
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(kx, ky);
    ctx.lineTo(kx - Math.sin(shinA) * legLen, ky + Math.cos(shinA) * legLen);
    ctx.stroke();
  };
  // Shin angle = thigh angle + forearm angle (using leftForeA/rightForeA as shin bend)
  drawLeg(p.leftLegA, p.leftLegA + p.leftForeA * 0.5);
  drawLeg(p.rightLegA, p.rightLegA + p.rightForeA * 0.5);

  // Torso + neck + head all rotate together with bodyLean (e.g. the flip's full-rotation spin)
  ctx.save();
  ctx.translate(0, hipY);
  ctx.rotate(p.bodyLean);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -torsoLen); ctx.stroke();

  const relSY = -torsoLen;
  let lArmA = p.leftArmA, rArmA = p.rightArmA;
  let lForeA = p.leftForeA, rForeA = p.rightForeA;

  // Override pointing arm; other arm hangs relaxed (not tucked inward)
  if (p.pointTargetBX !== undefined && p.pointTargetBY !== undefined) {
    const shoulderBY = p.boardY - (HIP_RAW + TORSO_RAW);
    const tdxLocal = (p.pointTargetBX - p.boardX) * facing;
    const tdyCanvas = p.pointTargetBY - shoulderBY;
    const mag = Math.hypot(tdxLocal, tdyCanvas);
    if (mag > 0) {
      // Negated to match drawArm's negated sin() below (same outward-positive convention as legs)
      const pointAngle = -Math.atan2(tdxLocal, tdyCanvas);
      const RELAX_ARM = 0.15;  // natural hang angle
      const RELAX_FORE = 0.2;
      if (tdxLocal >= 0) {
        rArmA = pointAngle; rForeA = pointAngle;
        lArmA = RELAX_ARM;  lForeA = RELAX_FORE;
      } else {
        lArmA = pointAngle; lForeA = pointAngle;
        rArmA = RELAX_ARM;  rForeA = RELAX_FORE;
      }
    }
  }

  const drawArm = (sOff: number, armA: number, foreA: number) => {
    const ex = sOff - Math.sin(armA) * armLen;
    const ey = relSY + Math.cos(armA) * armLen;
    ctx.beginPath();
    ctx.moveTo(sOff, relSY);
    ctx.lineTo(ex, ey);
    ctx.lineTo(ex - Math.sin(foreA) * armLen, ey + Math.cos(foreA) * armLen);
    ctx.stroke();
  };
  drawArm(-7 * S, lArmA, lForeA);
  drawArm(7 * S, rArmA, rForeA);

  // Neck — short segment from shoulder up to where the head sits
  const neckTopY = relSY - neckLen;
  ctx.beginPath(); ctx.moveTo(0, relSY); ctx.lineTo(0, neckTopY); ctx.stroke();

  // Head — blank circle only (no face features), sitting on top of the neck
  const headCY = neckTopY - headR;
  ctx.beginPath(); ctx.arc(0, headCY, headR, 0, Math.PI * 2); ctx.stroke();

  // Emoji emote
  if (p.emojiText && p.emojiAlpha && p.emojiAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = p.emojiAlpha;
    ctx.font = `${Math.max(12, 80 * S)}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.scale(1 / facing, 1);
    ctx.fillText(p.emojiText, 0, headCY - headR - 12 * S);
    ctx.restore();
  }

  ctx.restore(); // un-lean (torso/neck/head/arms)
  ctx.restore(); // top-level
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Board2Page() {
  const { data: session } = useSession();

  const [clips, setClips] = useState<Clip[]>([]);
  const [mediaLibrary, setMediaLibrary] = useState<MediaItem[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [mutedLayers, setMutedLayers] = useState<Record<number, boolean>>({});
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [canvasAspect, setCanvasAspect] = useState<"16:9" | "9:16">("16:9");
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [timelineScroll, setTimelineScroll] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [boardZoom, setBoardZoom] = useState(0.18);
  const [boardPan, setBoardPan] = useState({ x: 20, y: 20 });
  const [toast, setToast] = useState<string | null>(null);
  const [cameraKeyframes, setCameraKeyframes] = useState<CameraKeyframe[]>([]);
  const [isSpaceDown, setIsSpaceDown] = useState(false);
  const [dividerTooltip, setDividerTooltip] = useState<{ label: string; x: number; y: number } | null>(null);
  const [keyframesOutOfDate, setKeyframesOutOfDate] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; timeSec: number; clipId?: string } | null>(null);
  const [clipboardReady, setClipboardReady] = useState(false);

  // ── Mobile ──
  const [isMobile, setIsMobile] = useState(false);
  const [isPortrait, setIsPortrait] = useState(false);
  const [mobileDrawer, setMobileDrawer] = useState<"media" | "props" | null>(null);
  const [mobileLongPressClipId, setMobileLongPressClipId] = useState<string | null>(null);

  // ── Save / Load ──
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("My Board");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingProject, setIsLoadingProject] = useState(false);

  // ── Annotations ──
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>([]);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("pointer");
  const [annotationColor, setAnnotationColor] = useState("#cc2200");
  const [annotationFont, setAnnotationFont] = useState("Caveat");
  const [annotationHighlightStyle, setAnnotationHighlightStyle] = useState<"rect" | "underline" | "curlyBrace">("rect");
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationText, setEditingAnnotationText] = useState("");
  const [annotationToolbarOpen, setAnnotationToolbarOpen] = useState(false);
  const [annotationEmoji, setAnnotationEmoji] = useState("🎯");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [penPreviewPoints, setPenPreviewPoints] = useState<Array<{ x: number; y: number }> | null>(null);

  // ── Character ──
  const [showCharacter, setShowCharacter] = useState(false);
  const [characterActions, setCharacterActions] = useState<CharacterAction[]>([]);
  const [characterMode, setCharacterMode] = useState<"auto" | "manual">("auto");
  const [characterAddMode, setCharacterAddMode] = useState<"walkTo" | "jumpTo" | "pointAt" | "emote" | "grapple" | null>(null);
  const [characterToolbarOpen, setCharacterToolbarOpen] = useState(false);
  const [characterEmoji, setCharacterEmoji] = useState("🤔");
  const [characterEmojiPickerOpen, setCharacterEmojiPickerOpen] = useState(false);
  const [charActionContextMenu, setCharActionContextMenu] = useState<{ x: number; y: number; actionId: string } | null>(null);

  // ── AI character choreography ──
  const [directCharacterOpen, setDirectCharacterOpen] = useState(false);
  const [characterDirection, setCharacterDirection] = useState("");
  const [syncEmotesToNarration, setSyncEmotesToNarration] = useState(true);
  const [choreoPhase, setChoreoPhase] = useState<string | null>(null);
  const [choreoError, setChoreoError] = useState<string | null>(null);

  // ── AI annotation generation ──
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiTab, setAiTab] = useState<"audio" | "script">("audio");
  const [aiAudioFile, setAiAudioFile] = useState<File | null>(null);
  const [aiScriptText, setAiScriptText] = useState("");
  const [aiPhase, setAiPhase] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // ── YouTube modal ──
  const [ytModalOpen, setYtModalOpen] = useState(false);
  const [ytTab, setYtTab] = useState<YtTab>("search");
  const [ytView, setYtView] = useState<YtModalView>("search");
  const [ytUrlInput, setYtUrlInput] = useState("");
  const [ytQuery, setYtQuery] = useState("");
  const [ytResults, setYtResults] = useState<YtSearchResult[]>([]);
  const [ytSelected, setYtSelected] = useState<YtSearchResult | null>(null);
  const [ytStart, setYtStart] = useState(0);
  const [ytStartInput, setYtStartInput] = useState("0:00");
  const [ytEnd, setYtEnd] = useState(30);
  const [ytEndInput, setYtEndInput] = useState("0:30");
  const [ytError, setYtError] = useState("");
  const [ytLoading, setYtLoading] = useState(false);
  const [ytShortsOnly, setYtShortsOnly] = useState(false);
  const [downloadToasts, setDownloadToasts] = useState<DownloadToast[]>([]);

  // ── Neural Search ──
  const [neuralModalOpen, setNeuralModalOpen] = useState(false);
  const [neuralConcept, setNeuralConcept] = useState("");
  const [neuralPhase, setNeuralPhase] = useState<string | null>(null);
  const [neuralError, setNeuralError] = useState("");
  const [neuralPlaceholders, setNeuralPlaceholders] = useState<NeuralPlaceholder[]>([]);
  const [imagePlaceholders, setImagePlaceholders] = useState<ImagePlaceholder[]>([]);
  const [hoveredPlaceholderId, setHoveredPlaceholderId] = useState<string | null>(null);
  const [imagePreviewTarget, setImagePreviewTarget] = useState<ImagePlaceholder | null>(null);
  const [imagePreviewWorking, setImagePreviewWorking] = useState(false);
  const [imagePreviewError, setImagePreviewError] = useState("");

  // ── Top 5 Neural Search ──
  const [top5ModalOpen, setTop5ModalOpen] = useState(false);
  const [top5Concept, setTop5Concept] = useState("");
  const [top5Phase, setTop5Phase] = useState<string | null>(null);
  const [top5Error, setTop5Error] = useState("");

  // ── Mobile Top 5 Tinder flow ──
  type MobileVideoCandidate = { videoId: string; title: string; channel: string; thumbnailUrl: string; viewCount: number; durationSec: number; };
  type MobileTop5ItemData = { rank: number; label: string; blurb: string; videos: MobileVideoCandidate[]; };
  type MobileTop5ApiData = { title: string; items: MobileTop5ItemData[]; };
  type MobileAcceptedVideo = { videoId: string; trimStart: number; trimEnd: number; title: string; };

  const [mobileDesktopOverride, setMobileDesktopOverride] = useState(false);
  const [mobileTop5Screen, setMobileTop5Screen] = useState<"prompt" | "loading" | "swipe" | "build" | "done">("prompt");
  const [mobileTop5Concept, setMobileTop5Concept] = useState("");
  const [mobileTop5Data, setMobileTop5Data] = useState<MobileTop5ApiData | null>(null);
  const [mobileTop5CurrentRank, setMobileTop5CurrentRank] = useState(5);
  const [mobileTop5ResultsByRank, setMobileTop5ResultsByRank] = useState<Map<number, MobileVideoCandidate[]>>(new Map());
  const [mobileTop5IndexByRank, setMobileTop5IndexByRank] = useState<Map<number, number>>(new Map());
  const [mobileTop5AcceptedByRank, setMobileTop5AcceptedByRank] = useState<Map<number, MobileAcceptedVideo>>(new Map());
  const [mobileTop5TrimStart, setMobileTop5TrimStart] = useState(0);
  const [mobileTop5TrimEnd, setMobileTop5TrimEnd] = useState(30);
  const [mobileTop5CardAnim, setMobileTop5CardAnim] = useState<"accept" | "reject" | null>(null);
  const [mobileTop5LoadingRank, setMobileTop5LoadingRank] = useState<number | null>(null);
  const [mobileTop5BuildPhase, setMobileTop5BuildPhase] = useState<string | null>(null);
  const [mobileTop5Error, setMobileTop5Error] = useState("");

  const [boardMarquee, setBoardMarquee] = useState<BoardMarquee>(null);
  const [timelineMarquee, setTimelineMarquee] = useState<TimelineMarquee>(null);

  const canvasW = canvasAspect === "16:9" ? CANVAS_W_LAND : CANVAS_H_LAND;
  const canvasH = canvasAspect === "16:9" ? CANVAS_H_LAND : CANVAS_W_LAND;
  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;
  const timelineDuration = Math.max(10, ...clips.map((c) => c.startTime + c.duration + 2));
  const timelineWidth = timelineDuration * pxPerSec;
  const previewW = Math.round(PREVIEW_H_PX * canvasW / canvasH);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const clipsRef = useRef<Clip[]>(clips);
  const selectedClipIdsRef = useRef<string[]>([]);
  const selectedAnnotationIdsRef = useRef<string[]>([]);
  const mutedLayersRef = useRef<Record<number, boolean>>({});
  const playheadRef = useRef(0);
  const isPlayingRef = useRef(false);
  const canvasWRef = useRef(canvasW);
  const canvasHRef = useRef(canvasH);
  const boardZoomRef = useRef(0.18);
  const boardPanRef = useRef({ x: 20, y: 20 });
  const isSpaceDownRef = useRef(false);
  const lastRafTimeRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const mediaUploadRef = useRef<HTMLInputElement>(null);
  const narrationUploadRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const exportCancelRef = useRef(false);
  const exportRafRef = useRef<number | null>(null);
  const isExportingRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraKeyframesRef = useRef<CameraKeyframe[]>([]);
  const pxPerSecRef = useRef(DEFAULT_PX_PER_SEC);
  const timelineScrollRef = useRef(0);
  const pendingScrollLeftRef = useRef<number | null>(null);
  const timelineDragRef = useRef<TimelineDrag | null>(null);
  const boardMarqueeRef = useRef<BoardMarquee>(null);
  const timelineMarqueeRef = useRef<TimelineMarquee>(null);
  const boardMarqueeStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const timelineMarqueeStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const rafCallbackRef = useRef<FrameRequestCallback>(() => {});
  const dividerDragRef = useRef<{ clipId: string; innerStartPx: number; innerWidthPx: number } | null>(null);
  const videoHiddenContainerRef = useRef<HTMLDivElement>(null);
  // Switch-based video playback: one dedicated <video> element per clip.id, even for duplicates sharing a sourceUrl.
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map()); // clip.id → HTMLVideoElement
  const videoRangeStateRef = useRef<Map<string, boolean>>(new Map()); // clip.id → wasInRange (previous frame)
  const videoStuckFrameCountRef = useRef<Map<string, number>>(new Map()); // clip.id → consecutive failed-draw frames while active
  const hasPrewarmedRef = useRef(false); // first-play autoplay unlock, once per session
  const thumbnailImagesRef = useRef<Map<string, HTMLImageElement | null>>(new Map()); // clip.id → pre-loaded thumbnail image (null = capture failed)
  const ytSliderTrackRef = useRef<HTMLDivElement>(null);
  const ytRangeRef = useRef({ start: 0, end: 30 });
  const prevPlayheadRef = useRef(-1); // previous frame's playhead for entry detection
  const annotationsRef = useRef<Annotation[]>([]);
  const annotationToolRef = useRef<AnnotationTool>("pointer");
  const annotationColorRef = useRef("#cc2200");
  const annotationFontRef = useRef("Caveat");
  const annotationHighlightStyleRef = useRef<"rect" | "underline" | "curlyBrace">("rect");
  const editingAnnotationTextRef = useRef("");
  const editingTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const annotationEmojiRef = useRef("🎯");
  const clipboardRef = useRef<Clip | null>(null);
  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micChunksRef = useRef<Blob[]>([]);
  const micStartSecRef = useRef(0);
  const micRafRef = useRef<number | null>(null);
  const micStartWallRef = useRef(0);
  const isRecordingRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mobileSwipeTouchStartXRef = useRef<number | null>(null);
  const mobileBoardPointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const mobileGestureRef = useRef<{
    type: "idle" | "deciding" | "pan" | "move" | "pinch";
    hitClipId: string | null;
    hitClipIsSelected: boolean;
    startX: number; startY: number;
    origPan: { x: number; y: number };
    clipOrigX: number; clipOrigY: number;
    pinchStartDist: number; pinchStartZoom: number; pinchStartPan: { x: number; y: number };
    longPressTimer: ReturnType<typeof setTimeout> | null;
  }>({
    type: "idle", hitClipId: null, hitClipIsSelected: false,
    startX: 0, startY: 0,
    origPan: { x: 0, y: 0 },
    clipOrigX: 0, clipOrigY: 0,
    pinchStartDist: 1, pinchStartZoom: 0.18, pinchStartPan: { x: 0, y: 0 },
    longPressTimer: null,
  });
  const activeNarrationRef = useRef<Map<string, { bufNode: AudioBufferSourceNode; gainNode: GainNode }>>(new Map());
  const videoAudioNodesRef = useRef<Map<string, { sourceNode: MediaElementAudioSourceNode; gainNode: GainNode }>>(new Map());
  const videoDimsRef = useRef<Map<string, { w: number; h: number }>>(new Map());
  const showCharacterRef = useRef(false);
  const characterActionsRef = useRef<CharacterAction[]>([]);
  const resolvedCharActionsRef = useRef<ResolvedCharAction[]>([]);
  const charInitXRef = useRef(BOARD_W / 2);
  const charInitYRef = useRef(BOARD_H * 0.75);
  const characterEntranceTimeRef = useRef(-Infinity);
  const characterAddModeRef = useRef<"walkTo" | "jumpTo" | "pointAt" | "emote" | "grapple" | null>(null);
  const characterModeRef = useRef<"auto" | "manual">("auto");
  const charActionDragRef = useRef<CharTimelineDrag | null>(null);

  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { selectedClipIdsRef.current = selectedClipIds; }, [selectedClipIds]);
  useEffect(() => { selectedAnnotationIdsRef.current = selectedAnnotationIds; }, [selectedAnnotationIds]);
  useEffect(() => { mutedLayersRef.current = mutedLayers; }, [mutedLayers]);
  useEffect(() => { playheadRef.current = playhead; }, [playhead]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { canvasWRef.current = canvasW; canvasHRef.current = canvasH; }, [canvasW, canvasH]);
  useEffect(() => { boardZoomRef.current = boardZoom; }, [boardZoom]);
  useEffect(() => { boardPanRef.current = boardPan; }, [boardPan]);
  useEffect(() => { cameraKeyframesRef.current = cameraKeyframes; }, [cameraKeyframes]);
  useEffect(() => { pxPerSecRef.current = pxPerSec; }, [pxPerSec]);
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);
  useEffect(() => { annotationToolRef.current = annotationTool; }, [annotationTool]);
  useEffect(() => { annotationColorRef.current = annotationColor; }, [annotationColor]);
  useEffect(() => { annotationFontRef.current = annotationFont; }, [annotationFont]);
  useEffect(() => { annotationHighlightStyleRef.current = annotationHighlightStyle; }, [annotationHighlightStyle]);
  useEffect(() => { editingAnnotationTextRef.current = editingAnnotationText; }, [editingAnnotationText]);
  useEffect(() => { annotationEmojiRef.current = annotationEmoji; }, [annotationEmoji]);
  useEffect(() => {
    if (editingAnnotationId) {
      requestAnimationFrame(() => editingTextareaRef.current?.focus());
    }
  }, [editingAnnotationId]);
  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);
  useEffect(() => { showCharacterRef.current = showCharacter; }, [showCharacter]);
  useEffect(() => { characterActionsRef.current = characterActions; }, [characterActions]);
  useEffect(() => { characterModeRef.current = characterMode; }, [characterMode]);
  useEffect(() => { characterAddModeRef.current = characterAddMode; }, [characterAddMode]);
  // Resolved character actions are COMPUTED, not stored — this useMemo recomputes from scratch
  // whenever clips (reorder/add/delete/holdFraction/board-position — all produce a new `clips`
  // array reference), characterActions (manual edits), or characterMode change. There is no way
  // for this to go stale: a clip reorder is automatically reflected on the very next render.
  const charInit = useMemo(() => getCharInitPos(clips), [clips]);
  const resolvedCharActions = useMemo(() => {
    const merged = characterMode === "auto"
      ? mergeCharActions(deriveAutoCharActions(clips, charInit.x, charInit.y), characterActions)
      : characterActions;
    return resolveCharActions(merged, charInit.x, charInit.y, clips);
  }, [clips, characterActions, characterMode, charInit]);

  // Before the auto-derived entrance flip lands, the character isn't on the board at all (see
  // deriveAutoCharActions) — this is when that flip starts, or +Infinity if the timeline is
  // pan-only (no media to flip onto, so he never appears) or -Infinity outside auto mode.
  const characterEntranceTime = useMemo(() => {
    if (characterMode !== "auto") return -Infinity;
    const focusClips = clips.filter((c) => c.type !== "narration" && (c.type === "pan" || c.boardX !== undefined));
    if (focusClips.length > 0 && focusClips.every((c) => c.type === "pan")) return Infinity;
    const entrance = resolvedCharActions.find((a) => a.entranceFlip);
    return entrance ? entrance.startTime : -Infinity;
  }, [characterMode, clips, resolvedCharActions]);

  // Mirror the memoized result into refs for the RAF draw loop (which must avoid stale closures)
  useEffect(() => {
    charInitXRef.current = charInit.x;
    charInitYRef.current = charInit.y;
    resolvedCharActionsRef.current = resolvedCharActions;
    characterEntranceTimeRef.current = characterEntranceTime;
  }, [charInit, resolvedCharActions, characterEntranceTime]);

  useEffect(() => {
    const check = () => {
      setIsMobile(window.innerWidth < 768 || window.matchMedia("(pointer: coarse)").matches);
      setIsPortrait(window.innerHeight > window.innerWidth);
    };
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, [toast]);

  useEffect(() => {
    return () => {
      if (micRecorderRef.current?.state === "recording") micRecorderRef.current.stop();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (micRafRef.current !== null) cancelAnimationFrame(micRafRef.current);
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  // Apply pending scroll after pxPerSec changes
  useEffect(() => {
    if (pendingScrollLeftRef.current !== null) {
      const el = scrollerRef.current;
      if (el) el.scrollLeft = pendingScrollLeftRef.current;
      pendingScrollLeftRef.current = null;
    }
  }, [pxPerSec]);

  // Fit board to container on mount
  useEffect(() => {
    const timeout = setTimeout(() => {
      const container = boardContainerRef.current;
      if (!container) return;
      const { width, height } = container.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const zoom = Math.min((width - 60) / BOARD_W, (height - 60) / BOARD_H);
      const panX = (width - BOARD_W * zoom) / 2;
      const panY = (height - BOARD_H * zoom) / 2;
      setBoardZoom(zoom);
      setBoardPan({ x: panX, y: panY });
    }, 30);
    return () => clearTimeout(timeout);
  }, []);

  // Board wheel zoom (non-passive)
  useEffect(() => {
    const container = boardContainerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const pz = boardZoomRef.current;
      const pp = boardPanRef.current;
      const nz = Math.max(0.05, Math.min(3, pz * factor));
      const np = { x: mx - (mx - pp.x) * (nz / pz), y: my - (my - pp.y) * (nz / pz) };
      boardZoomRef.current = nz;
      boardPanRef.current = np;
      setBoardZoom(nz);
      setBoardPan(np);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  // Timeline Cmd/Ctrl+scroll zoom (cursor-anchored)
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + el.scrollLeft;
      const cursorTimeSec = cursorX / pxPerSecRef.current;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newPxPerSec = clamp(pxPerSecRef.current * factor, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
      pxPerSecRef.current = newPxPerSec;
      setPxPerSec(newPxPerSec);
      pendingScrollLeftRef.current = Math.max(0, cursorTimeSec * newPxPerSec - (e.clientX - rect.left));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─ Canvas draw ────────────────────────────────────────────────────────────

  const renderToCtx = useCallback((
    ctx: CanvasRenderingContext2D,
    time: number,
    currentClips: Clip[],
    currentCameraKeyframes: CameraKeyframe[],
    W: number,
    H: number,
    currentAnnotations: Annotation[]
  ) => {
    ctx.fillStyle = "#f5ecd8";
    ctx.fillRect(0, 0, W, H);
    const cam = interpolateCameraKeyframes(currentCameraKeyframes, time);
    const sf = cam.boardZoom * W / BOARD_W;
    const sortedClips = [...currentClips].sort((a, b) => (a.layer ?? 1) - (b.layer ?? 1));
    for (const clip of sortedClips) {
      if (clip.boardX === undefined) continue;
      const bx = clip.boardX, by = clip.boardY!, bw = clip.boardW!, bh = clip.boardH!;
      const sx = (bx + bw / 2 - cam.cameraX) * sf + W / 2;
      const sy = (by + bh / 2 - cam.cameraY) * sf + H / 2;
      const sw = bw * sf, sh = bh * sf;
      ctx.globalAlpha = 1;
      if (clip.type === "image") {
        const img = imgCacheRef.current.get(clip.sourceUrl);
        if (img?.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, sx - sw / 2, sy - sh / 2, sw, sh);
        }
      } else {
        const vid = videoElsRef.current.get(clip.id);
        const thumbEl = thumbnailImagesRef.current.get(clip.id);
        let drewLive = false;
        // readyState >= 3 (HAVE_FUTURE_DATA) + currentTime > 0.05 = a decoded frame actually
        // exists to draw — readyState >= 2 alone can be true before the first frame is decoded,
        // which showed the thumbnail-frozen-while-audio-plays bug on a clip's first playthrough.
        if (vid && vid.readyState >= 3 && !vid.paused && !vid.ended && vid.currentTime > 0.05) {
          try { ctx.drawImage(vid, sx - sw / 2, sy - sh / 2, sw, sh); drewLive = true; } catch { drewLive = false; }
        }
        if (drewLive) {
          videoStuckFrameCountRef.current.set(clip.id, 0);
        } else if (vid && !vid.paused && time >= clip.startTime && time < clip.startTime + clip.duration) {
          // Clip should be actively playing but produced no drawable frame this render — track
          // consecutive misses and nudge playback if it's stuck for a few frames in a row.
          const misses = (videoStuckFrameCountRef.current.get(clip.id) ?? 0) + 1;
          videoStuckFrameCountRef.current.set(clip.id, misses);
          if (misses >= 3) {
            vid.currentTime = 0.1;
            vid.play().catch(() => {});
            videoStuckFrameCountRef.current.set(clip.id, 0);
            console.warn("[video] clip", clip.id, "stuck — nudging playback");
          }
        }
        if (!drewLive) {
          if (thumbEl) {
            ctx.drawImage(thumbEl, sx - sw / 2, sy - sh / 2, sw, sh);
          } else {
            // Thumbnail not yet captured or failed — draw black box with play icon
            ctx.fillStyle = "#111";
            ctx.fillRect(sx - sw / 2, sy - sh / 2, sw, sh);
            ctx.fillStyle = "rgba(255,255,255,0.6)";
            ctx.font = `${Math.max(16, Math.min(sw, sh) * 0.3)}px sans-serif`;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText("▶", sx, sy);
            ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    if (showCharacterRef.current) {
      drawCharacterToCanvas(
        ctx, time, resolvedCharActionsRef.current, showCharacterRef.current,
        cam, sf, W, H, charInitXRef.current, charInitYRef.current,
        clipsRef.current, characterEntranceTimeRef.current
      );
    }
    if (currentAnnotations.length > 0) {
      drawAnnotationsToCanvas(ctx, currentAnnotations, cam, sf, W, H);
    }
  }, []);

  const drawFrame = useCallback((time: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    renderToCtx(ctx, time, clipsRef.current, cameraKeyframesRef.current, canvasWRef.current, canvasHRef.current, annotationsRef.current);
  }, [renderToCtx]);

  // ─ Video audio routing ────────────────────────────────────────────────────

  // Lazily wires a video element into the Web Audio graph if it doesn't have nodes yet
  // (covers clips added while already playing, e.g. a background download completing mid-playback).
  function ensureVideoAudioNodes(clipId: string, vid: HTMLVideoElement) {
    if (videoAudioNodesRef.current.has(clipId)) return;
    let ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") { ctx = new AudioContext(); audioCtxRef.current = ctx; }
    try {
      const sourceNode = ctx.createMediaElementSource(vid);
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0;
      sourceNode.connect(gainNode);
      gainNode.connect(ctx.destination);
      videoAudioNodesRef.current.set(clipId, { sourceNode, gainNode });
    } catch {}
  }

  // Applies clip.volume/muted to whichever audio path is live for this clip: the Web Audio
  // gain node if one exists, otherwise the video element's native volume/muted as a fallback
  // (e.g. createMediaElementSource threw).
  function effectiveClipVolume(clip: Clip): number {
    if (clip.muted) return 0;
    if (clip.type === "video" && mutedLayersRef.current[clip.layer ?? 1]) return 0;
    return clip.volume ?? 1;
  }

  function toggleLayerMute(layer: number) {
    const next = { ...mutedLayersRef.current, [layer]: !mutedLayersRef.current[layer] };
    mutedLayersRef.current = next;
    setMutedLayers(next);
    for (const clip of clipsRef.current) {
      if (clip.type !== "video" || (clip.layer ?? 1) !== layer) continue;
      const vid = videoElsRef.current.get(clip.id);
      if (vid) updateVideoVolume(clip, vid);
    }
  }

  function updateVideoVolume(clip: Clip, vid: HTMLVideoElement) {
    const effectiveVolume = effectiveClipVolume(clip);
    const nodes = videoAudioNodesRef.current.get(clip.id);
    if (nodes) {
      nodes.gainNode.gain.value = effectiveVolume;
    } else {
      vid.muted = false;
      vid.volume = effectiveVolume;
    }
  }

  // Pure play/pause mechanics shared by the preview RAF loop, togglePlay, and the export loop
  // so entry/exit behavior can't silently diverge between them. These never touch audio —
  // export schedules its own audio separately and must not un-silence the preview gain nodes.
  function restartAndPlay(vid: HTMLVideoElement, offsetSec: number) {
    vid.currentTime = Math.max(0, offsetSec);
    vid.play().catch(() => {});
  }
  function pauseAndReset(vid: HTMLVideoElement) {
    vid.pause();
    vid.currentTime = 0;
  }

  // Switch ON: entry into a clip's active range (or resuming into one), for the live preview.
  function switchVideoOn(clip: Clip, vid: HTMLVideoElement, offsetSec: number) {
    restartAndPlay(vid, offsetSec);
    updateVideoVolume(clip, vid);
  }

  // Silences a clip's audio path (gain node if it exists, else native mute) — the "off" state
  // shared by switchVideoOff and pre-warming.
  function setClipAudioOff(clipId: string, vid: HTMLVideoElement) {
    const nodes = videoAudioNodesRef.current.get(clipId);
    if (nodes) nodes.gainNode.gain.value = 0; else vid.muted = true;
  }

  // Switch OFF: exit from a clip's active range, for the live preview.
  function switchVideoOff(clip: Clip, vid: HTMLVideoElement) {
    setClipAudioOff(clip.id, vid);
    pauseAndReset(vid);
  }

  // Warms up a freshly created video element's decoder with a silent play()→pause() cycle so
  // its first "real" entry (restart-on-entry, Step 16.10) already has a decoded frame ready to
  // draw — otherwise the first playthrough plays audio while the canvas still shows the frozen
  // thumbnail until the decoder catches up. Runs once, as soon as the element can play.
  function prewarmVideoElement(clipId: string, vid: HTMLVideoElement) {
    vid.addEventListener("canplay", () => {
      // If the clip has already had a real entry by the time canplay fires (e.g. pasted
      // directly onto the currently-playing position), don't interfere — pausing/silencing it
      // here would kill playback that's already legitimately underway.
      if (videoRangeStateRef.current.get(clipId)) return;
      ensureVideoAudioNodes(clipId, vid);
      setClipAudioOff(clipId, vid); // keep the warm-up silent
      vid.play().then(() => {
        if (videoRangeStateRef.current.get(clipId)) return; // became active while warming up
        pauseAndReset(vid);
        console.log("[video] pre-warmed clip", clipId);
      }).catch((err) => {
        if (videoRangeStateRef.current.get(clipId)) return;
        pauseAndReset(vid);
        console.warn("[video] pre-warm failed for clip", clipId, err); // not fatal — will still try on entry
      });
    }, { once: true });
  }

  // ─ RAF playback loop ──────────────────────────────────────────────────────

  const rafLoop = useCallback(() => {
    if (!isPlayingRef.current) return;
    // eslint-disable-next-line react-hooks/purity
    const now = performance.now();
    const prevT = prevPlayheadRef.current;
    if (lastRafTimeRef.current !== null) {
      const dt = (now - lastRafTimeRef.current) / 1000;
      const next = playheadRef.current + dt;
      const maxEnd = clipsRef.current.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
      if (next >= maxEnd) {
        playheadRef.current = maxEnd; setPlayhead(maxEnd); setIsPlaying(false);
        isPlayingRef.current = false;
        // Switch off any clip still active — timeline ended mid-clip
        for (const clip of clipsRef.current) {
          if (clip.type !== "video") continue;
          const vid = videoElsRef.current.get(clip.id);
          if (!vid) continue;
          if (videoRangeStateRef.current.get(clip.id)) {
            switchVideoOff(clip, vid);
            videoRangeStateRef.current.set(clip.id, false);
          }
        }
        for (const clipId of [...activeNarrationRef.current.keys()]) {
          const entry = activeNarrationRef.current.get(clipId);
          if (entry) { try { entry.bufNode.stop(); } catch {} try { entry.bufNode.disconnect(); } catch {} try { entry.gainNode.disconnect(); } catch {} }
        }
        activeNarrationRef.current.clear();
        prevPlayheadRef.current = maxEnd;
        drawFrame(maxEnd); return;
      }
      playheadRef.current = next; setPlayhead(next);
    }
    lastRafTimeRef.current = now;
    const t = playheadRef.current;
    prevPlayheadRef.current = t;
    // Switch-based per-clip video playback: entry restarts from 0 + plays, exit pauses + resets to 0
    for (const clip of clipsRef.current) {
      if (clip.type !== "video") continue;
      const vid = videoElsRef.current.get(clip.id);
      if (!vid) continue;
      const isInRange = t >= clip.startTime && t < clip.startTime + clip.duration;
      const wasInRange = videoRangeStateRef.current.get(clip.id) ?? false;
      ensureVideoAudioNodes(clip.id, vid);
      if (isInRange && !wasInRange) {
        // Just entered: restart from beginning of blob (blob is pre-trimmed for YouTube; uploaded clips start at 0)
        switchVideoOn(clip, vid, 0);
        console.log("[video] clip", clip.id, "entered — restart + play");
      } else if (!isInRange && wasInRange) {
        // Just exited: switch off
        switchVideoOff(clip, vid);
        console.log("[video] clip", clip.id, "exited — pause");
      } else if (isInRange) {
        updateVideoVolume(clip, vid);
        // Drift correction: if the element's own clock diverges from the timeline, resync
        const expected = t - clip.startTime;
        if (Math.abs(vid.currentTime - expected) > 0.3) vid.currentTime = expected;
      }
      videoRangeStateRef.current.set(clip.id, isInRange);
    }
    // Narration audio: spawn on entry, stop on exit
    for (const clip of clipsRef.current) {
      if (clip.type !== "narration") continue;
      const isActive = t >= clip.startTime && t < clip.startTime + clip.duration;
      const wasActive = prevT >= clip.startTime && prevT < clip.startTime + clip.duration;
      if (isActive && !wasActive && !activeNarrationRef.current.has(clip.id)) {
        const clipId = clip.id;
        const blobUrl = clip.sourceUrl;
        const clipOffset = t - clip.startTime;
        let ctx = audioCtxRef.current;
        if (!ctx || ctx.state === "closed") { ctx = new AudioContext(); audioCtxRef.current = ctx; }
        const audioCtxCapture = ctx;
        fetch(blobUrl)
          .then((r) => r.arrayBuffer())
          .then((ab) => audioCtxCapture.decodeAudioData(ab))
          .then((buffer) => {
            if (!isPlayingRef.current || activeNarrationRef.current.has(clipId)) return;
            const gainNode = audioCtxCapture.createGain();
            gainNode.gain.value = clip.muted ? 0 : (clip.volume ?? 1);
            gainNode.connect(audioCtxCapture.destination);
            const bufNode = audioCtxCapture.createBufferSource();
            bufNode.buffer = buffer;
            bufNode.connect(gainNode);
            bufNode.start(0, Math.min(Math.max(0, clipOffset), Math.max(0, buffer.duration - 0.01)));
            bufNode.onended = () => activeNarrationRef.current.delete(clipId);
            activeNarrationRef.current.set(clipId, { bufNode, gainNode });
          })
          .catch(() => {});
      } else if (!isActive && wasActive) {
        const entry = activeNarrationRef.current.get(clip.id);
        if (entry) {
          try { entry.bufNode.stop(); } catch {}
          try { entry.bufNode.disconnect(); } catch {}
          try { entry.gainNode.disconnect(); } catch {}
          activeNarrationRef.current.delete(clip.id);
        }
      }
    }
    drawFrame(t);
    rafIdRef.current = requestAnimationFrame(rafCallbackRef.current);
  }, [drawFrame]);

  useEffect(() => { rafCallbackRef.current = rafLoop; }, [rafLoop]);

  useEffect(() => {
    if (isPlaying) {
      lastRafTimeRef.current = null;
      rafIdRef.current = requestAnimationFrame(rafLoop);
      // Spawn narration audio for any clips already active at the current playhead
      const t = playheadRef.current;
      for (const clip of clipsRef.current) {
        if (clip.type !== "narration") continue;
        if (t < clip.startTime || t >= clip.startTime + clip.duration) continue;
        if (activeNarrationRef.current.has(clip.id)) continue;
        const clipId = clip.id;
        const blobUrl = clip.sourceUrl;
        const clipOffset = t - clip.startTime;
        let ctx = audioCtxRef.current;
        if (!ctx || ctx.state === "closed") { ctx = new AudioContext(); audioCtxRef.current = ctx; }
        const audioCtxCapture = ctx;
        fetch(blobUrl)
          .then((r) => r.arrayBuffer())
          .then((ab) => audioCtxCapture.decodeAudioData(ab))
          .then((buffer) => {
            if (!isPlayingRef.current || activeNarrationRef.current.has(clipId)) return;
            const gainNode = audioCtxCapture.createGain();
            gainNode.gain.value = clip.muted ? 0 : (clip.volume ?? 1);
            gainNode.connect(audioCtxCapture.destination);
            const bufNode = audioCtxCapture.createBufferSource();
            bufNode.buffer = buffer;
            bufNode.connect(gainNode);
            bufNode.start(0, Math.min(Math.max(0, clipOffset), Math.max(0, buffer.duration - 0.01)));
            bufNode.onended = () => activeNarrationRef.current.delete(clipId);
            activeNarrationRef.current.set(clipId, { bufNode, gainNode });
          })
          .catch(() => {});
      }
    } else {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null;
      // Switch off every clip's video (paused clips render their frozen thumbnail)
      for (const nodes of videoAudioNodesRef.current.values()) { try { nodes.gainNode.gain.value = 0; } catch {} }
      for (const vid of videoElsRef.current.values()) { vid.pause(); }
      // Stop all active narration audio
      for (const clipId of [...activeNarrationRef.current.keys()]) {
        const entry = activeNarrationRef.current.get(clipId);
        if (entry) {
          try { entry.bufNode.stop(); } catch {}
          try { entry.bufNode.disconnect(); } catch {}
          try { entry.gainNode.disconnect(); } catch {}
        }
      }
      activeNarrationRef.current.clear();
    }
    return () => { if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); };
  }, [isPlaying, rafLoop]);

  useEffect(() => { if (!isPlaying) drawFrame(playhead); }, [playhead, clips, annotations, canvasAspect, isPlaying, drawFrame]);

  // ─ Media loading ──────────────────────────────────────────────────────────

  function loadMedia(url: string, type: "image" | "video") {
    if (type === "image") {
      if (!imgCacheRef.current.has(url)) {
        const img = new Image();
        img.onload = () => drawFrame(playheadRef.current);
        img.src = url;
        imgCacheRef.current.set(url, img);
      }
    }
    // Video: per-clip elements are created by createVideoElement instead
  }

  async function captureVideoThumbnail(clipId: string, srcUrl: string): Promise<void> {
    if (thumbnailImagesRef.current.has(clipId)) return; // already captured or pre-set (pasted clip)
    try {
      // Use a SEPARATE temp element so we never seek the live per-clip playback element
      const tmpVid = document.createElement("video");
      tmpVid.preload = "auto";
      tmpVid.muted = true;
      tmpVid.crossOrigin = "anonymous";
      tmpVid.src = srcUrl;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 8000);
        tmpVid.addEventListener("canplay", () => { clearTimeout(timer); resolve(); }, { once: true });
        tmpVid.addEventListener("error", () => { clearTimeout(timer); reject(tmpVid.error); }, { once: true });
      });
      const seekTime = isFinite(tmpVid.duration) && tmpVid.duration < 1 ? 0 : 0.1;
      tmpVid.currentTime = seekTime;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("seeked timeout")), 5000);
        tmpVid.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      const w = tmpVid.videoWidth || 640;
      const h = tmpVid.videoHeight || 360;
      // Register natural dimensions for this URL if not yet known
      if (w > 0 && !videoDimsRef.current.has(srcUrl)) {
        const scale = Math.min(1, 800 / w, 600 / h);
        videoDimsRef.current.set(srcUrl, { w: Math.round(w * scale), h: Math.round(h * scale) });
      }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) throw new Error("no 2d ctx");
      ctx2d.drawImage(tmpVid, 0, 0, w, h);
      tmpVid.src = ""; // release temp element
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (!blob) throw new Error("toBlob failed");
      const thumbUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.src = thumbUrl;
      await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); });
      thumbnailImagesRef.current.set(clipId, img);
      setClips((prev) => prev.map((c) => c.id === clipId ? { ...c, thumbnailBlobUrl: thumbUrl } : c));
    } catch {
      thumbnailImagesRef.current.set(clipId, null); // mark failed — renders black box fallback
    }
  }

  // Creates a dedicated video element per clip.id — one element per clipId, never shared
  // Creates a dedicated <video> element for this clip.id. Duplicates (paste/drag from library)
  // get their own independent element sharing the same src — never a shared/cached element.
  // Stays switched OFF (paused) until the RAF loop or togglePlay switches it on for entry.
  function createVideoElement(clipId: string, url: string): HTMLVideoElement {
    const existing = videoElsRef.current.get(clipId);
    if (existing) return existing;
    const vid = document.createElement("video");
    vid.muted = false;
    vid.loop = false;
    vid.preload = "auto";
    vid.playsInline = true;
    vid.crossOrigin = "anonymous"; // must be set before src so the request is made with CORS mode
    vid.src = url;
    vid.style.position = "absolute";
    vid.style.left = "-9999px";
    vid.style.top = "-9999px";
    vid.onloadeddata = () => drawFrame(playheadRef.current);
    vid.addEventListener("loadedmetadata", () => {
      if (vid.videoWidth > 0 && !videoDimsRef.current.has(url)) {
        const scale = Math.min(1, 800 / vid.videoWidth, 600 / vid.videoHeight);
        videoDimsRef.current.set(url, { w: Math.round(vid.videoWidth * scale), h: Math.round(vid.videoHeight * scale) });
      }
    }, { once: true });
    videoHiddenContainerRef.current?.appendChild(vid);
    videoElsRef.current.set(clipId, vid);
    videoRangeStateRef.current.set(clipId, false);
    videoStuckFrameCountRef.current.set(clipId, 0);
    // Warm the decoder now (silent play→pause) so the element's first real entry has a
    // drawable frame ready instead of showing the thumbnail while its audio already plays.
    // Also covers autoplay unlock for elements created after the session's first Play click
    // (e.g. a background YouTube download finishing mid-session).
    prewarmVideoElement(clipId, vid);
    captureVideoThumbnail(clipId, url); // fire-and-forget; uses a separate temp element, never seeks vid
    return vid;
  }

  function getVisibleBoardCenter(): { camX: number; camY: number } {
    const container = boardContainerRef.current;
    if (!container) return { camX: BOARD_W / 2, camY: BOARD_H / 2 };
    const { width, height } = container.getBoundingClientRect();
    const zoom = boardZoomRef.current;
    const pan = boardPanRef.current;
    return {
      camX: clamp((width / 2 - pan.x) / zoom, 0, BOARD_W),
      camY: clamp((height / 2 - pan.y) / zoom, 0, BOARD_H),
    };
  }

  function getMediaDimensions(url: string, type: "image" | "video"): { w: number; h: number } {
    if (type === "image") {
      const img = imgCacheRef.current.get(url);
      if (img && img.naturalWidth > 0) {
        const scale = Math.min(1, 800 / img.naturalWidth, 600 / img.naturalHeight);
        return { w: Math.round(img.naturalWidth * scale), h: Math.round(img.naturalHeight * scale) };
      }
    } else {
      const dims = videoDimsRef.current.get(url);
      if (dims) return dims;
      return { w: 800, h: 450 };
    }
    return { w: 800, h: 600 };
  }

  async function addClipAndPlaceOnBoard(item: MediaItem) {
    // Wait for image to load so we get natural dimensions
    if (item.type === "image") {
      const img = imgCacheRef.current.get(item.url);
      if (img && !img.complete) {
        await new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        });
      }
    }
    const { w, h } = getMediaDimensions(item.url, item.type);
    const { camX, camY } = getVisibleBoardCenter();
    const clipId = generateId();
    const clipDuration = item.duration ?? (item.type === "video" ? 5 : 4);
    if (item.type === "video") createVideoElement(clipId, item.url);
    setClips((prev) => {
      const endTime = prev.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
      const layer = freeLayerAtTime(prev, endTime, clipDuration, clipId, 1);
      const pos = findFreeBoardPos(prev, w, h, camX, camY);
      return [
        ...prev,
        {
          id: clipId, type: item.type, name: item.name, sourceUrl: item.url,
          startTime: endTime, duration: clipDuration, layer,
          boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h,
          sourceDurationSec: item.type === "video" ? item.duration : undefined,
          sourceBlob: item.type === "video" ? item.blob : undefined,
        },
      ];
    });
    setSelectedClipId(clipId);
  }

  function deleteClip(clipId: string) {
    const vid = videoElsRef.current.get(clipId);
    if (vid) {
      vid.pause(); vid.src = "";
      if (videoHiddenContainerRef.current?.contains(vid)) videoHiddenContainerRef.current.removeChild(vid);
      videoElsRef.current.delete(clipId);
    }
    videoRangeStateRef.current.delete(clipId);
    videoStuckFrameCountRef.current.delete(clipId);
    const audioNodes = videoAudioNodesRef.current.get(clipId);
    if (audioNodes) {
      try { audioNodes.gainNode.gain.value = 0; audioNodes.sourceNode.disconnect(); audioNodes.gainNode.disconnect(); } catch {}
      videoAudioNodesRef.current.delete(clipId);
    }
    const clip = clipsRef.current.find((c) => c.id === clipId);
    // Every video clip now owns an independent blob (Step 16.12) — the only exception is a
    // clip still using the original upload's URL, which the media library needs to keep alive
    // so the same file can be dragged onto the board again later.
    if (clip?.type === "video" && clip.sourceUrl) {
      const stillInLibrary = mediaLibrary.some((m) => m.url === clip.sourceUrl);
      if (!stillInLibrary) URL.revokeObjectURL(clip.sourceUrl);
    }
    // Revoke thumbnail blob only if no other clip shares the same thumbnailBlobUrl
    if (clip?.thumbnailBlobUrl) {
      const thumbRefs = clipsRef.current.filter((c) => c.id !== clipId && c.thumbnailBlobUrl === clip.thumbnailBlobUrl);
      if (thumbRefs.length === 0) URL.revokeObjectURL(clip.thumbnailBlobUrl);
    }
    thumbnailImagesRef.current.delete(clipId);
    if (clip?.type === "narration") {
      stopNarrationAudio(clipId);
      URL.revokeObjectURL(clip.sourceUrl);
    }
    setClips((prev) => prev.filter((c) => c.id !== clipId));
    setSelectedClipIds((prev) => prev.filter((id) => id !== clipId));
    selectedClipIdsRef.current = selectedClipIdsRef.current.filter((id) => id !== clipId);
    setSelectedClipId((prev) => (prev === clipId ? null : prev));
  }

  function addPanClip(atTime?: number) {
    const id = generateId();
    const startTime = atTime ?? clipsRef.current.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const clip: Clip = { id, type: "pan", name: "Pan", sourceUrl: "", startTime, duration: 5, holdFraction: 0.5, layer: 1 };
    setClips((prev) => [...prev, clip]);
    setSelectedClipId(id);
    if (cameraKeyframesRef.current.length > 0) setKeyframesOutOfDate(true);
  }

  function copyClip(clipId: string) {
    const clip = clipsRef.current.find((c) => c.id === clipId);
    if (!clip) return;
    clipboardRef.current = { ...clip };
    setClipboardReady(true);
  }

  // Clones the underlying video bytes into a brand-new, independent Blob (+ object URL) so a
  // duplicate's <video> element gets its own genuinely separate source instead of sharing one
  // blob URL with the original — Chrome only renders live frames for the most recently active
  // of several elements pointed at the same blob URL, which showed as duplicates freezing on
  // their thumbnail while their audio still played. Falls back to sharing the original URL if
  // cloning fails (e.g. out of memory on a very large source) — not fatal, just re-exposes the
  // old shared-decoder limitation for that one duplicate.
  async function cloneVideoSource(clip: Clip): Promise<{ sourceUrl: string; sourceBlob?: Blob }> {
    if (!clip.sourceBlob) return { sourceUrl: clip.sourceUrl, sourceBlob: clip.sourceBlob };
    try {
      const arrayBuffer = await clip.sourceBlob.arrayBuffer();
      const clonedBlob = new Blob([arrayBuffer], { type: clip.sourceBlob.type });
      return { sourceUrl: URL.createObjectURL(clonedBlob), sourceBlob: clonedBlob };
    } catch {
      return { sourceUrl: clip.sourceUrl, sourceBlob: clip.sourceBlob };
    }
  }

  async function pasteClip() {
    const src = clipboardRef.current;
    if (!src) return;
    const startTime = playheadRef.current;
    const newId = generateId();
    const cloned = src.type === "video" ? await cloneVideoSource(src) : null;
    // Recompute against the freshest clips (cloning is async and other edits may land meanwhile)
    const layer = freeLayerAtTime(clipsRef.current, startTime, src.duration, "", src.layer ?? 1);
    const newClip: Clip = {
      ...src, id: newId, startTime, layer,
      ...(cloned ? { sourceUrl: cloned.sourceUrl, sourceBlob: cloned.sourceBlob } : {}),
    };
    if (src.type === "video") {
      // Pre-set thumbnail so createVideoElement skips re-capture (same source video)
      const srcThumb = thumbnailImagesRef.current.get(src.id);
      if (srcThumb !== undefined) thumbnailImagesRef.current.set(newClip.id, srcThumb);
      createVideoElement(newClip.id, newClip.sourceUrl);
    }
    setClips((prev) => [...prev, newClip]);
    setSelectedClipId(newClip.id);
  }

  async function duplicateClip(clipId: string) {
    const clip = clipsRef.current.find((c) => c.id === clipId);
    if (!clip) return;
    const startTime = clip.startTime + clip.duration;
    const newId = generateId();
    const cloned = clip.type === "video" ? await cloneVideoSource(clip) : null;
    const layer = freeLayerAtTime(clipsRef.current, startTime, clip.duration, "", clip.layer ?? 1);
    const newClip: Clip = {
      ...clip, id: newId, startTime, layer,
      ...(cloned ? { sourceUrl: cloned.sourceUrl, sourceBlob: cloned.sourceBlob } : {}),
    };
    if (clip.type === "video") {
      // Pre-set thumbnail so createVideoElement skips re-capture (same source video)
      const srcThumb = thumbnailImagesRef.current.get(clip.id);
      if (srcThumb !== undefined) thumbnailImagesRef.current.set(newClip.id, srcThumb);
      createVideoElement(newClip.id, newClip.sourceUrl);
    }
    setClips((prev) => [...prev, newClip]);
    setSelectedClipId(newClip.id);
  }

  // ─ Narration audio helpers ────────────────────────────────────────────────

  function stopNarrationAudio(clipId: string) {
    const entry = activeNarrationRef.current.get(clipId);
    if (!entry) return;
    try { entry.bufNode.stop(); } catch {}
    try { entry.bufNode.disconnect(); } catch {}
    try { entry.gainNode.disconnect(); } catch {}
    activeNarrationRef.current.delete(clipId);
  }

  function stopAllNarrationAudio() {
    for (const clipId of [...activeNarrationRef.current.keys()]) stopNarrationAudio(clipId);
  }

  async function generateNarrationWaveform(blobUrl: string): Promise<number[]> {
    const ctx = new AudioContext();
    try {
      const ab = await fetch(blobUrl).then((r) => r.arrayBuffer());
      const buffer = await ctx.decodeAudioData(ab);
      const data = buffer.getChannelData(0);
      const SAMPLES = 80;
      const blockSize = Math.max(1, Math.floor(data.length / SAMPLES));
      const peaks: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        let max = 0;
        for (let j = 0; j < blockSize; j++) {
          const v = Math.abs(data[i * blockSize + j] ?? 0);
          if (v > max) max = v;
        }
        peaks.push(max);
      }
      return peaks;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  // ─ Narration recording ────────────────────────────────────────────────────

  async function startNarrationRecording() {
    if (isRecordingRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      micChunksRef.current = [];
      micStartSecRef.current = playheadRef.current;
      micStartWallRef.current = performance.now();
      setRecElapsed(0);
      function elapsedTick() {
        setRecElapsed((performance.now() - micStartWallRef.current) / 1000);
        micRafRef.current = requestAnimationFrame(elapsedTick);
      }
      micRafRef.current = requestAnimationFrame(elapsedTick);
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      micRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) micChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        micStreamRef.current?.getTracks().forEach((t) => t.stop());
        if (micRafRef.current !== null) { cancelAnimationFrame(micRafRef.current); micRafRef.current = null; }
        const blob = new Blob(micChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const blobUrl = URL.createObjectURL(blob);
        const dur: number = await new Promise((resolve) => {
          const audio = new Audio(blobUrl);
          audio.onloadedmetadata = () => resolve(isFinite(audio.duration) ? audio.duration : 1);
          audio.onerror = () => resolve(1);
        });
        if (dur < 0.1) { URL.revokeObjectURL(blobUrl); return; }
        const waveform = await generateNarrationWaveform(blobUrl).catch(() => undefined);
        setClips((prev) => [...prev, {
          id: generateId(),
          type: "narration" as const,
          name: "Narration",
          sourceUrl: blobUrl,
          audioBlob: blob,
          startTime: micStartSecRef.current,
          duration: dur,
          waveform,
        }]);
      };
      recorder.start();
      setIsRecording(true);
    } catch (e) {
      if (micRafRef.current !== null) { cancelAnimationFrame(micRafRef.current); micRafRef.current = null; }
      setToast(e instanceof Error ? e.message : "Microphone access denied");
    }
  }

  function stopNarrationRecording() {
    if (micRecorderRef.current?.state === "recording") micRecorderRef.current.stop();
    if (micRafRef.current !== null) { cancelAnimationFrame(micRafRef.current); micRafRef.current = null; }
    setIsRecording(false);
  }

  async function handleNarrationUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const isVideoFile = file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(file.name);
    setToast("Processing audio…");
    try {
      let blobUrl: string;
      let audioBlob: Blob;
      if (isVideoFile) {
        // Extract just the audio track from the video container
        const arrayBuffer = await file.arrayBuffer();
        const tmpCtx = new AudioContext();
        const audioBuffer = await tmpCtx.decodeAudioData(arrayBuffer);
        await tmpCtx.close().catch(() => {});
        const wavBlob = audioBufferToWav(audioBuffer);
        blobUrl = URL.createObjectURL(wavBlob);
        audioBlob = wavBlob;
      } else {
        audioBlob = file;
        blobUrl = URL.createObjectURL(file);
      }
      const dur: number = await new Promise((resolve) => {
        const audio = new Audio(blobUrl);
        audio.onloadedmetadata = () => resolve(isFinite(audio.duration) ? audio.duration : 1);
        audio.onerror = () => resolve(1);
      });
      if (dur < 0.1) { URL.revokeObjectURL(blobUrl); setToast("No audio found in file"); return; }
      const waveform = await generateNarrationWaveform(blobUrl).catch(() => undefined);
      setClips((prev) => [...prev, {
        id: generateId(),
        type: "narration" as const,
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 40),
        sourceUrl: blobUrl,
        audioBlob,
        startTime: playheadRef.current,
        duration: dur,
        waveform,
      }]);
      setToast(isVideoFile ? "Audio extracted from video" : "Narration added");
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Failed to process file");
    }
  }

  // ─ Media upload ───────────────────────────────────────────────────────────

  async function handleMediaUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const type: "image" | "video" = file.type.startsWith("video") ? "video" : "image";
      loadMedia(url, type);
      let duration: number | undefined;
      if (type === "video") {
        const meta = await getVideoMeta(url);
        duration = meta.duration;
        if (meta.w > 0 && !videoDimsRef.current.has(url)) {
          const scale = Math.min(1, 800 / meta.w, 600 / meta.h);
          videoDimsRef.current.set(url, { w: Math.round(meta.w * scale), h: Math.round(meta.h * scale) });
        }
      }
      const item: MediaItem = { id: generateId(), name: file.name, type, url, duration, blob: type === "video" ? file : undefined };
      setMediaLibrary((prev) => [...prev, item]);
      await addClipAndPlaceOnBoard(item);
    }
  }

  // ─ YouTube ────────────────────────────────────────────────────────────────

  async function handleYtSearch(shortsOnlyOverride?: boolean) {
    if (!ytQuery.trim()) return;
    setYtLoading(true); setYtError(""); setYtResults([]);
    try {
      const res = await fetch("/api/yt-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: ytQuery, limit: 12, shortsOnly: shortsOnlyOverride !== undefined ? shortsOnlyOverride : ytShortsOnly }),
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      setYtResults(Array.isArray(data) ? data : []);
    } catch (e) {
      setYtError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setYtLoading(false);
    }
  }

  function handleYtPasteUrl() {
    const videoId = extractYouTubeId(ytUrlInput.trim());
    if (!videoId) { setYtError("Couldn't find a YouTube video ID in that URL"); return; }
    setYtError("");
    setYtSelected({ id: videoId, title: "YouTube clip", channel: "", duration: 600, thumbnail: "" });
    setYtStart(0); setYtStartInput("0:00");
    setYtEnd(30); setYtEndInput("0:30");
    ytRangeRef.current = { start: 0, end: 30 };
    setYtView("trim");
  }

  function handleYtConfirm() {
    if (!ytSelected) return;
    const ytSel = ytSelected;
    const start = ytStart, end = ytEnd;
    const title = (ytSel.title ?? "YouTube clip").slice(0, 40);
    // Set when this download originated from a Neural Search placeholder click — reuse its
    // board position instead of auto-placing, and remove it once the real clip lands.
    const sourcePlaceholderId = ytSel.placeholderId;
    const placeholderBoardX = ytSel.boardX;
    const placeholderBoardY = ytSel.boardY;

    // Close the modal instantly — download continues in the background via a toast
    setYtModalOpen(false);
    setYtView("search"); setYtTab("search"); setYtSelected(null);
    setYtResults([]); setYtQuery(""); setYtUrlInput(""); setYtError("");

    const toastId = generateId();
    setDownloadToasts((prev) => [...prev, { id: toastId, title, status: "downloading" }]);

    (async () => {
      try {
        const url = `https://www.youtube.com/watch?v=${ytSel.id}`;
        const dlRes = await fetch("/api/ytdl", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, start, end }),
        });
        if (!dlRes.ok) {
          const err = await dlRes.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error || `Download failed (${dlRes.status})`);
        }
        const blob = await dlRes.blob();
        const blobUrl = URL.createObjectURL(blob);
        const clipDuration = end - start;
        const clipId = generateId();

        const vid = createVideoElement(clipId, blobUrl);

        // Wait for metadata to get natural dimensions + source duration
        const meta = await new Promise<{ w: number; h: number; sourceDurationSec: number }>((resolve) => {
          const timer = setTimeout(() => resolve({ w: 800, h: 450, sourceDurationSec: clipDuration }), 3000);
          vid.addEventListener("loadedmetadata", () => {
            clearTimeout(timer);
            const sourceDurationSec = isFinite(vid.duration) ? vid.duration : clipDuration;
            if (vid.videoWidth > 0 && vid.videoHeight > 0) {
              const scale = Math.min(1, 800 / vid.videoWidth, 600 / vid.videoHeight);
              resolve({ w: Math.round(vid.videoWidth * scale), h: Math.round(vid.videoHeight * scale), sourceDurationSec });
            } else {
              resolve({ w: 800, h: 450, sourceDurationSec });
            }
          }, { once: true });
        });

        // Register dimensions so getMediaDimensions can use them for future duplicates
        if (meta.w > 0 && !videoDimsRef.current.has(blobUrl)) {
          videoDimsRef.current.set(blobUrl, { w: meta.w, h: meta.h });
        }
        const { camX, camY } = getVisibleBoardCenter();
        setClips((prev) => {
          const endTime = prev.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
          const layer = freeLayerAtTime(prev, endTime, clipDuration, clipId, 1);
          const pos = (placeholderBoardX !== undefined && placeholderBoardY !== undefined)
            ? { boardX: placeholderBoardX, boardY: placeholderBoardY }
            : findFreeBoardPos(prev, meta.w, meta.h, camX, camY);
          return [...prev, {
            id: clipId, type: "video" as const, name: title, sourceUrl: blobUrl,
            startTime: endTime, duration: clipDuration, layer,
            boardX: pos.boardX, boardY: pos.boardY, boardW: meta.w, boardH: meta.h,
            sourceDurationSec: meta.sourceDurationSec,
            sourceBlob: blob,
            youtubeId: ytSel.id, ytStart: start, ytEnd: end,
          }];
        });
        setSelectedClipId(clipId);
        if (sourcePlaceholderId) {
          setNeuralPlaceholders((prev) => prev.filter((p) => p.id !== sourcePlaceholderId));
        }

        setDownloadToasts((prev) => prev.map((t) => t.id === toastId ? { ...t, status: "done" } : t));
        setTimeout(() => setDownloadToasts((prev) => prev.filter((t) => t.id !== toastId)), 2000);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Download failed";
        setDownloadToasts((prev) => prev.map((t) => t.id === toastId ? { ...t, status: "error", error: message } : t));
        setTimeout(() => setDownloadToasts((prev) => prev.filter((t) => t.id !== toastId)), 5000);
      }
    })();
  }

  // ─ Neural Search ──────────────────────────────────────────────────────────

  async function runNeuralSearch() {
    const concept = neuralConcept.trim();
    if (!concept) return;
    setNeuralError("");
    setNeuralPhase("Analyzing concept...");
    // The API call is a single round trip — stage the copy so the wait doesn't feel opaque.
    const t1 = setTimeout(() => setNeuralPhase("Searching YouTube..."), 1800);
    const t2 = setTimeout(() => setNeuralPhase("Ranking by popularity..."), 5000);
    try {
      const res = await fetch("/api/neural-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Search failed (${res.status})`);
      }
      const data = await res.json() as {
        videos: Array<{ videoId: string; title: string; channel: string; thumbnailUrl: string; viewCount: number; durationSec: number }>;
        images: Array<{ imageUrl: string; title: string; sourceUrl: string }>;
      };
      const videos = Array.isArray(data.videos) ? data.videos : [];
      const images = Array.isArray(data.images) ? data.images : [];
      if (videos.length === 0 && images.length === 0) {
        setNeuralError("Nothing found — try describing the concept differently");
        return;
      }

      // Place every candidate (videos + images) on the board through one shared occupied-rect
      // list, avoiding overlap with existing clips, existing placeholders, and each other — and
      // so the two types end up mixed spatially rather than videos landing in one cluster.
      const { camX, camY } = getVisibleBoardCenter();
      const occupied: Array<{ boardX?: number; boardY?: number; boardW?: number; boardH?: number }> =
        [...clipsRef.current, ...neuralPlaceholders, ...imagePlaceholders];
      const newVideoPlaceholders: NeuralPlaceholder[] = videos.map((v) => {
        const w = 800, h = 450;
        const pos = findFreeBoardPos(occupied, w, h, camX, camY);
        occupied.push({ boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h });
        return {
          id: generateId(), boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h,
          videoId: v.videoId, title: v.title, channel: v.channel, thumbnailUrl: v.thumbnailUrl,
          viewCount: v.viewCount, durationSec: v.durationSec,
        };
      });
      const newImagePlaceholders: ImagePlaceholder[] = images.map((img) => {
        const w = 600, h = 400;
        const pos = findFreeBoardPos(occupied, w, h, camX, camY);
        occupied.push({ boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h });
        return {
          id: generateId(), boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h,
          imageUrl: img.imageUrl, title: img.title, sourceUrl: img.sourceUrl,
        };
      });
      setNeuralPlaceholders((prev) => [...prev, ...newVideoPlaceholders]);
      setImagePlaceholders((prev) => [...prev, ...newImagePlaceholders]);
      setNeuralModalOpen(false);
      setNeuralConcept("");
    } catch (e) {
      setNeuralError(e instanceof Error ? e.message : "Search failed");
    } finally {
      clearTimeout(t1); clearTimeout(t2);
      setNeuralPhase(null);
    }
  }

  function removeNeuralPlaceholder(id: string) {
    setNeuralPlaceholders((prev) => prev.filter((p) => p.id !== id));
  }

  // ─ Top 5 Neural Search ────────────────────────────────────────────────────

  async function runTop5Search() {
    const concept = top5Concept.trim();
    if (!concept) return;
    setTop5Error("");
    setTop5Phase("Generating list...");
    const t1 = setTimeout(() => setTop5Phase("Searching videos..."), 4000);
    const t2 = setTimeout(() => setTop5Phase("Arranging on board..."), 10000);
    try {
      const res = await fetch("/api/top5-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Search failed (${res.status})`);
      }
      const data = await res.json() as {
        title: string;
        items: Array<{
          rank: number;
          label: string;
          blurb: string;
          videos: Array<{ videoId: string; title: string; channel: string; thumbnailUrl: string; viewCount: number; durationSec: number }>;
        }>;
      };

      if (!data.items || data.items.length === 0) {
        setTop5Error("Nothing found — try a different concept");
        return;
      }

      // ── Column layout constants ──────────────────────────────────────────
      // 5 columns, each 750px wide, rank #5 on the left → rank #1 on the right
      const COL_STRIDE = 750;
      const COL_START_X = 100;
      const TITLE_Y = 60;
      const RANK_Y = 280;        // y of the big rank number (#5, #4, …)
      const LABEL_Y = 450;       // y of the item label below the rank number
      const VIDEO_Y_START = 540; // y of first video placeholder
      const VIDEO_GAP = 30;      // gap between stacked videos
      const VIDEO_W = 700;
      const VIDEO_H = 400;
      const VIDEO_X_PAD = 25;    // padding from column left edge

      const RANK_COLORS: Record<number, string> = {
        5: "#7c3d1a",  // brown
        4: "#d4651e",  // orange
        3: "#cc2200",  // red
        2: "#b00000",  // bold red
        1: "#c49a00",  // gold
      };

      const newAnnotations: Annotation[] = [];

      // Title annotation spanning all columns
      newAnnotations.push({
        id: generateId(),
        type: "text",
        boardX: COL_START_X,
        boardY: TITLE_Y,
        boardW: 3800,
        boardH: 250,
        color: "#cc2200",
        text: data.title,
        fontFamily: "Permanent Marker",
        fontSize: 180,
        fontWeight: "bold",
      });

      const newPlaceholders: NeuralPlaceholder[] = [];

      // items arrive sorted rank 5→1 from API
      data.items.forEach((item) => {
        const rankIndex = 5 - item.rank; // 0=rank5, 4=rank1
        const colX = COL_START_X + rankIndex * COL_STRIDE;
        const color = RANK_COLORS[item.rank] ?? "#2a2a2a";

        // Big rank number annotation
        newAnnotations.push({
          id: generateId(),
          type: "text",
          boardX: colX,
          boardY: RANK_Y,
          boardW: VIDEO_W,
          boardH: 180,
          color,
          text: `#${item.rank}`,
          fontFamily: "Permanent Marker",
          fontSize: item.rank === 2 ? 150 : 140,
          fontWeight: item.rank <= 2 ? "bold" : "normal",
        });

        // Item label annotation
        newAnnotations.push({
          id: generateId(),
          type: "text",
          boardX: colX,
          boardY: LABEL_Y,
          boardW: VIDEO_W,
          boardH: 80,
          color: "#2a2a2a",
          text: item.label,
          fontFamily: "Caveat",
          fontSize: 60,
          fontWeight: "normal",
        });

        // Video placeholders for this rank
        item.videos.forEach((v, vi) => {
          const boardY = VIDEO_Y_START + vi * (VIDEO_H + VIDEO_GAP);
          newPlaceholders.push({
            id: generateId(),
            boardX: colX + VIDEO_X_PAD,
            boardY,
            boardW: VIDEO_W,
            boardH: VIDEO_H,
            videoId: v.videoId,
            title: v.title,
            channel: v.channel,
            thumbnailUrl: v.thumbnailUrl,
            viewCount: v.viewCount,
            durationSec: v.durationSec,
          });
        });
      });

      setAnnotations((prev) => [...prev, ...newAnnotations]);
      setNeuralPlaceholders((prev) => [...prev, ...newPlaceholders]);
      setTop5ModalOpen(false);
      setTop5Concept("");
    } catch (e) {
      setTop5Error(e instanceof Error ? e.message : "Search failed");
    } finally {
      clearTimeout(t1); clearTimeout(t2);
      setTop5Phase(null);
    }
  }

  // ─ Mobile Top 5 Tinder flow ──────────────────────────────────────────────

  async function runMobileTop5Search() {
    const concept = mobileTop5Concept.trim();
    if (!concept) return;
    setMobileTop5Error("");
    setMobileTop5Screen("loading");
    try {
      const res = await fetch("/api/top5-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Search failed (${res.status})`);
      }
      const data = await res.json() as { title: string; items: Array<{ rank: number; label: string; blurb: string; videos: Array<{ videoId: string; title: string; channel: string; thumbnailUrl: string; viewCount: number; durationSec: number }> }> };
      if (!data.items || data.items.length === 0) throw new Error("Nothing found — try a different concept");

      setMobileTop5Data(data);

      const byRank = new Map<number, typeof data.items[0]["videos"]>();
      const idxByRank = new Map<number, number>();
      data.items.forEach((item) => {
        byRank.set(item.rank, item.videos);
        idxByRank.set(item.rank, 0);
      });
      setMobileTop5ResultsByRank(byRank);
      setMobileTop5IndexByRank(idxByRank);

      const firstRankData = data.items.find((i) => i.rank === 5);
      const firstDur = firstRankData?.videos[0]?.durationSec ?? 30;
      setMobileTop5TrimStart(0);
      setMobileTop5TrimEnd(Math.min(30, firstDur));
      setMobileTop5CurrentRank(5);
      setMobileTop5AcceptedByRank(new Map());
      setMobileTop5Screen("swipe");
    } catch (e) {
      setMobileTop5Error(e instanceof Error ? e.message : "Search failed");
      setMobileTop5Screen("prompt");
    }
  }

  function getMobileCurrentVideo() {
    const results = mobileTop5ResultsByRank.get(mobileTop5CurrentRank) ?? [];
    const index = mobileTop5IndexByRank.get(mobileTop5CurrentRank) ?? 0;
    return results[index] ?? null;
  }

  function advanceMobileToNextRank(accepted: Map<number, { videoId: string; trimStart: number; trimEnd: number; title: string }>) {
    const nextRank = mobileTop5CurrentRank - 1;
    if (nextRank < 1) {
      setMobileTop5AcceptedByRank(accepted);
      buildMobileTop5Video(accepted);
    } else {
      setMobileTop5CurrentRank(nextRank);
      const nextResults = mobileTop5ResultsByRank.get(nextRank) ?? [];
      const nextDur = nextResults[0]?.durationSec ?? 30;
      setMobileTop5TrimStart(0);
      setMobileTop5TrimEnd(Math.min(30, nextDur));
    }
  }

  function handleMobileAccept() {
    const video = getMobileCurrentVideo();
    if (!video || mobileTop5LoadingRank !== null) return;
    setMobileTop5CardAnim("accept");
    setTimeout(() => {
      setMobileTop5CardAnim(null);
      const newAccepted = new Map(mobileTop5AcceptedByRank);
      newAccepted.set(mobileTop5CurrentRank, {
        videoId: video.videoId,
        trimStart: mobileTop5TrimStart,
        trimEnd: mobileTop5TrimEnd,
        title: video.title,
      });
      setMobileTop5AcceptedByRank(newAccepted);
      advanceMobileToNextRank(newAccepted);
    }, 320);
  }

  function handleMobileReject() {
    const results = mobileTop5ResultsByRank.get(mobileTop5CurrentRank) ?? [];
    if (mobileTop5LoadingRank !== null) return;
    setMobileTop5CardAnim("reject");
    setTimeout(() => {
      setMobileTop5CardAnim(null);
      const currentIdx = mobileTop5IndexByRank.get(mobileTop5CurrentRank) ?? 0;
      const nextIdx = currentIdx + 1;
      if (nextIdx < results.length) {
        const nextDur = results[nextIdx]?.durationSec ?? 30;
        setMobileTop5TrimStart(0);
        setMobileTop5TrimEnd(Math.min(30, nextDur));
        setMobileTop5IndexByRank((prev) => {
          const m = new Map(prev);
          m.set(mobileTop5CurrentRank, nextIdx);
          return m;
        });
      } else {
        // Exhausted results — fetch more for this rank
        const label = mobileTop5Data?.items.find((i) => i.rank === mobileTop5CurrentRank)?.label ?? "";
        fetchMoreMobileVideos(mobileTop5CurrentRank, label);
      }
    }, 320);
  }

  async function fetchMoreMobileVideos(rank: number, label: string) {
    setMobileTop5LoadingRank(rank);
    try {
      const query = `${label} documentary highlights best moments`;
      const res = await fetch("/api/yt-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 8 }),
      });
      if (!res.ok) return;
      const raw = await res.json() as Array<Record<string, unknown>>;
      const newVideos = (Array.isArray(raw) ? raw : []).map((r) => {
        const dur = r.duration_seconds ?? r.durationSec;
        const durStr = typeof r.duration === "string" ? r.duration : undefined;
        let durationSec = typeof dur === "number" ? dur : 0;
        if (!durationSec && durStr) {
          const parts = durStr.split(":").map(Number);
          if (parts.length === 2) durationSec = (parts[0] || 0) * 60 + (parts[1] || 0);
          else if (parts.length === 3) durationSec = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
        }
        return {
          videoId: (r.id ?? r.videoId) as string,
          title: String(r.title ?? "YouTube clip"),
          channel: String(r.channel ?? r.channelTitle ?? ""),
          thumbnailUrl: String(r.thumbnail ?? r.thumbnailUrl ?? ""),
          viewCount: Number(r.viewCount ?? r.view_count ?? r.views ?? 0),
          durationSec,
        };
      }).filter((v) => !!v.videoId);

      if (newVideos.length > 0) {
        setMobileTop5ResultsByRank((prev) => {
          const m = new Map(prev);
          const existing = m.get(rank) ?? [];
          m.set(rank, [...existing, ...newVideos]);
          return m;
        });
        const nextDur = newVideos[0]?.durationSec ?? 30;
        setMobileTop5TrimStart(0);
        setMobileTop5TrimEnd(Math.min(30, nextDur));
      }
    } finally {
      setMobileTop5LoadingRank(null);
    }
  }

  async function buildMobileTop5Video(accepted: Map<number, { videoId: string; trimStart: number; trimEnd: number; title: string }>) {
    setMobileTop5Screen("build");
    setMobileTop5BuildPhase("Setting up...");

    // Set 9:16 canvas
    setCanvasAspect("9:16");
    canvasWRef.current = CANVAS_H_LAND; // 1080
    canvasHRef.current = CANVAS_W_LAND; // 1920

    const RANK_COLORS: Record<number, string> = {
      5: "#7c3d1a", 4: "#d4651e", 3: "#cc2200", 2: "#b00000", 1: "#c49a00",
    };
    const CLIP_W = 750, CLIP_H = 422;
    const CLIP_STRIDE = CLIP_W + 80;
    const CLIP_START_X = 150;
    const CLIP_Y = 1280;

    // Add rank label annotations
    const newAnnotations: Annotation[] = [];
    for (let rank = 5; rank >= 1; rank--) {
      const i = 5 - rank;
      const colX = CLIP_START_X + i * CLIP_STRIDE;
      const label = mobileTop5Data?.items.find((item) => item.rank === rank)?.label ?? `#${rank}`;
      newAnnotations.push({
        id: generateId(),
        type: "text",
        boardX: colX,
        boardY: CLIP_Y - 220,
        boardW: CLIP_W,
        boardH: 200,
        color: RANK_COLORS[rank] ?? "#2a2a2a",
        text: `#${rank}`,
        fontFamily: "Permanent Marker",
        fontSize: 170,
        fontWeight: "bold",
      });
      newAnnotations.push({
        id: generateId(),
        type: "text",
        boardX: colX,
        boardY: CLIP_Y - 60,
        boardW: CLIP_W,
        boardH: 60,
        color: "#2a2a2a",
        text: label,
        fontFamily: "Caveat",
        fontSize: 48,
        fontWeight: "normal",
      });
    }
    annotationsRef.current = [...annotationsRef.current, ...newAnnotations];
    setAnnotations((prev) => [...prev, ...newAnnotations]);

    const newClips: Clip[] = [];
    const ranks = [5, 4, 3, 2, 1];
    for (let ri = 0; ri < ranks.length; ri++) {
      const rank = ranks[ri];
      const acc = accepted.get(rank);
      if (!acc) continue;
      const i = 5 - rank;
      const colX = CLIP_START_X + i * CLIP_STRIDE;
      const startTime = i * 5;

      setMobileTop5BuildPhase(`Downloading #${rank} (${ri + 1}/5)...`);
      try {
        const dlRes = await fetch("/api/ytdl", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: `https://www.youtube.com/watch?v=${acc.videoId}`,
            start: acc.trimStart,
            end: acc.trimEnd,
          }),
        });
        if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status})`);
        const blob = await dlRes.blob();
        const blobUrl = URL.createObjectURL(blob);
        const clipId = generateId();
        const clipDur = acc.trimEnd - acc.trimStart;
        createVideoElement(clipId, blobUrl);
        const clip: Clip = {
          id: clipId,
          type: "video",
          name: acc.title.slice(0, 40),
          sourceUrl: blobUrl,
          startTime,
          duration: Math.min(clipDur, 5),
          layer: 1,
          boardX: colX,
          boardY: CLIP_Y,
          boardW: CLIP_W,
          boardH: CLIP_H,
          sourceBlob: blob,
          youtubeId: acc.videoId,
          ytStart: acc.trimStart,
          ytEnd: acc.trimEnd,
        };
        newClips.push(clip);
        // Update ref immediately so preview renders each clip as it arrives
        clipsRef.current = [...clipsRef.current, clip];
        setClips((prev) => [...prev, clip]);
      } catch {
        // Continue even if one download fails
      }
    }

    setMobileTop5BuildPhase("Generating camera path...");
    generateCameraKeyframes();

    setMobileTop5BuildPhase(null);
    setMobileTop5Screen("done");
  }

  function renderMobileTop5Flow() {
    const acceptedCount = mobileTop5AcceptedByRank.size;
    const totalRanks = 5;
    const video = getMobileCurrentVideo();
    const currentResults = mobileTop5ResultsByRank.get(mobileTop5CurrentRank) ?? [];
    const currentIdx = mobileTop5IndexByRank.get(mobileTop5CurrentRank) ?? 0;
    const currentItem = mobileTop5Data?.items.find((i) => i.rank === mobileTop5CurrentRank);

    const bg = "#fffdf5";
    const ink = "#2a2a2a";
    const accent = "#c8f135";

    // Card slide animation
    let cardTransform = "translateX(0)";
    let cardOpacity = 1;
    if (mobileTop5CardAnim === "accept") { cardTransform = "translateX(110%)"; cardOpacity = 0; }
    if (mobileTop5CardAnim === "reject") { cardTransform = "translateX(-110%)"; cardOpacity = 0; }

    return (
      <div style={{ position: "fixed", inset: 0, background: bg, fontFamily: "monospace", display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden" }}>
        <style>{`
          @media (orientation: landscape) {
            .m5-landscape-warn { display: flex !important; }
            .m5-portrait-content { display: none !important; }
          }
          @supports not (height: 100dvh) {
            .m5-root { height: 100vh !important; }
          }
        `}</style>

        {/* Landscape warning (hidden by default, shown in landscape via CSS) */}
        <div className="m5-landscape-warn" style={{ display: "none", position: "fixed", inset: 0, zIndex: 9999, background: bg, flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
          <div style={{ fontSize: 40 }}>↕</div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Rotate to portrait</div>
          <div style={{ fontSize: 11, color: "#6a6a6a", textAlign: "center", padding: "0 32px", lineHeight: 1.6 }}>The mobile Top 5 builder works in portrait mode</div>
        </div>

        <div className="m5-portrait-content" style={{ display: "flex", flexDirection: "column", height: "100dvh", paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: `1.5px dashed rgba(42,42,42,0.25)`, flexShrink: 0 }}>
            <span style={{ fontFamily: "'Caveat', cursive", fontSize: 20, fontWeight: 700, color: ink, flex: 1 }}>
              {mobileTop5Screen === "swipe" || mobileTop5Screen === "loading" ? "Top 5 Builder" : mobileTop5Screen === "build" || mobileTop5Screen === "done" ? "Building..." : "Top 5 Builder"}
            </span>
            <button
              onClick={() => setMobileDesktopOverride(true)}
              style={{ fontFamily: "monospace", fontSize: 9, color: "#6a6a6a", background: "transparent", border: "1px solid rgba(42,42,42,0.3)", padding: "4px 8px", cursor: "pointer" }}
            >
              Desktop version
            </button>
          </div>

          {/* Screen 1: Prompt */}
          {mobileTop5Screen === "prompt" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 20, gap: 16, overflowY: "auto" }}>
              <div>
                <div style={{ fontFamily: "'Caveat', cursive", fontSize: 30, fontWeight: 700, color: ink, lineHeight: 1.2, marginBottom: 8 }}>
                  What&apos;s your Top 5?
                </div>
                <div style={{ fontSize: 11, color: "#6a6a6a", lineHeight: 1.5 }}>
                  Describe your concept and we&apos;ll find video candidates for each rank. Swipe right to keep, left to skip.
                </div>
              </div>
              {mobileTop5Error && (
                <div style={{ fontSize: 12, color: "#cc2200", background: "#fff0ee", border: "1px solid #cc2200", padding: "8px 12px" }}>
                  {mobileTop5Error}
                </div>
              )}
              <textarea
                value={mobileTop5Concept}
                onChange={(e) => setMobileTop5Concept(e.target.value)}
                placeholder="e.g. Top 5 conspiracies that turned out to be true"
                style={{
                  flex: 1, minHeight: "36dvh", width: "100%", boxSizing: "border-box",
                  fontFamily: "monospace", fontSize: 15, lineHeight: 1.6,
                  border: "1.5px solid #2a2a2a", padding: 14, resize: "none",
                  background: "#fff",
                } as React.CSSProperties}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runMobileTop5Search(); }}
              />
              <ProGated featureName="Top 5 Neural Search">
                <button
                  onClick={runMobileTop5Search}
                  disabled={!mobileTop5Concept.trim()}
                  style={{
                    width: "100%", padding: 18, fontFamily: "monospace", fontSize: 16, fontWeight: 700,
                    background: mobileTop5Concept.trim() ? ink : "#ccc",
                    color: mobileTop5Concept.trim() ? accent : "#888",
                    border: "none", cursor: mobileTop5Concept.trim() ? "pointer" : "not-allowed",
                    boxShadow: mobileTop5Concept.trim() ? "3px 3px 0 rgba(0,0,0,0.15)" : "none",
                    minHeight: 60,
                  }}
                >
                  Generate →
                </button>
              </ProGated>
            </div>
          )}

          {/* Screen 2: Loading */}
          {mobileTop5Screen === "loading" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24, padding: 32 }}>
              <style>{`@keyframes m5spin { to { transform: rotate(360deg); } } @keyframes m5dot { 0%,80%,100%{opacity:0.2} 40%{opacity:1} }`}</style>
              <div style={{ width: 48, height: 48, borderRadius: "50%", border: "3px solid rgba(42,42,42,0.1)", borderTopColor: ink, animation: "m5spin 0.8s linear infinite" }} />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "'Caveat', cursive", fontSize: 22, fontWeight: 700, color: ink, marginBottom: 6 }}>
                  {mobileTop5Error || "Generating list..."}
                </div>
                <div style={{ fontSize: 11, color: "#6a6a6a" }}>Finding the best video candidates for each rank</div>
              </div>
              <button
                onClick={() => { setMobileTop5Screen("prompt"); setMobileTop5Error(""); }}
                style={{ fontFamily: "monospace", fontSize: 12, background: "transparent", border: "1.5px solid rgba(42,42,42,0.4)", padding: "10px 20px", cursor: "pointer", color: "#6a6a6a" }}
              >
                Cancel
              </button>
            </div>
          )}

          {/* Screen 3: Swipe */}
          {mobileTop5Screen === "swipe" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              {/* Progress bar */}
              <div style={{ padding: "10px 16px 0", flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ fontFamily: "'Caveat', cursive", fontSize: 22, fontWeight: 700, color: ink }}>
                    #{mobileTop5CurrentRank} — {currentItem?.label ?? ""}
                  </div>
                  <div style={{ fontSize: 11, color: "#6a6a6a" }}>{acceptedCount}/{totalRanks}</div>
                </div>
                <div style={{ height: 3, background: "rgba(42,42,42,0.1)", borderRadius: 2 }}>
                  <div style={{ height: "100%", width: `${(acceptedCount / totalRanks) * 100}%`, background: accent, borderRadius: 2, transition: "width 0.3s" }} />
                </div>
                {currentItem?.blurb && (
                  <div style={{ fontSize: 10, color: "#6a6a6a", marginTop: 5, lineHeight: 1.4 }}>{currentItem.blurb}</div>
                )}
              </div>

              {/* Card area */}
              <div style={{ flex: 1, padding: "10px 16px", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {mobileTop5LoadingRank === mobileTop5CurrentRank ? (
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, border: "1.5px solid rgba(42,42,42,0.2)", background: "#fff" }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", border: "2.5px solid rgba(42,42,42,0.1)", borderTopColor: ink, animation: "m5spin 0.8s linear infinite" }} />
                    <div style={{ fontSize: 11, color: "#6a6a6a" }}>Finding more videos...</div>
                  </div>
                ) : video ? (
                  <div
                    style={{
                      flex: 1, display: "flex", flexDirection: "column", border: "1.5px solid rgba(42,42,42,0.25)", background: "#fff",
                      transform: cardTransform, opacity: cardOpacity,
                      transition: mobileTop5CardAnim ? "transform 0.3s ease-in, opacity 0.3s" : "none",
                      overflow: "hidden", minHeight: 0,
                    }}
                    onTouchStart={(e) => { mobileSwipeTouchStartXRef.current = e.touches[0].clientX; }}
                    onTouchEnd={(e) => {
                      const startX = mobileSwipeTouchStartXRef.current;
                      if (startX === null) return;
                      const dx = e.changedTouches[0].clientX - startX;
                      mobileSwipeTouchStartXRef.current = null;
                      if (Math.abs(dx) < 50) return;
                      if (dx > 0) handleMobileAccept();
                      else handleMobileReject();
                    }}
                  >
                    {/* YouTube embed */}
                    <div style={{ aspectRatio: "16/9", flexShrink: 0, background: "#000", position: "relative" }}>
                      <iframe
                        key={video.videoId}
                        src={`https://www.youtube.com/embed/${video.videoId}?autoplay=1&mute=1&controls=1&modestbranding=1&rel=0&playsinline=1`}
                        allow="autoplay; encrypted-media"
                        allowFullScreen
                        style={{ width: "100%", height: "100%", border: "none", display: "block" }}
                      />
                    </div>

                    {/* Video info */}
                    <div style={{ padding: "10px 12px 6px", flexShrink: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.3, marginBottom: 2, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                        {video.title}
                      </div>
                      <div style={{ fontSize: 10, color: "#6a6a6a" }}>
                        {video.channel}{video.viewCount > 0 ? ` · ${(video.viewCount / 1e6).toFixed(1)}M views` : ""}
                      </div>
                    </div>

                    {/* Trim slider */}
                    <div style={{ padding: "4px 12px 10px", flexShrink: 0 }}>
                      <div style={{ fontSize: 9, color: "#6a6a6a", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>
                        Trim · {Math.floor(mobileTop5TrimStart / 60)}:{String(Math.floor(mobileTop5TrimStart % 60)).padStart(2, "0")} – {Math.floor(mobileTop5TrimEnd / 60)}:{String(Math.floor(mobileTop5TrimEnd % 60)).padStart(2, "0")}
                      </div>
                      <div style={{ position: "relative", height: 32 }}>
                        <input
                          type="range" min={0} max={Math.max(0, Math.min(video.durationSec - 0.5, 30) - 0.5)} step={0.5}
                          value={mobileTop5TrimStart}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            setMobileTop5TrimStart(v);
                            if (mobileTop5TrimEnd - v < 0.5) setMobileTop5TrimEnd(Math.min(v + 0.5, Math.min(video.durationSec, 30)));
                          }}
                          style={{ position: "absolute", width: "100%", height: "100%", opacity: 0.5, accentColor: "#cc2200", cursor: "pointer" }}
                        />
                        <input
                          type="range" min={0.5} max={Math.min(video.durationSec, 30)} step={0.5}
                          value={mobileTop5TrimEnd}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            setMobileTop5TrimEnd(v);
                            if (v - mobileTop5TrimStart < 0.5) setMobileTop5TrimStart(Math.max(v - 0.5, 0));
                          }}
                          style={{ position: "absolute", width: "100%", height: "100%", accentColor: "#2a2a2a", cursor: "pointer" }}
                        />
                      </div>
                      <div style={{ fontSize: 9, color: "#aaa", textAlign: "right" }}>
                        {currentIdx + 1} / {currentResults.length} · swipe to choose
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", border: "1.5px dashed rgba(42,42,42,0.2)", color: "#6a6a6a", fontSize: 12 }}>
                    No more candidates
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div style={{ display: "flex", gap: 16, padding: "10px 20px 16px", flexShrink: 0, paddingBottom: "calc(16px + env(safe-area-inset-bottom))" }}>
                <button
                  onClick={handleMobileReject}
                  disabled={!video || !!mobileTop5CardAnim || mobileTop5LoadingRank !== null}
                  style={{
                    flex: 1, minHeight: 60, fontSize: 28, background: "#fff", border: "2px solid #2a2a2a",
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    boxShadow: "3px 3px 0 rgba(42,42,42,0.15)",
                    opacity: (!video || !!mobileTop5CardAnim || mobileTop5LoadingRank !== null) ? 0.4 : 1,
                  }}
                >
                  ✕
                </button>
                <button
                  onClick={handleMobileAccept}
                  disabled={!video || !!mobileTop5CardAnim || mobileTop5LoadingRank !== null}
                  style={{
                    flex: 1, minHeight: 60, fontSize: 28, background: ink, color: accent, border: "2px solid #2a2a2a",
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    boxShadow: "3px 3px 0 rgba(0,0,0,0.3)",
                    opacity: (!video || !!mobileTop5CardAnim || mobileTop5LoadingRank !== null) ? 0.4 : 1,
                  }}
                >
                  ✓
                </button>
              </div>
            </div>
          )}

          {/* Screen 4: Build */}
          {(mobileTop5Screen === "build" || mobileTop5Screen === "done") && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, padding: 32, textAlign: "center" }}>
              {mobileTop5Screen === "build" && (
                <>
                  <div style={{ width: 48, height: 48, borderRadius: "50%", border: "3px solid rgba(42,42,42,0.1)", borderTopColor: ink, animation: "m5spin 0.8s linear infinite" }} />
                  <div>
                    <div style={{ fontFamily: "'Caveat', cursive", fontSize: 24, fontWeight: 700, color: ink, marginBottom: 6 }}>
                      Building your Top 5...
                    </div>
                    <div style={{ fontSize: 12, color: "#6a6a6a" }}>{mobileTop5BuildPhase ?? "Preparing..."}</div>
                  </div>
                </>
              )}
              {mobileTop5Screen === "done" && (
                <>
                  <div style={{ fontSize: 56 }}>🏆</div>
                  <div>
                    <div style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: ink, marginBottom: 8 }}>
                      Your Top 5 is ready!
                    </div>
                    <div style={{ fontSize: 12, color: "#6a6a6a", lineHeight: 1.6 }}>
                      5 clips downloaded, labels added, and camera path generated. Tap Preview or Export to finish.
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
                    <button
                      onClick={() => { setMobileDesktopOverride(true); setTimeout(() => togglePlay(), 300); }}
                      style={{ ...sketchButton, width: "100%", padding: 16, fontSize: 15, textAlign: "center", background: "#c8f135" }}
                    >
                      ▶ Play Preview
                    </button>
                    <button
                      onClick={() => { setMobileDesktopOverride(true); setTimeout(() => startExport(), 300); }}
                      style={{ ...sketchButton, width: "100%", padding: 16, fontSize: 15, textAlign: "center" }}
                    >
                      ⬇ Export Video
                    </button>
                    <button
                      onClick={() => {
                        setMobileTop5Screen("prompt");
                        setMobileTop5Concept("");
                        setMobileTop5Data(null);
                        setMobileTop5AcceptedByRank(new Map());
                        setMobileTop5ResultsByRank(new Map());
                        setMobileTop5IndexByRank(new Map());
                      }}
                      style={{ fontFamily: "monospace", fontSize: 12, background: "transparent", border: "1.5px solid rgba(42,42,42,0.3)", padding: "10px", cursor: "pointer", color: "#6a6a6a" }}
                    >
                      Start over
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

        </div>
      </div>
    );
  }

  function removeImagePlaceholder(id: string) {
    setImagePlaceholders((prev) => prev.filter((p) => p.id !== id));
    setImagePreviewTarget((prev) => (prev?.id === id ? null : prev));
  }

  // "Add to Board" on an image placeholder: fetch the full image through /api/proxy-image
  // (server-side, sidesteps browser CORS on arbitrary Google Images sources), turn it into a
  // real image Clip at the placeholder's board position, and drop the placeholder.
  async function commitImagePlaceholder(ph: ImagePlaceholder) {
    setImagePreviewWorking(true);
    setImagePreviewError("");
    const toastId = generateId();
    setDownloadToasts((prev) => [...prev, { id: toastId, title: ph.title, status: "downloading" }]);
    try {
      const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(ph.imageUrl)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Fetch failed (${res.status})`);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      loadMedia(blobUrl, "image");
      const img = imgCacheRef.current.get(blobUrl);
      if (img && !img.complete) {
        await new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        });
      }
      const { w, h } = getMediaDimensions(blobUrl, "image");
      const clipId = generateId();
      setClips((prev) => {
        const endTime = prev.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
        const layer = freeLayerAtTime(prev, endTime, 4, clipId, 1);
        return [...prev, {
          id: clipId, type: "image" as const, name: ph.title.slice(0, 40), sourceUrl: blobUrl,
          startTime: endTime, duration: 4, layer,
          boardX: ph.boardX, boardY: ph.boardY, boardW: w, boardH: h,
        }];
      });
      setSelectedClipId(clipId);
      removeImagePlaceholder(ph.id);
      setImagePreviewTarget(null);

      setDownloadToasts((prev) => prev.map((t) => t.id === toastId ? { ...t, status: "done" } : t));
      setTimeout(() => setDownloadToasts((prev) => prev.filter((t) => t.id !== toastId)), 2000);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to add image";
      setImagePreviewError(message);
      setDownloadToasts((prev) => prev.map((t) => t.id === toastId ? { ...t, status: "error", error: message } : t));
      setTimeout(() => setDownloadToasts((prev) => prev.filter((t) => t.id !== toastId)), 5000);
    } finally {
      setImagePreviewWorking(false);
    }
  }

  function openTrimModalForPlaceholder(ph: NeuralPlaceholder) {
    const initEnd = Math.min(30, ph.durationSec || 30);
    setYtSelected({
      id: ph.videoId, title: ph.title, channel: ph.channel, duration: ph.durationSec, thumbnail: ph.thumbnailUrl,
      placeholderId: ph.id, boardX: ph.boardX, boardY: ph.boardY,
    });
    setYtStart(0); setYtStartInput("0:00");
    setYtEnd(initEnd); setYtEndInput(formatTimestamp(initEnd));
    ytRangeRef.current = { start: 0, end: initEnd };
    setYtView("trim");
    setYtError("");
    setYtModalOpen(true);
  }

  function setClipSelection(ids: string[]) {
    const unique = Array.from(new Set(ids));
    selectedClipIdsRef.current = unique;
    setSelectedClipIds(unique);
    setSelectedClipId(unique[unique.length - 1] ?? null);
    if (unique.length > 0) {
      selectedAnnotationIdsRef.current = [];
      setSelectedAnnotationIds([]);
      setSelectedAnnotationId(null);
    }
  }

  function setAnnotationSelection(ids: string[]) {
    const unique = Array.from(new Set(ids));
    selectedAnnotationIdsRef.current = unique;
    setSelectedAnnotationIds(unique);
    setSelectedAnnotationId(unique[unique.length - 1] ?? null);
    if (unique.length > 0) {
      selectedClipIdsRef.current = [];
      setSelectedClipIds([]);
      setSelectedClipId(null);
    }
  }

  function setMixedBoardSelection(clipIds: string[], annotationIds: string[]) {
    const uniqueClipIds = Array.from(new Set(clipIds));
    const uniqueAnnotationIds = Array.from(new Set(annotationIds));
    selectedClipIdsRef.current = uniqueClipIds;
    selectedAnnotationIdsRef.current = uniqueAnnotationIds;
    setSelectedClipIds(uniqueClipIds);
    setSelectedAnnotationIds(uniqueAnnotationIds);
    setSelectedClipId(uniqueClipIds[uniqueClipIds.length - 1] ?? null);
    setSelectedAnnotationId(uniqueAnnotationIds.length > 0 && uniqueClipIds.length === 0 ? uniqueAnnotationIds[uniqueAnnotationIds.length - 1] : null);
  }

  function clearBoardSelection() {
    selectedClipIdsRef.current = [];
    selectedAnnotationIdsRef.current = [];
    setSelectedClipIds([]);
    setSelectedAnnotationIds([]);
    setSelectedClipId(null);
    setSelectedAnnotationId(null);
  }

  function clientToBoardPoint(clientX: number, clientY: number) {
    const rect = boardContainerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - boardPanRef.current.x) / boardZoomRef.current,
      y: (clientY - rect.top - boardPanRef.current.y) / boardZoomRef.current,
    };
  }

  function rectsIntersect(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function selectionFromBoardMarquee(marquee: NonNullable<BoardMarquee>) {
    const x = Math.min(marquee.startX, marquee.currentX);
    const y = Math.min(marquee.startY, marquee.currentY);
    const w = Math.abs(marquee.currentX - marquee.startX);
    const h = Math.abs(marquee.currentY - marquee.startY);
    const clipIds = clipsRef.current
      .filter((clip) => clip.boardX !== undefined && clip.boardY !== undefined && clip.boardW !== undefined && clip.boardH !== undefined)
      .filter((clip) => rectsIntersect({ x, y, w, h }, { x: clip.boardX!, y: clip.boardY!, w: clip.boardW!, h: clip.boardH! }))
      .map((clip) => clip.id);
    const annotationIds = annotationsRef.current
      .filter((ann) => rectsIntersect({ x, y, w, h }, { x: ann.boardX, y: ann.boardY, w: ann.boardW, h: ann.boardH }))
      .map((ann) => ann.id);
    return { clipIds, annotationIds };
  }

  function timelinePointFromClient(clientX: number, clientY: number) {
    const rect = scrollerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clientX - rect.left + timelineScrollRef.current,
      y: clientY - rect.top,
    };
  }

  function selectedClipIdsInTimelineMarquee(marquee: NonNullable<TimelineMarquee>) {
    const left = Math.min(marquee.startX, marquee.currentX);
    const right = Math.max(marquee.startX, marquee.currentX);
    const top = Math.min(marquee.startY, marquee.currentY);
    const bottom = Math.max(marquee.startY, marquee.currentY);
    return clipsRef.current
      .filter((clip) => {
        const clipLeft = clip.startTime * pxPerSecRef.current;
        const clipRight = clipLeft + Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSecRef.current);
        const clipTop = clip.type === "narration" ? TRACK_H + 8 : (clip.layer ?? 1) * LAYER_H + 2;
        const clipBottom = clipTop + (clip.type === "narration" ? NARRATION_TRACK_H - 8 : LAYER_H - 4);
        return clipLeft < right && clipRight > left && clipTop < bottom && clipBottom > top;
      })
      .sort((a, b) => a.startTime - b.startTime)
      .map((clip) => clip.id);
  }

  // ─ Board clip drag ────────────────────────────────────────────────────────

  function handleBoardClipPointerDown(e: React.PointerEvent, clip: Clip) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const movingClipIds = selectedClipIdsRef.current.includes(clip.id) ? [...selectedClipIdsRef.current] : [clip.id];
    const movingAnnotationIds = selectedClipIdsRef.current.includes(clip.id) ? [...selectedAnnotationIdsRef.current] : [];
    if (!selectedClipIdsRef.current.includes(clip.id)) setClipSelection([clip.id]);
    const startX = e.clientX, startY = e.clientY;
    const origClips = new Map(
      clipsRef.current
        .filter((c) => movingClipIds.includes(c.id) && c.boardX !== undefined && c.boardY !== undefined)
        .map((c) => [c.id, { x: c.boardX!, y: c.boardY! }])
    );
    const origAnnotations = new Map(
      annotationsRef.current
        .filter((a) => movingAnnotationIds.includes(a.id))
        .map((a) => [a.id, {
          x: a.boardX, y: a.boardY,
          arrowStartX: a.arrowStartX, arrowStartY: a.arrowStartY, arrowEndX: a.arrowEndX, arrowEndY: a.arrowEndY,
          points: a.points ? a.points.map((p) => ({ ...p })) : undefined,
        }])
    );
    const onMove = (ev: PointerEvent) => {
      const zoom = boardZoomRef.current;
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      setClips((prev) =>
        prev.map((c) =>
          !movingClipIds.includes(c.id) || !origClips.has(c.id) ? c : {
            ...c,
            boardX: Math.round(origClips.get(c.id)!.x + dx),
            boardY: Math.round(origClips.get(c.id)!.y + dy),
          }
        )
      );
      if (movingAnnotationIds.length > 0) {
        setAnnotations((prev) => prev.map((a) => {
          const orig = origAnnotations.get(a.id);
          if (!orig) return a;
          return {
            ...a,
            boardX: orig.x + dx,
            boardY: orig.y + dy,
            ...(orig.arrowStartX !== undefined ? {
              arrowStartX: orig.arrowStartX + dx,
              arrowStartY: orig.arrowStartY! + dy,
              arrowEndX: orig.arrowEndX! + dx,
              arrowEndY: orig.arrowEndY! + dy,
            } : {}),
            ...(orig.points ? { points: orig.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : {}),
          };
        }));
      }
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Board clip resize ──────────────────────────────────────────────────────

  function handleBoardResizePointerDown(
    e: React.PointerEvent,
    clip: Clip,
    corner: "nw" | "ne" | "sw" | "se"
  ) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const { boardX: ox, boardY: oy, boardW: ow, boardH: oh } = clip;
    if (ox === undefined || oy === undefined || ow === undefined || oh === undefined) return;
    const aspect = ow / oh;
    const onMove = (ev: PointerEvent) => {
      const zoom = boardZoomRef.current;
      const dx = (ev.clientX - startX) / zoom;
      let nx = ox, ny = oy, nw = ow, nh = oh;
      if (corner === "se") { nw = Math.max(50, ow + dx); nh = nw / aspect; }
      else if (corner === "sw") { nw = Math.max(50, ow - dx); nh = nw / aspect; nx = ox + ow - nw; }
      else if (corner === "ne") { nw = Math.max(50, ow + dx); nh = nw / aspect; ny = oy + oh - nh; }
      else { nw = Math.max(50, ow - dx); nh = nw / aspect; nx = ox + ow - nw; ny = oy + oh - nh; }
      setClips((prev) =>
        prev.map((c) =>
          c.id !== clip.id ? c : {
            ...c, boardX: Math.round(nx), boardY: Math.round(ny), boardW: Math.round(nw), boardH: Math.round(nh),
          }
        )
      );
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Board pan (spacebar + drag) ────────────────────────────────────────────

  function handleBoardPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!isSpaceDownRef.current) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const origPan = { ...boardPanRef.current };
    const onMove = (ev: PointerEvent) => {
      const np = { x: origPan.x + ev.clientX - startX, y: origPan.y + ev.clientY - startY };
      boardPanRef.current = np;
      setBoardPan(np);
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleBoardSurfacePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (isSpaceDownRef.current || annotationToolRef.current !== "pointer") {
      clearBoardSelection();
      return;
    }
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const start = clientToBoardPoint(e.clientX, e.clientY);
    const marquee: NonNullable<BoardMarquee> = { startX: start.x, startY: start.y, currentX: start.x, currentY: start.y };
    boardMarqueeRef.current = marquee;
    boardMarqueeStartClientRef.current = { x: e.clientX, y: e.clientY };
    setBoardMarquee(marquee);
    const onMove = (ev: PointerEvent) => {
      const point = clientToBoardPoint(ev.clientX, ev.clientY);
      const next: NonNullable<BoardMarquee> = { ...marquee, currentX: point.x, currentY: point.y };
      boardMarqueeRef.current = next;
      setBoardMarquee(next);
      const { clipIds, annotationIds } = selectionFromBoardMarquee(next);
      setMixedBoardSelection(clipIds, annotationIds);
    };
    const onUp = (ev: PointerEvent) => {
      const startClient = boardMarqueeStartClientRef.current;
      const moved = startClient ? Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) : 0;
      if (moved < 4) clearBoardSelection();
      else if (boardMarqueeRef.current) {
        const { clipIds, annotationIds } = selectionFromBoardMarquee(boardMarqueeRef.current);
        setMixedBoardSelection(clipIds, annotationIds);
      }
      boardMarqueeRef.current = null;
      boardMarqueeStartClientRef.current = null;
      setBoardMarquee(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Annotation helpers ─────────────────────────────────────────────────────

  function deleteAnnotation(id: string) {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setSelectedAnnotationIds((prev) => prev.filter((annId) => annId !== id));
    selectedAnnotationIdsRef.current = selectedAnnotationIdsRef.current.filter((annId) => annId !== id);
    setSelectedAnnotationId((prev) => (prev === id ? null : prev));
    setEditingAnnotationId((prev) => (prev === id ? null : prev));
  }

  function commitTextEdit(annId: string) {
    const text = editingAnnotationTextRef.current.trim();
    if (!text) {
      deleteAnnotation(annId);
    } else {
      setAnnotations((prev) => prev.map((a) => (a.id === annId ? { ...a, text } : a)));
      setEditingAnnotationId(null);
    }
  }

  // ─ Annotation drag (pointer tool) ────────────────────────────────────────

  function handleAnnotationPointerDown(e: React.PointerEvent, ann: Annotation) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const movingAnnotationIds = selectedAnnotationIdsRef.current.includes(ann.id) ? [...selectedAnnotationIdsRef.current] : [ann.id];
    const movingClipIds = selectedAnnotationIdsRef.current.includes(ann.id) ? [...selectedClipIdsRef.current] : [];
    if (!selectedAnnotationIdsRef.current.includes(ann.id)) setAnnotationSelection([ann.id]);
    const startX = e.clientX, startY = e.clientY;
    const origAnnotations = new Map(
      annotationsRef.current
        .filter((a) => movingAnnotationIds.includes(a.id))
        .map((a) => [a.id, {
          x: a.boardX, y: a.boardY,
          arrowStartX: a.arrowStartX, arrowStartY: a.arrowStartY, arrowEndX: a.arrowEndX, arrowEndY: a.arrowEndY,
          points: a.points ? a.points.map((p) => ({ ...p })) : undefined,
        }])
    );
    const origClips = new Map(
      clipsRef.current
        .filter((c) => movingClipIds.includes(c.id) && c.boardX !== undefined && c.boardY !== undefined)
        .map((c) => [c.id, { x: c.boardX!, y: c.boardY! }])
    );
    const onMove = (ev: PointerEvent) => {
      const zoom = boardZoomRef.current;
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      setAnnotations((prev) =>
        prev.map((a) => {
          const orig = origAnnotations.get(a.id);
          if (!orig) return a;
          return {
            ...a,
            boardX: orig.x + dx,
            boardY: orig.y + dy,
            ...(orig.arrowStartX !== undefined ? {
              arrowStartX: orig.arrowStartX + dx, arrowStartY: orig.arrowStartY! + dy,
              arrowEndX: orig.arrowEndX! + dx, arrowEndY: orig.arrowEndY! + dy,
            } : {}),
            ...(orig.points ? { points: orig.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : {}),
          };
        })
      );
      if (movingClipIds.length > 0) {
        setClips((prev) => prev.map((c) => {
          const orig = origClips.get(c.id);
          return orig ? { ...c, boardX: Math.round(orig.x + dx), boardY: Math.round(orig.y + dy) } : c;
        }));
      }
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Annotation resize ─────────────────────────────────────────────────────

  function handleAnnotationCornerResize(e: React.PointerEvent, ann: Annotation, corner: "nw" | "ne" | "sw" | "se") {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const { boardX: origX, boardY: origY, boardW: origW, boardH: origH } = ann;
    const origPoints = ann.points ? ann.points.map((p) => ({ ...p })) : undefined;
    const origFontSize = ann.fontSize ?? 120;
    const startClientX = e.clientX, startClientY = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const zoom = boardZoomRef.current;
      const dx = (ev.clientX - startClientX) / zoom;
      const dy = (ev.clientY - startClientY) / zoom;
      let newX = origX, newY = origY, newW = origW, newH = origH;
      if (corner === "se") { newW = Math.max(20, origW + dx); newH = Math.max(20, origH + dy); }
      else if (corner === "sw") { newW = Math.max(20, origW - dx); newH = Math.max(20, origH + dy); newX = origX + origW - newW; }
      else if (corner === "ne") { newW = Math.max(20, origW + dx); newH = Math.max(20, origH - dy); newY = origY + origH - newH; }
      else { newW = Math.max(20, origW - dx); newH = Math.max(20, origH - dy); newX = origX + origW - newW; newY = origY + origH - newH; }
      setAnnotations((prev) => prev.map((a) => {
        if (a.id !== ann.id) return a;
        if (a.type === "pen" && origPoints && origW > 0 && origH > 0) {
          const scaleX = newW / origW, scaleY = newH / origH;
          return { ...a, boardX: newX, boardY: newY, boardW: newW, boardH: newH,
            points: origPoints.map((p) => ({ x: newX + (p.x - origX) * scaleX, y: newY + (p.y - origY) * scaleY })) };
        }
        if (a.type === "emoji") {
          const newFontSize = Math.max(20, origFontSize * (newW / origW));
          return { ...a, boardX: newX, boardY: newY, boardW: newW, boardH: newH, fontSize: newFontSize };
        }
        if (a.type === "text") {
          const scale = origW > 0 && origH > 0 ? Math.max(newW / origW, newH / origH) : 1;
          const newFontSize = Math.max(8, origFontSize * scale);
          return { ...a, boardX: newX, boardY: newY, boardW: newW, boardH: newH, fontSize: newFontSize };
        }
        return { ...a, boardX: newX, boardY: newY, boardW: newW, boardH: newH };
      }));
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleArrowEndpointDrag(e: React.PointerEvent, ann: Annotation, which: "start" | "end") {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const origSX = ann.arrowStartX!, origSY = ann.arrowStartY!;
    const origEX = ann.arrowEndX!, origEY = ann.arrowEndY!;
    const startClientX = e.clientX, startClientY = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const zoom = boardZoomRef.current;
      const dx = (ev.clientX - startClientX) / zoom;
      const dy = (ev.clientY - startClientY) / zoom;
      const newSX = which === "start" ? origSX + dx : origSX;
      const newSY = which === "start" ? origSY + dy : origSY;
      const newEX = which === "end" ? origEX + dx : origEX;
      const newEY = which === "end" ? origEY + dy : origEY;
      const minX = Math.min(newSX, newEX), maxX = Math.max(newSX, newEX);
      const minY = Math.min(newSY, newEY), maxY = Math.max(newSY, newEY);
      setAnnotations((prev) => prev.map((a) => a.id !== ann.id ? a : {
        ...a, arrowStartX: newSX, arrowStartY: newSY, arrowEndX: newEX, arrowEndY: newEY,
        boardX: minX, boardY: minY, boardW: Math.max(1, maxX - minX), boardH: Math.max(1, maxY - minY),
      }));
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Annotation creation (glass pane) ──────────────────────────────────────

  function handleAnnotationGlassPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    const container = boardContainerRef.current!;
    const rect = container.getBoundingClientRect();
    const bx = (e.clientX - rect.left - boardPanRef.current.x) / boardZoomRef.current;
    const by = (e.clientY - rect.top - boardPanRef.current.y) / boardZoomRef.current;
    const tool = annotationToolRef.current;

    if (tool === "text") {
      const newAnn: Annotation = {
        id: generateId(), type: "text",
        boardX: bx, boardY: by, boardW: 400, boardH: 100,
        color: annotationColorRef.current,
        text: "", fontFamily: annotationFontRef.current, fontSize: 80, fontWeight: "normal",
      };
      setAnnotations((prev) => [...prev, newAnn]);
      setSelectedAnnotationId(newAnn.id);
      setEditingAnnotationId(newAnn.id);
      setEditingAnnotationText("");
      return;
    }

    if (tool === "emoji") {
      const sz = 120;
      const newAnn: Annotation = {
        id: generateId(), type: "emoji",
        boardX: bx - sz / 2, boardY: by - sz / 2, boardW: sz, boardH: sz,
        color: "#000", emoji: annotationEmojiRef.current, fontSize: sz,
      };
      setAnnotations((prev) => [...prev, newAnn]);
      setSelectedAnnotationId(newAnn.id);
      return;
    }

    if (tool === "pen") {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const pts: Array<{ x: number; y: number }> = [{ x: bx, y: by }];
      let lastSampleMs = performance.now();
      const onMove = (ev: PointerEvent) => {
        const now = performance.now();
        if (now - lastSampleMs < 10) return;
        lastSampleMs = now;
        const r = container.getBoundingClientRect();
        const px = (ev.clientX - r.left - boardPanRef.current.x) / boardZoomRef.current;
        const py = (ev.clientY - r.top - boardPanRef.current.y) / boardZoomRef.current;
        pts.push({ x: px, y: py });
        setPenPreviewPoints([...pts]);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setPenPreviewPoints(null);
        if (pts.length < 2) return;
        const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
        const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
        const id = generateId();
        setAnnotations((prev) => [...prev, {
          id, type: "pen", color: annotationColorRef.current, strokeWidth: 4,
          boardX: minX, boardY: minY, boardW: Math.max(1, maxX - minX), boardH: Math.max(1, maxY - minY),
          points: pts,
        }]);
        setSelectedAnnotationId(id);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startBX = bx, startBY = by;
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointerup", onUp);
      const r = container.getBoundingClientRect();
      const ex = (ev.clientX - r.left - boardPanRef.current.x) / boardZoomRef.current;
      const ey = (ev.clientY - r.top - boardPanRef.current.y) / boardZoomRef.current;
      const minBX = Math.min(startBX, ex), maxBX = Math.max(startBX, ex);
      const minBY = Math.min(startBY, ey), maxBY = Math.max(startBY, ey);
      const bw = maxBX - minBX, bh = maxBY - minBY;
      if (bw < 5 && bh < 5) return;
      const t = annotationToolRef.current;
      const id = generateId();
      const color = annotationColorRef.current;
      if (t === "arrow") {
        setAnnotations((prev) => [...prev, {
          id, type: "arrow",
          boardX: minBX, boardY: minBY, boardW: Math.max(1, bw), boardH: Math.max(1, bh),
          color, arrowStartX: startBX, arrowStartY: startBY, arrowEndX: ex, arrowEndY: ey, strokeWidth: 3,
        }]);
      } else if (t === "circle") {
        setAnnotations((prev) => [...prev, {
          id, type: "circle",
          boardX: minBX, boardY: minBY, boardW: Math.max(10, bw), boardH: Math.max(10, bh),
          color, strokeWidth: 3,
        }]);
      } else if (t === "highlight") {
        setAnnotations((prev) => [...prev, {
          id, type: "highlight",
          boardX: minBX, boardY: minBY, boardW: Math.max(10, bw), boardH: Math.max(10, bh),
          color, highlightStyle: annotationHighlightStyleRef.current,
        }]);
      }
    };
    window.addEventListener("pointerup", onUp);
  }

  // ─ Timeline drag with cursor-anchored magnetic snap ───────────────────────

  function handleClipPointerDown(
    e: React.PointerEvent,
    clip: Clip,
    kind: "move" | "resize-left" | "resize-right"
  ) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (!selectedClipIdsRef.current.includes(clip.id)) setClipSelection([clip.id]);
    const rect = scrollerRef.current!.getBoundingClientRect();
    const clickTimeSec = (e.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current;
    const cursorOffsetSec = kind === "move" ? clickTimeSec - clip.startTime : 0;
    const origLayer = clip.layer ?? 1;
    timelineDragRef.current = {
      kind, clipId: clip.id,
      origStartTime: clip.startTime, origDuration: clip.duration,
      origLayer,
      cursorOffsetSec,
    };
    const onMove = (ev: PointerEvent) => {
      const drag = timelineDragRef.current;
      if (!drag) return;
      const cursorSec = (ev.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current;
      const threshold = MAGNETIC_SNAP_PX / pxPerSecRef.current;
      const snapTargets = [0, playheadRef.current, ...allClipEdges(clipsRef.current, drag.clipId)];
      setClips((prev) =>
        prev.map((c) => {
          if (c.id !== drag.clipId) return c;
          if (drag.kind === "move") {
            const rawStart = Math.max(0, cursorSec - drag.cursorOffsetSec);
            const { snapped: snL, target: tL } = magneticSnap(rawStart, snapTargets, threshold);
            const { snapped: snR, target: tR } = magneticSnap(rawStart + drag.origDuration, snapTargets, threshold);
            const newStart = tL !== null ? Math.max(0, snL) : tR !== null ? Math.max(0, snR - drag.origDuration) : rawStart;
            // For non-narration clips: compute target layer from vertical cursor position
            if (c.type !== "narration") {
              const newLayer = clamp(Math.floor((ev.clientY - rect.top) / LAYER_H), 0, N_LAYERS - 1);
              if (!layerOverlap(prev, newStart, drag.origDuration, drag.clipId, newLayer)) {
                return { ...c, startTime: newStart, layer: newLayer };
              }
              // Try same layer if target layer is blocked
              const curLayer = c.layer ?? 1;
              if (!layerOverlap(prev, newStart, drag.origDuration, drag.clipId, curLayer)) {
                return { ...c, startTime: newStart };
              }
              return c; // reject — both positions overlap
            }
            return { ...c, startTime: newStart };
          }
          if (drag.kind === "resize-right") {
            const rawEnd = Math.max(drag.origStartTime + 0.1, cursorSec);
            const { snapped, target } = magneticSnap(rawEnd, snapTargets, threshold);
            let newEnd = target !== null ? Math.max(drag.origStartTime + 0.1, snapped) : rawEnd;
            // Clamp to not overlap next clip in same layer
            if (c.type !== "narration") {
              const layer = c.layer ?? 1;
              const nextInLayer = clipsRef.current
                .filter((cc) => cc.id !== drag.clipId && (cc.layer ?? 1) === layer && cc.type !== "narration" && cc.startTime >= drag.origStartTime)
                .sort((a, b) => a.startTime - b.startTime)[0];
              if (nextInLayer) newEnd = Math.min(newEnd, nextInLayer.startTime);
            }
            return { ...c, duration: Math.max(0.1, newEnd - drag.origStartTime) };
          }
          // resize-left
          const rawStart = clamp(cursorSec, 0, drag.origStartTime + drag.origDuration - 0.1);
          const { snapped, target } = magneticSnap(rawStart, snapTargets, threshold);
          let newStart = target !== null
            ? clamp(snapped, 0, drag.origStartTime + drag.origDuration - 0.1)
            : rawStart;
          // Clamp to not overlap previous clip in same layer
          if (c.type !== "narration") {
            const layer = c.layer ?? 1;
            const prevInLayer = clipsRef.current
              .filter((cc) => cc.id !== drag.clipId && (cc.layer ?? 1) === layer && cc.type !== "narration" && cc.startTime < drag.origStartTime + drag.origDuration)
              .sort((a, b) => b.startTime - a.startTime)[0];
            if (prevInLayer) newStart = Math.max(newStart, prevInLayer.startTime + prevInLayer.duration);
          }
          return {
            ...c,
            startTime: newStart,
            duration: Math.max(0.1, drag.origStartTime + drag.origDuration - newStart),
          };
        })
      );
    };
    const onUp = () => {
      timelineDragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Character action timeline drag ────────────────────────────────────────

  function handleCharActionPointerDown(
    e: React.PointerEvent,
    action: CharacterAction,
    kind: "move" | "resize-left" | "resize-right"
  ) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = scrollerRef.current!.getBoundingClientRect();
    const clickTimeSec = (e.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current;
    const cursorOffsetSec = kind === "move" ? clickTimeSec - action.startTime : 0;
    charActionDragRef.current = {
      kind, actionId: action.id,
      origStartTime: action.startTime, origDuration: action.duration,
      cursorOffsetSec,
    };
    const onMove = (ev: PointerEvent) => {
      const drag = charActionDragRef.current;
      if (!drag) return;
      const cursorSec = (ev.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current;
      setCharacterActions((prev) =>
        prev.map((a) => {
          if (a.id !== drag.actionId) return a;
          if (drag.kind === "move") {
            const rawStart = Math.max(0, cursorSec - drag.cursorOffsetSec);
            // No-overlap: don't allow start time to produce overlap with other char actions
            const others = prev.filter((oa) => oa.id !== drag.actionId);
            const overlaps = others.some((oa) => rawStart < oa.startTime + oa.duration && rawStart + drag.origDuration > oa.startTime);
            if (overlaps) return a;
            return { ...a, startTime: rawStart };
          }
          if (drag.kind === "resize-right") {
            const newEnd = Math.max(drag.origStartTime + 0.1, cursorSec);
            return { ...a, duration: Math.max(0.1, newEnd - drag.origStartTime) };
          }
          // resize-left
          const newStart = clamp(cursorSec, 0, drag.origStartTime + drag.origDuration - 0.1);
          return {
            ...a,
            startTime: newStart,
            duration: Math.max(0.1, drag.origStartTime + drag.origDuration - newStart),
          };
        })
      );
    };
    const onUp = () => {
      charActionDragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Ruler scrub ────────────────────────────────────────────────────────────

  function handleRulerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    setIsPlaying(false);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const scrub = (clientX: number) => {
      const x = clientX - rect.left + timelineScrollRef.current;
      setPlayhead(Math.max(0, x / pxPerSecRef.current));
    };
    scrub(e.clientX);
    const onMove = (ev: PointerEvent) => scrub(ev.clientX);
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleTimelinePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-clipblock]")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const start = timelinePointFromClient(e.clientX, e.clientY);
    const marquee: NonNullable<TimelineMarquee> = { startX: start.x, startY: start.y, currentX: start.x, currentY: start.y };
    timelineMarqueeRef.current = marquee;
    timelineMarqueeStartClientRef.current = { x: e.clientX, y: e.clientY };
    setTimelineMarquee(marquee);
    const onMove = (ev: PointerEvent) => {
      const point = timelinePointFromClient(ev.clientX, ev.clientY);
      const next: NonNullable<TimelineMarquee> = { ...marquee, currentX: point.x, currentY: point.y };
      timelineMarqueeRef.current = next;
      setTimelineMarquee(next);
      setClipSelection(selectedClipIdsInTimelineMarquee(next));
    };
    const onUp = (ev: PointerEvent) => {
      const startClient = timelineMarqueeStartClientRef.current;
      const moved = startClient ? Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) : 0;
      if (moved < 4) {
        clearBoardSelection();
        const point = timelinePointFromClient(ev.clientX, ev.clientY);
        setPlayhead(Math.max(0, point.x / pxPerSecRef.current));
        setIsPlaying(false);
      } else if (timelineMarqueeRef.current) {
        setClipSelection(selectedClipIdsInTimelineMarquee(timelineMarqueeRef.current));
      }
      timelineMarqueeRef.current = null;
      timelineMarqueeStartClientRef.current = null;
      setTimelineMarquee(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Timeline drop ──────────────────────────────────────────────────────────

  function handleTimelineDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const itemId = e.dataTransfer.getData("mediaItemId");
    const item = mediaLibrary.find((m) => m.id === itemId);
    if (!item) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rawStart = Math.max(0, (e.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current);
    const dropLayer = clamp(Math.floor((e.clientY - rect.top) / LAYER_H), 0, N_LAYERS - 1);
    const duration = item.duration ?? (item.type === "video" ? 5 : 4);
    const clipId = generateId();
    loadMedia(item.url, item.type);
    if (item.type === "video") createVideoElement(clipId, item.url);
    const { w, h } = getMediaDimensions(item.url, item.type);
    const { camX, camY } = getVisibleBoardCenter();
    setClips((prev) => {
      const pos = findFreeBoardPos(prev, w, h, camX, camY);
      // Place in drop layer if no overlap; otherwise at end of that layer
      const startTime = layerOverlap(prev, rawStart, duration, clipId, dropLayer)
        ? endOfLayer(prev, dropLayer, clipId)
        : rawStart;
      return [
        ...prev,
        {
          id: clipId, type: item.type, name: item.name, sourceUrl: item.url,
          startTime, duration, layer: dropLayer,
          boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h,
          sourceDurationSec: item.type === "video" ? item.duration : undefined,
        },
      ];
    });
    setSelectedClipId(clipId);
  }

  // ─ Play / pause ───────────────────────────────────────────────────────────

  function togglePlay() {
    if (isPlaying) { setIsPlaying(false); return; }
    const maxEnd = clips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const wrapped = playheadRef.current >= maxEnd && maxEnd > 0;
    const startPh = wrapped ? 0 : playheadRef.current;
    if (wrapped) setPlayhead(0);
    prevPlayheadRef.current = startPh;

    // Ensure AudioContext exists and is running (user-gesture required for audio unlock)
    let ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") { ctx = new AudioContext(); audioCtxRef.current = ctx; }
    ctx.resume().catch(() => {});

    // Create Web Audio nodes for any video element that doesn't have them yet
    for (const clip of clipsRef.current) {
      if (clip.type !== "video") continue;
      const vid = videoElsRef.current.get(clip.id);
      if (vid) ensureVideoAudioNodes(clip.id, vid);
    }

    // First-play unlock: every element gets a play() call inside this synchronous click-gesture
    // callback so the browser grants autoplay permission for later programmatic play() calls
    // this session. The clip(s) about to become active are unlocked via switchVideoOn below
    // (not here) — running a play()-then-pause() on them too would race switchVideoOn's own
    // play() and could pause the clip right after it starts.
    const firstPlay = !hasPrewarmedRef.current;
    hasPrewarmedRef.current = true;

    // Switch on whichever clip(s) the playhead currently sits inside; switch off the rest
    for (const clip of clipsRef.current) {
      if (clip.type !== "video") continue;
      const vid = videoElsRef.current.get(clip.id);
      if (!vid) continue;
      const isInRange = startPh >= clip.startTime && startPh < clip.startTime + clip.duration;
      if (isInRange) {
        switchVideoOn(clip, vid, startPh - clip.startTime);
      } else if (firstPlay) {
        vid.play().then(() => vid.pause()).catch(() => {});
      } else {
        switchVideoOff(clip, vid);
      }
      videoRangeStateRef.current.set(clip.id, isInRange);
    }
    setIsPlaying(true);
  }

  // ─ Timeline fit ───────────────────────────────────────────────────────────

  function fitTimeline() {
    if (clips.length === 0) { pxPerSecRef.current = DEFAULT_PX_PER_SEC; setPxPerSec(DEFAULT_PX_PER_SEC); return; }
    const total = Math.max(...clips.map((c) => c.startTime + c.duration));
    if (total <= 0) return;
    const containerW = scrollerRef.current?.offsetWidth ?? 800;
    const next = clamp((containerW - 40) / total, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
    pxPerSecRef.current = next;
    setPxPerSec(next);
    pendingScrollLeftRef.current = 0;
  }

  // ─ Adaptive ruler ticks ───────────────────────────────────────────────────

  function rulerTicks() {
    const tickSec = pxPerSec > 200 ? 0.5 : pxPerSec >= 100 ? 1 : pxPerSec >= 30 ? 5 : 10;
    const labelSec = pxPerSec > 200 ? 1 : pxPerSec >= 100 ? 5 : pxPerSec >= 30 ? 10 : 30;
    const ticks = [];
    for (let t = 0; t <= timelineDuration + labelSec; t += tickSec) {
      const isLabel = Math.round(t * 1000) % Math.round(labelSec * 1000) === 0;
      ticks.push(
        <div
          key={t.toFixed(3)}
          style={{
            position: "absolute",
            left: t * pxPerSec,
            top: 0,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              width: 1,
              height: isLabel ? "55%" : "25%",
              background: "rgba(42,42,42,0.35)",
              flexShrink: 0,
            }}
          />
          {isLabel && (
            <span
              style={{
                fontSize: 8,
                fontFamily: "monospace",
                color: "#6a6a6a",
                userSelect: "none",
                whiteSpace: "nowrap",
                paddingLeft: 2,
              }}
            >
              {formatTime(t)}
            </span>
          )}
        </div>
      );
    }
    return ticks;
  }

  // ─ Generate camera keyframes ──────────────────────────────────────────────

  function generateCameraKeyframes() {
    const allClipsSorted = clipsRef.current
      .filter((c) => c.boardX !== undefined || c.type === "pan")
      .sort((a, b) => a.startTime - b.startTime);

    if (allClipsSorted.length === 0) {
      setToast("Place clips on the board first");
      return;
    }

    const boardPlacedClips = clipsRef.current.filter((c) => c.boardX !== undefined);
    const hasBoardClips = boardPlacedClips.length > 0;
    const W = canvasWRef.current;
    const H = canvasHRef.current;

    type Stop = { camX: number; camY: number; zoom: number };

    // Bounding box of all board-placed clips
    const bboxMinX = hasBoardClips ? Math.min(...boardPlacedClips.map((c) => c.boardX!)) : 0;
    const bboxMaxX = hasBoardClips ? Math.max(...boardPlacedClips.map((c) => c.boardX! + c.boardW!)) : BOARD_W;
    const bboxMinY = hasBoardClips ? Math.min(...boardPlacedClips.map((c) => c.boardY!)) : 0;
    const bboxMaxY = hasBoardClips ? Math.max(...boardPlacedClips.map((c) => c.boardY! + c.boardH!)) : BOARD_H;
    const bboxWidth = bboxMaxX - bboxMinX || 1;
    const bboxHeight = bboxMaxY - bboxMinY || 1;
    const bbW = bboxWidth;
    const bbH = bboxHeight;

    // Frame-all stop
    const faSf = (1 - 2 * FRAME_ALL_PADDING) * Math.min(W / bbW, H / bbH);
    const frameAllStop: Stop = {
      camX: (bboxMinX + bboxMaxX) / 2,
      camY: (bboxMinY + bboxMaxY) / 2,
      zoom: faSf * BOARD_W / W,
    };

    // Pan sweep — horizontal math ported from /board's getPanSweepInfo;
    // zoom uses actual canvas dims for correct 90% vertical fill
    const margin = 100;
    const bboxH = bboxMaxY - bboxMinY;
    const panZoom = clamp(bboxH > 0 ? 0.9 * H * BOARD_W / (bboxH * W) : H * BOARD_W / (W * BOARD_H), 0.5, 5.0);
    const halfVW = BOARD_W / (2 * panZoom);
    const panCamY = (bboxMinY + bboxMaxY) / 2;
    const panStartX = clamp(bboxMinX - margin, halfVW, BOARD_W - halfVW);
    const panEndX = clamp(bboxMaxX + margin, halfVW, BOARD_W - halfVW);

    // Hold-start stop for each clip (where camera is at the start of the hold phase)
    const holdStartStops: Stop[] = allClipsSorted.map((c) => {
      if (c.type === "pan") {
        return hasBoardClips
          ? { camX: panStartX, camY: panCamY, zoom: panZoom }
          : frameAllStop;
      }
      const bw = c.boardW!, bh = c.boardH!;
      const sf = CLIP_FOCUS_RATIO * Math.min(W / bw, H / bh);
      return { camX: c.boardX! + bw / 2, camY: c.boardY! + bh / 2, zoom: sf * BOARD_W / W };
    });
    const allStartStops: Stop[] = [...holdStartStops, frameAllStop];

    type CamEvent = { absTime: number; stop: Stop; easing: 'linear' | 'ease-in-out' };
    const events: CamEvent[] = [];

    for (let i = 0; i < allClipsSorted.length; i++) {
      const c = allClipsSorted[i];
      const hf = c.holdFraction ?? HOLD_FRACTION;
      const holdStart = c.startTime;
      const holdEnd = c.startTime + c.duration * hf;
      const transEnd = c.startTime + c.duration;
      const nextStop = allStartStops[i + 1];

      if (c.type === "pan") {
        if (!hasBoardClips) {
          console.warn(`Pan clip skipped: no board-placed clips`);
          continue;
        }
        // Two keyframes only — linear between them for constant-velocity sweep
        events.push({ absTime: holdStart, stop: { camX: panStartX, camY: panCamY, zoom: panZoom }, easing: 'ease-in-out' });
        events.push({ absTime: holdEnd,   stop: { camX: panEndX,   camY: panCamY, zoom: panZoom }, easing: 'linear' });
        events.push({ absTime: transEnd,  stop: nextStop,                                           easing: 'ease-in-out' });
      } else {
        events.push({ absTime: holdStart, stop: holdStartStops[i], easing: 'ease-in-out' });
        events.push({ absTime: holdEnd,   stop: holdStartStops[i], easing: 'ease-in-out' });
        events.push({ absTime: transEnd,  stop: nextStop,           easing: 'ease-in-out' });
      }
    }

    if (events.length === 0) {
      setToast("No keyframes generated — add board clips or remove pan-only clips");
      return;
    }

    const seen = new Set<number>();
    const newCameraKeyframes: CameraKeyframe[] = [];
    for (const ev of events.sort((a, b) => a.absTime - b.absTime)) {
      const t = Math.round(ev.absTime * 1000);
      if (seen.has(t)) continue;
      seen.add(t);
      newCameraKeyframes.push({
        time: parseFloat(ev.absTime.toFixed(3)),
        cameraX: ev.stop.camX,
        cameraY: ev.stop.camY,
        boardZoom: ev.stop.zoom,
        easing: ev.easing,
      });
    }

    setCameraKeyframes(newCameraKeyframes);
    cameraKeyframesRef.current = newCameraKeyframes;
    setKeyframesOutOfDate(false);
    // Character choreography is a useMemo over [clips, cameraKeyframes, ...] (see resolvedCharActions
    // above), so setting cameraKeyframes here automatically re-derives auto actions from the new
    // keyframe order on the very next render — no separate re-sync call needed.
    drawFrame(playheadRef.current);
    const n = allClipsSorted.length;
    setToast(`Camera keyframes generated: ${n} clip${n !== 1 ? "s" : ""} + frame-all — character re-synced`);
  }

  // ─ Divider drag (hold/transition split per clip) ──────────────────────────

  function handleDividerPointerDown(e: React.PointerEvent, clip: Clip) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const clipPx = Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSecRef.current);
    const innerW = clipPx - HANDLE_W * 2;
    const innerStart = clip.startTime * pxPerSecRef.current + HANDLE_W;
    dividerDragRef.current = { clipId: clip.id, innerStartPx: innerStart, innerWidthPx: innerW };

    const onMove = (ev: PointerEvent) => {
      const drag = dividerDragRef.current;
      if (!drag) return;
      const rect = scrollerRef.current!.getBoundingClientRect();
      const cursorX = ev.clientX - rect.left + timelineScrollRef.current;
      let fraction = clamp((cursorX - drag.innerStartPx) / drag.innerWidthPx, 0.1, 0.95);
      for (const sp of [0.25, 0.5, 0.75]) {
        if (Math.abs(fraction - sp) < 0.05) { fraction = sp; break; }
      }
      const pct = Math.round(fraction * 100);
      setDividerTooltip({ label: `Hold: ${pct}% / Trans: ${100 - pct}%`, x: ev.clientX, y: ev.clientY });
      if (cameraKeyframesRef.current.length > 0) setKeyframesOutOfDate(true);
      setClips((prev) => prev.map((c) => c.id !== drag.clipId ? c : { ...c, holdFraction: fraction }));
    };

    const onUp = () => {
      dividerDragRef.current = null;
      setDividerTooltip(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ AI annotation generation ────────────────────────────────────────────────

  async function applyAnnotationsFromTranscript(transcript: string): Promise<boolean> {
    setAiPhase("Generating annotations...");
    const boardClips = clipsRef.current.filter((c) => c.boardX !== undefined);
    const sendClips = boardClips.map((c) => ({
      id: c.id,
      type: c.type,
      boardX: c.boardX!,
      boardY: c.boardY!,
      boardW: c.boardW!,
      boardH: c.boardH!,
      ...(c.sourceUrl?.startsWith("http") ? { sourceUrl: c.sourceUrl } : {}),
    }));
    const r = await fetch("/api/board2/generate-annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        board: { width: BOARD_W, height: BOARD_H, backgroundColor: "#f5ecd8" },
        clips: sendClips,
      }),
    }).catch(() => null);
    if (!r) { setAiError("Network error. Try again."); setAiPhase(null); return false; }
    const d = await r.json();
    if (!r.ok) { setAiError(d.error || "Failed to generate annotations"); setAiPhase(null); return false; }
    const raw: Partial<Annotation>[] = Array.isArray(d.annotations) ? d.annotations : [];
    const validTypes = new Set(["text", "arrow", "circle", "highlight", "emoji"]);
    const newAnnotations: Annotation[] = raw
      .filter((a) => a.type && validTypes.has(a.type))
      .map((a) => ({
        id: generateId(),
        type: a.type as Annotation["type"],
        boardX: clamp(Number(a.boardX) || 0, 0, BOARD_W - 1),
        boardY: clamp(Number(a.boardY) || 0, 0, BOARD_H - 1),
        boardW: clamp(Number(a.boardW) || 200, 10, BOARD_W),
        boardH: clamp(Number(a.boardH) || 100, 10, BOARD_H),
        color: typeof a.color === "string" && /^#[0-9a-fA-F]{6}$/.test(a.color) ? a.color : "#cc2200",
        ...(a.text != null ? { text: String(a.text).slice(0, 300) } : {}),
        ...(a.fontFamily != null ? { fontFamily: String(a.fontFamily) } : {}),
        ...(a.fontSize != null ? { fontSize: Number(a.fontSize) } : {}),
        ...(a.fontWeight === "bold" || a.fontWeight === "normal" ? { fontWeight: a.fontWeight } : {}),
        ...(a.arrowStartX != null ? { arrowStartX: clamp(Number(a.arrowStartX), 0, BOARD_W) } : {}),
        ...(a.arrowStartY != null ? { arrowStartY: clamp(Number(a.arrowStartY), 0, BOARD_H) } : {}),
        ...(a.arrowEndX != null ? { arrowEndX: clamp(Number(a.arrowEndX), 0, BOARD_W) } : {}),
        ...(a.arrowEndY != null ? { arrowEndY: clamp(Number(a.arrowEndY), 0, BOARD_H) } : {}),
        ...(a.highlightStyle != null ? { highlightStyle: a.highlightStyle } : {}),
        ...(a.emoji != null ? { emoji: String(a.emoji) } : {}),
      }));
    setAnnotations((prev) => [...prev, ...newAnnotations]);
    setToast(`Generated ${newAnnotations.length} annotation${newAnnotations.length === 1 ? "" : "s"}`);
    setAiPhase(null);
    return true;
  }

  async function handleGenerateAnnotations() {
    const boardClips = clipsRef.current.filter((c) => c.boardX !== undefined);
    if (boardClips.length === 0) return;
    setAiError(null);

    let transcript = aiScriptText.trim();

    if (aiTab === "audio") {
      if (!aiAudioFile) return;
      setAiPhase("Transcribing audio...");
      const fd = new FormData();
      fd.append("audio", aiAudioFile);
      const r = await fetch("/api/board2/transcribe-audio", { method: "POST", body: fd }).catch(() => null);
      if (!r) { setAiError("Network error during transcription. Try again."); setAiPhase(null); return; }
      const d = await r.json();
      if (!r.ok) { setAiError(d.error || "Transcription failed"); setAiPhase(null); return; }
      if (!d.transcript?.trim()) { setAiError("Couldn't understand the audio. Try pasting the script instead."); setAiPhase(null); return; }
      transcript = d.transcript;
    }

    const ok = await applyAnnotationsFromTranscript(transcript);
    if (ok) {
      setAiModalOpen(false);
      setAiAudioFile(null);
      setAiScriptText("");
    }
  }

  async function generateAnnotationsFromNarration() {
    const narrationClips = clipsRef.current.filter((c) => c.type === "narration");
    if (narrationClips.length === 0) return;
    if (clipsRef.current.filter((c) => c.boardX !== undefined).length === 0) return;
    setAiError(null);

    let blob: Blob;
    try {
      setAiPhase("Preparing audio...");
      blob = await compileNarrationToBlob(narrationClips);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Failed to compile narration audio");
      setAiPhase(null);
      return;
    }

    if (blob.size > 25 * 1024 * 1024) {
      setAiError("Narration too long — exceeds 25MB. Please split into shorter recordings.");
      setAiPhase(null);
      return;
    }

    setAiPhase("Transcribing...");
    const fd = new FormData();
    fd.append("audio", blob, "narration.wav");
    const r = await fetch("/api/board2/transcribe-audio", { method: "POST", body: fd }).catch(() => null);
    if (!r) { setAiError("Network error during transcription. Try again."); setAiPhase(null); return; }
    const d = await r.json();
    if (!r.ok) { setAiError(d.error || "Transcription failed"); setAiPhase(null); return; }
    if (!d.transcript?.trim()) { setAiError("Couldn't understand the narration. Try pasting the script instead."); setAiPhase(null); return; }

    await applyAnnotationsFromTranscript(d.transcript);
  }

  // ─ AI character choreography ────────────────────────────────────────────────

  async function handleGenerateChoreography() {
    const allClips = clipsRef.current;
    const boardClips = allClips.filter((c) => c.boardX !== undefined && (c.type === "image" || c.type === "video"));
    if (boardClips.length === 0) { setChoreoError("Place some clips on the board first"); return; }

    const narrationClips = allClips.filter((c) => c.type === "narration");
    const wantsSync = syncEmotesToNarration && narrationClips.length > 0;
    const direction = characterDirection.trim();
    if (!direction && !wantsSync) {
      setChoreoError("Describe what the character should do, or enable narration sync");
      return;
    }
    setChoreoError(null);

    let transcriptPayload: { text: string; segments: { start: number; end: number; text: string }[] } | undefined;

    if (wantsSync) {
      setChoreoPhase("Transcribing...");
      let blob: Blob;
      try {
        blob = await compileNarrationToBlob(narrationClips);
      } catch (e) {
        setChoreoError(e instanceof Error ? e.message : "Failed to compile narration audio");
        setChoreoPhase(null);
        return;
      }
      if (blob.size > 25 * 1024 * 1024) {
        setChoreoError("Narration too long — exceeds 25MB. Please split into shorter recordings.");
        setChoreoPhase(null);
        return;
      }
      const fd = new FormData();
      fd.append("audio", blob, "narration.wav");
      const r = await fetch("/api/board2/transcribe-audio", { method: "POST", body: fd }).catch(() => null);
      if (!r) { setChoreoError("Network error during transcription. Try again."); setChoreoPhase(null); return; }
      const d = await r.json();
      if (!r.ok) { setChoreoError(d.error || "Transcription failed"); setChoreoPhase(null); return; }
      if (!d.transcript?.trim()) { setChoreoError("Couldn't understand the narration. Try pasting a direction instead."); setChoreoPhase(null); return; }
      // compileNarrationToBlob renders narration clips relative to the first clip's startTime —
      // segment timestamps come back relative to that same origin, so offset them back onto the
      // absolute timeline before they're used to time anything against clip start/holdEnd times.
      const firstStart = [...narrationClips].sort((a, b) => a.startTime - b.startTime)[0].startTime;
      const segments: { start: number; end: number; text: string }[] = Array.isArray(d.segments)
        ? d.segments.map((s: { start: number; end: number; text: string }) => ({
            start: s.start + firstStart, end: s.end + firstStart, text: s.text,
          }))
        : [];
      transcriptPayload = { text: d.transcript, segments };
    }

    setChoreoPhase("Choreographing...");

    const focusClips = [...boardClips].sort((a, b) => a.startTime - b.startTime);
    const cameraFocusOrder = focusClips.map((c) => {
      const hf = c.holdFraction ?? HOLD_FRACTION;
      return {
        clipId: c.id,
        holdStart: c.startTime,
        holdEnd: c.startTime + c.duration * hf,
        transitionEnd: c.startTime + c.duration,
      };
    });
    const timelineClips = focusClips.map((c) => ({
      id: c.id, type: c.type, startTime: c.startTime, duration: c.duration,
      boardX: c.boardX, boardY: c.boardY, boardW: c.boardW, boardH: c.boardH,
      label: c.name,
    }));
    const totalDurationSec = Math.max(0, ...allClips.map((c) => c.startTime + c.duration));

    const r2 = await fetch("/api/board2/character-choreography", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        direction,
        transcript: transcriptPayload,
        timeline: { totalDurationSec, clips: timelineClips, cameraFocusOrder },
      }),
    }).catch(() => null);
    if (!r2) { setChoreoError("Network error. Try again."); setChoreoPhase(null); return; }
    const d2 = await r2.json();
    if (!r2.ok) { setChoreoError(d2.error || "Failed to generate choreography"); setChoreoPhase(null); return; }

    // Server already dropped unknown types / dangling clip refs and clamped times — this pass
    // turns the raw actions into real CharacterAction objects and re-validates targetClipId
    // against the CURRENT clip set (it could have changed while the request was in flight).
    type RawAction = { type?: string; startTime?: number; duration?: number; targetClipId?: string; emoji?: string };
    const clipIds = new Set(timelineClips.map((c) => c.id));
    const rawActions: RawAction[] = Array.isArray(d2.actions) ? d2.actions : [];
    const cleaned: CharacterAction[] = rawActions
      .filter((a): a is Required<Pick<RawAction, "type">> & RawAction => typeof a.type === "string")
      .filter((a) => {
        if (a.type === "emote") return !!a.emoji;
        if (a.type === "pointAt") return !!a.targetClipId && clipIds.has(a.targetClipId);
        if (CHAR_TRAVEL_TYPES.has(a.type as CharacterAction["type"])) return !!a.targetClipId && clipIds.has(a.targetClipId);
        return !a.targetClipId || clipIds.has(a.targetClipId);
      })
      .map((a) => {
        const startTime = clamp(Number(a.startTime) || 0, 0, totalDurationSec);
        const rawDuration = Number(a.duration) > 0 ? Number(a.duration) : 1.5;
        const duration = clamp(rawDuration, 0.1, Math.max(0.1, totalDurationSec - startTime));
        return {
          id: generateId(),
          type: a.type as CharacterAction["type"],
          startTime, duration,
          ...(a.targetClipId ? { targetClipId: a.targetClipId } : {}),
          ...(a.type === "emote" && a.emoji ? { emoji: a.emoji } : {}),
          aiGenerated: true,
        } as CharacterAction;
      });

    // Regenerate = clean slate for AI actions, but hand-placed ones are never touched. Then
    // enforce no-overlap across the whole character row: later-starting action wins, the one
    // that starts earlier gets truncated to make room (matches the drag/resize invariant that
    // no two blocks on this row ever overlap).
    setCharacterActions((prev) => {
      const handPlaced = prev.filter((a) => !a.aiGenerated);
      const combined = [...handPlaced, ...cleaned].sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < combined.length - 1; i++) {
        const end = combined[i].startTime + combined[i].duration;
        if (end > combined[i + 1].startTime) {
          combined[i] = { ...combined[i], duration: Math.max(0.1, combined[i + 1].startTime - combined[i].startTime) };
        }
      }
      return combined;
    });

    setToast(`Generated ${cleaned.length} choreographed action${cleaned.length === 1 ? "" : "s"}`);
    setChoreoPhase(null);
    setDirectCharacterOpen(false);
  }

  // ─ Export ─────────────────────────────────────────────────────────────────

  function cancelExport() { exportCancelRef.current = true; }

  async function startExport() {
    if (isRecordingRef.current) { setToast("Stop recording before exporting"); return; }
    if (clips.length === 0) { alert("No clips to export"); return; }
    if (isPlayingRef.current) setIsPlaying(false);
    setIsExporting(true); isExportingRef.current = true; exportCancelRef.current = false; setExportProgress(0);
    const currentClips = clipsRef.current;
    const currentCameraKeyframes = cameraKeyframesRef.current;
    const currentAnnotations = annotationsRef.current;
    const totalDur = currentClips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const W = canvasWRef.current, H = canvasHRef.current;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = W; exportCanvas.height = H;
    const exportCtx = exportCanvas.getContext("2d")!;
    exportCtx.imageSmoothingEnabled = true;
    exportCtx.imageSmoothingQuality = "high";
    // Silence preview-context gain nodes (export uses its own decodeAudioData audio)
    for (const nodes of videoAudioNodesRef.current.values()) { try { nodes.gainNode.gain.value = 0; } catch {} }
    // Switch off every video element before export starts — same switch model as preview
    for (const clip of currentClips) {
      if (clip.type !== "video") continue;
      const vid = videoElsRef.current.get(clip.id);
      if (!vid) continue;
      vid.loop = false;
      vid.pause();
      vid.currentTime = 0;
    }
    const canvasStream = exportCanvas.captureStream(EXPORT_FPS);
    const mimeType = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "video/webm";

    // ── Audio setup (narration + video clips) ────────────────────────────────
    const audioClips = currentClips.filter((c) => c.type === "narration" || c.type === "video");
    let exportAudioCtx: AudioContext | null = null;
    let exportAudioDest: MediaStreamAudioDestinationNode | null = null;
    type AudioItem = { clip: Clip; buffer: AudioBuffer };
    let audioBuffers: AudioItem[] = [];

    if (audioClips.length > 0) {
      exportAudioCtx = new AudioContext();
      exportAudioDest = exportAudioCtx.createMediaStreamDestination();
      const results = await Promise.all(
        audioClips.map(async (clip) => {
          try {
            const ab = await fetch(clip.sourceUrl).then((r) => r.arrayBuffer());
            const buffer = await exportAudioCtx!.decodeAudioData(ab);
            return { clip, buffer } as AudioItem;
          } catch {
            return null; // video with no audio track, unsupported codec, etc.
          }
        })
      );
      audioBuffers = results.filter((x): x is AudioItem => x !== null);
    }

    const exportStream = exportAudioDest
      ? new MediaStream([...canvasStream.getVideoTracks(), ...exportAudioDest.stream.getAudioTracks()])
      : canvasStream;

    const recorder = new MediaRecorder(exportStream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      exportAudioCtx?.close().catch(() => {});
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = mimeType === "video/mp4" ? "board2-export.mp4" : "board2-export.webm";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setIsExporting(false); isExportingRef.current = false; setExportProgress(0);
    };
    recorder.start(100);

    // Schedule audio relative to export start (export runs at real-time 1x speed)
    if (exportAudioCtx && exportAudioDest && audioBuffers.length > 0) {
      const exportStartAcTime = exportAudioCtx.currentTime;
      for (const { clip, buffer } of audioBuffers) {
        const gainNode = exportAudioCtx.createGain();
        gainNode.gain.value = effectiveClipVolume(clip);
        gainNode.connect(exportAudioDest);
        const bufNode = exportAudioCtx.createBufferSource();
        bufNode.buffer = buffer;
        bufNode.connect(gainNode);
        bufNode.start(exportStartAcTime + clip.startTime);
        // For video clips, stop at clip end (buffer may be longer than clip.duration)
        if (clip.type === "video") {
          bufNode.stop(exportStartAcTime + clip.startTime + clip.duration);
        }
      }
    }

    // Pauses+resets any video element still active at export end/cancel so the live preview
    // (which shares these elements) doesn't keep rendering a drifting frame afterward.
    function pauseAllExportVideos() {
      for (const clip of currentClips) {
        if (clip.type !== "video") continue;
        const vid = videoElsRef.current.get(clip.id);
        if (vid) pauseAndReset(vid);
        videoRangeStateRef.current.set(clip.id, false);
      }
    }

    // eslint-disable-next-line react-hooks/purity
    const exportWallStart = performance.now();
    let prevExportElapsed = -1; // tracks previous frame for entry detection
    function exportFrame() {
      if (exportCancelRef.current) {
        pauseAllExportVideos();
        exportAudioCtx?.close().catch(() => {});
        recorder.stop(); setIsExporting(false); isExportingRef.current = false; setExportProgress(0); return;
      }
      const elapsed = (performance.now() - exportWallStart) / 1000;
      if (elapsed >= totalDur) {
        pauseAllExportVideos();
        recorder.stop(); return;
      }
      setExportProgress(elapsed / totalDur);
      // Same switch model as preview: entry restarts from 0 + plays, exit pauses + resets to 0
      // (audio is intentionally untouched here — it's scheduled separately below, and the
      // preview's Web Audio gain nodes were silenced above so they don't double up)
      for (const clip of currentClips) {
        if (clip.type !== "video") continue;
        const vid = videoElsRef.current.get(clip.id);
        if (!vid) continue;
        const isActive = elapsed >= clip.startTime && elapsed < clip.startTime + clip.duration;
        const wasActive = prevExportElapsed >= clip.startTime && prevExportElapsed < clip.startTime + clip.duration;
        if (isActive && (!wasActive || vid.paused)) {
          restartAndPlay(vid, 0);
        } else if (!isActive && wasActive) {
          pauseAndReset(vid);
        }
      }
      prevExportElapsed = elapsed;
      renderToCtx(exportCtx, elapsed, currentClips, currentCameraKeyframes, W, H, currentAnnotations);
      exportRafRef.current = requestAnimationFrame(exportFrame);
    }
    exportRafRef.current = requestAnimationFrame(exportFrame);
  }

  // ─ Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA";
      if (e.code === "Space") {
        isSpaceDownRef.current = true;
        setIsSpaceDown(true);
        if (boardContainerRef.current) boardContainerRef.current.style.cursor = "grab";
        if (!inInput) {
          e.preventDefault();
          if (!e.repeat) togglePlay();
        }
        return;
      }
      if (inInput) return;
      if (e.code === "Delete" || e.code === "Backspace") {
        const clipIds = selectedClipIdsRef.current.length > 0 ? selectedClipIdsRef.current : selectedClipId ? [selectedClipId] : [];
        const annotationIds = selectedAnnotationIdsRef.current.length > 0 ? selectedAnnotationIdsRef.current : selectedAnnotationId ? [selectedAnnotationId] : [];
        if (clipIds.length > 0) {
          e.preventDefault();
          clipIds.forEach((id) => deleteClip(id));
          selectedClipIdsRef.current = [];
          setSelectedClipIds([]);
          setSelectedClipId(null);
        } else if (annotationIds.length > 0) {
          e.preventDefault();
          setAnnotations((prev) => prev.filter((ann) => !annotationIds.includes(ann.id)));
          selectedAnnotationIdsRef.current = [];
          setSelectedAnnotationIds([]);
          setSelectedAnnotationId(null);
        }
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.code === "KeyC" && selectedClipId) {
        e.preventDefault();
        copyClip(selectedClipId);
      }
      if (meta && e.code === "KeyV" && clipboardRef.current) {
        e.preventDefault();
        pasteClip();
      }
      if (meta && e.code === "KeyD" && selectedClipId) {
        e.preventDefault();
        duplicateClip(selectedClipId);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        isSpaceDownRef.current = false;
        setIsSpaceDown(false);
        if (boardContainerRef.current) boardContainerRef.current.style.cursor = "default";
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  });

  // ─ Context menu dismiss ───────────────────────────────────────────────────

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("click", dismiss, { once: true });
    window.addEventListener("keydown", dismiss, { once: true });
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!charActionContextMenu) return;
    const dismiss = () => setCharActionContextMenu(null);
    window.addEventListener("click", dismiss, { once: true });
    window.addEventListener("keydown", dismiss, { once: true });
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [charActionContextMenu]);

  // ─── Mobile gesture handlers ──────────────────────────────────────────────

  function handleMobileBoardPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const pointers = mobileBoardPointersRef.current;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const g = mobileGestureRef.current;

    if (pointers.size === 2) {
      if (g.longPressTimer) { clearTimeout(g.longPressTimer); g.longPressTimer = null; }
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      g.type = "pinch";
      g.pinchStartDist = Math.max(dist, 1);
      g.pinchStartZoom = boardZoomRef.current;
      g.pinchStartPan = { ...boardPanRef.current };
      return;
    }

    const target = e.target as HTMLElement;
    const clipEl = target.closest("[data-mbclipid]");
    const hitClipId = clipEl ? (clipEl as HTMLElement).dataset.mbclipid ?? null : null;

    g.type = "deciding";
    g.hitClipId = hitClipId;
    g.hitClipIsSelected = hitClipId !== null && hitClipId === selectedClipId;
    g.startX = e.clientX;
    g.startY = e.clientY;
    g.origPan = { ...boardPanRef.current };

    if (hitClipId) {
      const clip = clipsRef.current.find((c) => c.id === hitClipId);
      if (clip?.boardX !== undefined) { g.clipOrigX = clip.boardX; g.clipOrigY = clip.boardY ?? 0; }
    }

    g.longPressTimer = setTimeout(() => {
      if (g.type === "deciding" && g.hitClipId) {
        g.type = "idle";
        setMobileLongPressClipId(g.hitClipId);
      }
    }, 500);
  }

  function handleMobileBoardPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const pointers = mobileBoardPointersRef.current;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = mobileGestureRef.current;

    if (g.type === "pinch" && pointers.size === 2) {
      const pts = [...pointers.values()];
      const container = boardContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const scale = dist / g.pinchStartDist;
      const nz = Math.max(0.05, Math.min(3, g.pinchStartZoom * scale));
      const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
      const pz = g.pinchStartZoom;
      const pp = g.pinchStartPan;
      const np = { x: cx - (cx - pp.x) * (nz / pz), y: cy - (cy - pp.y) * (nz / pz) };
      boardZoomRef.current = nz;
      boardPanRef.current = np;
      setBoardZoom(nz);
      setBoardPan(np);
      return;
    }

    if (g.type === "deciding") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (Math.hypot(dx, dy) >= 8) {
        if (g.longPressTimer) { clearTimeout(g.longPressTimer); g.longPressTimer = null; }
        g.type = g.hitClipIsSelected ? "move" : "pan";
      }
    }

    if (g.type === "pan") {
      const np = { x: g.origPan.x + e.clientX - g.startX, y: g.origPan.y + e.clientY - g.startY };
      boardPanRef.current = np;
      setBoardPan(np);
    } else if (g.type === "move" && g.hitClipId) {
      const zoom = boardZoomRef.current;
      const dx = (e.clientX - g.startX) / zoom;
      const dy = (e.clientY - g.startY) / zoom;
      setClips((prev) => prev.map((c) => c.id !== g.hitClipId ? c : {
        ...c, boardX: Math.round(g.clipOrigX + dx), boardY: Math.round(g.clipOrigY + dy),
      }));
    }
  }

  function handleMobileBoardPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const pointers = mobileBoardPointersRef.current;
    const g = mobileGestureRef.current;
    if (g.longPressTimer) { clearTimeout(g.longPressTimer); g.longPressTimer = null; }

    if (g.type === "deciding") {
      if (g.hitClipId) {
        setSelectedClipId(g.hitClipId);
        setMobileDrawer("props");
      } else {
        setSelectedClipId(null);
        setMobileDrawer(null);
      }
    }

    pointers.delete(e.pointerId);
    if (pointers.size < 2 && g.type === "pinch") g.type = "idle";
    else if (pointers.size === 0) g.type = "idle";
  }

  // ─── Download toast stack (bottom-right, stacked) ──────────────────────────

  function renderDownloadToasts() {
    if (downloadToasts.length === 0) return null;
    return (
      <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 10000, display: "flex", flexDirection: "column-reverse", gap: 8, pointerEvents: "none" }}>
        <style>{`@keyframes nbspin { to { transform: rotate(360deg); } }`}</style>
        {downloadToasts.map((t) => {
          const isError = t.status === "error";
          const accent = isError ? "#ff5e3a" : "#c8f135";
          return (
            <div key={t.id} style={{
              display: "flex", alignItems: "center", gap: 8, minWidth: 220, maxWidth: 300,
              background: "#2a2a2a", color: accent, fontFamily: "monospace", fontSize: 11,
              padding: "8px 14px", border: `1.5px solid ${accent}`, boxShadow: `2px 2px 0 ${accent}`,
              pointerEvents: "auto",
            }}>
              {t.status === "downloading" && (
                <span style={{ flexShrink: 0, width: 10, height: 10, borderRadius: "50%", border: "2px solid rgba(200,241,53,0.3)", borderTopColor: "#c8f135", animation: "nbspin 0.8s linear infinite" }} />
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.status === "downloading" && `Downloading ${t.title}…`}
                {t.status === "done" && `Added ${t.title}`}
                {isError && (t.error ? `Failed: ${t.error}` : `Failed to download ${t.title}`)}
              </span>
              {isError && (
                <button onClick={() => setDownloadToasts((prev) => prev.filter((x) => x.id !== t.id))}
                  style={{ marginLeft: "auto", background: "transparent", border: "none", color: accent, cursor: "pointer", fontFamily: "monospace", fontSize: 13, padding: 0, flexShrink: 0 }}>
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // ─── Neural Search modal ────────────────────────────────────────────────────

  function renderNeuralSearchModal() {
    if (!neuralModalOpen) return null;
    return (
      <div
        onClick={(e) => { if (e.target === e.currentTarget && !neuralPhase) setNeuralModalOpen(false); }}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 480, maxWidth: "95vw", fontFamily: "monospace", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>🔮 NEURAL SEARCH</span>
            <button
              onClick={() => { if (!neuralPhase) setNeuralModalOpen(false); }}
              style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15, opacity: neuralPhase ? 0.4 : 1 }}
            >×</button>
          </div>

          <div style={{ padding: 16 }}>
            <p style={{ fontSize: 11, color: "#6a6a6a", margin: "0 0 10px", lineHeight: 1.5 }}>
              Describe your video concept. We&apos;ll find YouTube videos and Google Images to match.
            </p>
            <textarea
              value={neuralConcept}
              onChange={(e) => setNeuralConcept(e.target.value)}
              disabled={!!neuralPhase}
              placeholder="e.g. The connection between microplastics in our body and mental health decline in modern society…"
              rows={6}
              style={{
                width: "100%", fontFamily: "monospace", fontSize: 11,
                border: "1.5px solid #2a2a2a", padding: "8px",
                resize: "vertical", boxSizing: "border-box",
                background: neuralPhase ? "#f5f5f0" : "#fff",
              } as React.CSSProperties}
            />

            {neuralPhase && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#1a6fd4" }}>
                ⟳ {neuralPhase}
              </div>
            )}
            {neuralError && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#cc2200" }}>
                ✗ {neuralError}
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              onClick={() => { if (!neuralPhase) setNeuralModalOpen(false); }}
              disabled={!!neuralPhase}
              style={{ ...miniButton, padding: "6px 14px", fontSize: 11, opacity: neuralPhase ? 0.4 : 1 }}
            >
              Cancel
            </button>
            <button
              onClick={runNeuralSearch}
              disabled={!!neuralPhase || !neuralConcept.trim()}
              style={{
                ...miniButton, padding: "6px 18px", fontSize: 12, fontWeight: 700,
                background: "#e4cfff", borderColor: "#2a2a2a",
                opacity: (!!neuralPhase || !neuralConcept.trim()) ? 0.5 : 1,
                cursor: (!!neuralPhase || !neuralConcept.trim()) ? "not-allowed" : "pointer",
              }}
            >
              {neuralPhase ? "Working…" : "Find Videos & Images →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Top 5 Neural Search modal ──────────────────────────────────────────────

  function renderTop5Modal() {
    if (!top5ModalOpen) return null;
    return (
      <div
        onClick={(e) => { if (e.target === e.currentTarget && !top5Phase) setTop5ModalOpen(false); }}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 500, maxWidth: "95vw", fontFamily: "monospace", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>🏆 TOP 5 NEURAL SEARCH</span>
            <button
              onClick={() => { if (!top5Phase) setTop5ModalOpen(false); }}
              style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15, opacity: top5Phase ? 0.4 : 1 }}
            >×</button>
          </div>

          <div style={{ padding: 16 }}>
            <p style={{ fontSize: 11, color: "#6a6a6a", margin: "0 0 10px", lineHeight: 1.5 }}>
              Describe a Top 5 concept. GPT-4o will generate the ranked list, then find 2–3 YouTube candidates per rank and arrange them on the board in columns.
            </p>
            <textarea
              value={top5Concept}
              onChange={(e) => setTop5Concept(e.target.value)}
              disabled={!!top5Phase}
              placeholder="e.g. Top 5 conspiracies that turned out to be true…"
              rows={5}
              style={{
                width: "100%", fontFamily: "monospace", fontSize: 11,
                border: "1.5px solid #2a2a2a", padding: "8px",
                resize: "vertical", boxSizing: "border-box",
                background: top5Phase ? "#f5f5f0" : "#fff",
              } as React.CSSProperties}
            />

            {top5Phase && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#1a6fd4" }}>
                ⟳ {top5Phase}
              </div>
            )}
            {top5Error && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#cc2200" }}>
                ✗ {top5Error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              onClick={() => { if (!top5Phase) setTop5ModalOpen(false); }}
              disabled={!!top5Phase}
              style={{ ...miniButton, padding: "6px 14px", fontSize: 11, opacity: top5Phase ? 0.4 : 1 }}
            >
              Cancel
            </button>
            <button
              onClick={runTop5Search}
              disabled={!!top5Phase || !top5Concept.trim()}
              style={{
                ...miniButton, padding: "6px 18px", fontSize: 12, fontWeight: 700,
                background: "#fef3c7", borderColor: "#2a2a2a",
                opacity: (!!top5Phase || !top5Concept.trim()) ? 0.5 : 1,
                cursor: (!!top5Phase || !top5Concept.trim()) ? "not-allowed" : "pointer",
              }}
            >
              {top5Phase ? "Working…" : "Generate Top 5 →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Image placeholder preview modal ────────────────────────────────────────

  function renderImagePreviewModal() {
    const ph = imagePreviewTarget;
    if (!ph) return null;
    return (
      <div
        onClick={(e) => { if (e.target === e.currentTarget && !imagePreviewWorking) setImagePreviewTarget(null); }}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 480, maxWidth: "95vw", fontFamily: "monospace", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>🖼 IMAGE PREVIEW</span>
            <button
              onClick={() => { if (!imagePreviewWorking) setImagePreviewTarget(null); }}
              style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15, opacity: imagePreviewWorking ? 0.4 : 1 }}
            >×</button>
          </div>

          <div style={{ padding: 16 }}>
            <img
              src={ph.imageUrl}
              alt={ph.title}
              style={{ width: "100%", maxHeight: 280, objectFit: "contain", display: "block", background: "#1a1a1a", border: "1.5px solid #2a2a2a" }}
            />
            <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ph.title}
            </div>
            {ph.sourceUrl && (
              <div style={{ fontSize: 10, color: "#6a6a6a", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {ph.sourceUrl}
              </div>
            )}

            {imagePreviewWorking && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#1a6fd4" }}>
                ⟳ Downloading image…
              </div>
            )}
            {imagePreviewError && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#cc2200" }}>
                ✗ {imagePreviewError}
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              onClick={() => removeImagePlaceholder(ph.id)}
              disabled={imagePreviewWorking}
              style={{ ...miniButton, padding: "6px 14px", fontSize: 11, color: "#cc2200", opacity: imagePreviewWorking ? 0.4 : 1 }}
            >
              Remove Suggestion
            </button>
            <button
              onClick={() => { if (!imagePreviewWorking) setImagePreviewTarget(null); }}
              disabled={imagePreviewWorking}
              style={{ ...miniButton, padding: "6px 14px", fontSize: 11, opacity: imagePreviewWorking ? 0.4 : 1 }}
            >
              Cancel
            </button>
            <button
              onClick={() => commitImagePlaceholder(ph)}
              disabled={imagePreviewWorking}
              style={{
                ...miniButton, padding: "6px 18px", fontSize: 12, fontWeight: 700,
                background: "#a8d8ff", borderColor: "#2a2a2a",
                opacity: imagePreviewWorking ? 0.5 : 1,
                cursor: imagePreviewWorking ? "not-allowed" : "pointer",
              }}
            >
              {imagePreviewWorking ? "Working…" : "Add to Board →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Mobile early returns ─────────────────────────────────────────────────

  // Mobile Top 5 Tinder flow — takes over the entire mobile experience.
  // mobileDesktopOverride lets the user escape to the desktop UI.
  if (isMobile && !mobileDesktopOverride) {
    return renderMobileTop5Flow();
  }

  // Below: existing mobile board (landscape) — only shown when mobileDesktopOverride is true
  if (isMobile && isPortrait) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#f5ecd8", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "monospace" }}>
        <div style={{ fontSize: 52, lineHeight: 1 }}>↻</div>
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 18, color: "#2a2a2a" }}>Rotate to landscape</div>
        <div style={{ fontSize: 11, color: "#6a6a6a", marginTop: 8, textAlign: "center", padding: "0 32px", lineHeight: 1.6 }}>Neural Board requires landscape mode</div>
      </div>
    );
  }

  if (isMobile) {
    const MOBILE_LAYER_H = 30;
    const MOBILE_TRACK_H = N_LAYERS * MOBILE_LAYER_H;
    const MOBILE_NARRATION_H = 28;
    const MOBILE_RULER_H = 28;

    return (
      <div style={{ ...pageStyle, overflow: "hidden", display: "flex", flexDirection: "column", height: "100dvh" }}>
        <div ref={videoHiddenContainerRef} style={{ display: "none" }} aria-hidden="true" />
        <input ref={mediaUploadRef} type="file" accept="image/*,video/*" multiple style={{ display: "none" }} onChange={handleMediaUpload} />
        <input ref={narrationUploadRef} type="file" accept="audio/*,video/mp4,video/quicktime,video/webm" style={{ display: "none" }} onChange={handleNarrationUpload} />
        <input ref={projectFileInputRef} type="file" accept=".nbp,.zip" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) loadBoard(f); }} />
        <style>{`@keyframes nbpulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

        {/* ── Compact header ── */}
        <header style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 8px", borderBottom: "1.5px dashed rgba(42,42,42,0.3)", background: "rgba(255,253,245,0.95)", zIndex: 10 }}>
          <button
            onClick={() => setMobileDrawer((d) => d === "media" ? null : "media")}
            style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, fontFamily: "monospace", background: mobileDrawer === "media" ? "#2a2a2a" : "transparent", color: mobileDrawer === "media" ? "#c8f135" : "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: "pointer", flexShrink: 0 }}
          >≡</button>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 19, fontWeight: 700, color: "#2a2a2a", flex: 1, minWidth: 0, lineHeight: 1, overflow: "hidden", whiteSpace: "nowrap" }}>Neural Board</span>
          <span style={{ fontFamily: "monospace", fontSize: 10, color: "#2a2a2a", letterSpacing: 0.5, border: "1px solid rgba(42,42,42,0.3)", padding: "2px 4px", background: "#fffdf5", flexShrink: 0 }}>
            {formatTime(playhead)}/{formatTime(timelineDuration)}
          </span>
          <button
            onClick={togglePlay}
            style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, background: isPlaying ? "#ff5e3a" : "#c8f135", color: isPlaying ? "#fff" : "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: "pointer", flexShrink: 0 }}
          >{isPlaying ? "⏸" : "▶"}</button>
          <button
            onClick={generateCameraKeyframes}
            disabled={!clips.some((c) => c.boardX !== undefined || c.type === "pan")}
            title="Generate camera keyframes"
            style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, background: "transparent", color: "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: "pointer", opacity: clips.some((c) => c.boardX !== undefined || c.type === "pan") ? 1 : 0.35, flexShrink: 0 }}
          >⬡</button>
          <button
            onClick={isExporting ? cancelExport : startExport}
            title={isExporting ? "Cancel export" : "Export video"}
            style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, background: isExporting ? "#ff5e3a" : "transparent", color: isExporting ? "#fff" : "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: "pointer", flexShrink: 0 }}
          >{isExporting ? "✕" : "⬇"}</button>
          <button
            onClick={() => setSaveModalOpen(true)}
            title="Save / load project"
            style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, background: "transparent", color: "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: "pointer", flexShrink: 0 }}
          >💾</button>
        </header>

        {/* ── Board ── */}
        <div
          ref={boardContainerRef}
          style={{ flex: 1, position: "relative", overflow: "hidden", touchAction: "none", minHeight: 0 }}
          onPointerDown={handleMobileBoardPointerDown}
          onPointerMove={handleMobileBoardPointerMove}
          onPointerUp={handleMobileBoardPointerUp}
          onPointerCancel={handleMobileBoardPointerUp}
        >
          {/* Board surface */}
          <div style={{ position: "absolute", left: boardPan.x, top: boardPan.y, width: BOARD_W * boardZoom, height: BOARD_H * boardZoom, background: "#f0ead6", border: "1.5px dashed rgba(42,42,42,0.2)" }}>
            {clips.filter((c) => c.boardX !== undefined).map((clip) => {
              const isSel = clip.id === selectedClipId;
              return (
                <div
                  key={clip.id}
                  data-mbclipid={clip.id}
                  style={{
                    position: "absolute",
                    left: clip.boardX! * boardZoom,
                    top: clip.boardY! * boardZoom,
                    width: clip.boardW! * boardZoom,
                    height: clip.boardH! * boardZoom,
                    border: isSel ? "2px solid #ff5e3a" : "1.5px solid rgba(42,42,42,0.4)",
                    boxShadow: isSel ? "0 0 0 2px #ff5e3a, 1px 1px 6px rgba(42,42,42,0.25)" : "1px 1px 4px rgba(42,42,42,0.2)",
                    touchAction: "none",
                  }}
                >
                  <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: clip.needsRedownload ? "auto" : "none" }}>
                    {clip.needsRedownload ? (
                      <div
                        style={{ width: "100%", height: "100%", background: "#1a1a2e", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3 }}
                        onClick={(e) => { e.stopPropagation(); redownloadYtClip(clip.id); }}
                      >
                        <span style={{ color: "#ff9f5e", fontSize: 16, pointerEvents: "none" }}>▶</span>
                        <span style={{ color: "#ff9f5e", fontSize: Math.max(6, 7 * boardZoom), fontFamily: "monospace", textAlign: "center", pointerEvents: "none" }}>tap to re-download</span>
                      </div>
                    ) : clip.type === "image" ? (
                      <img src={clip.sourceUrl} alt={clip.name} style={{ width: "100%", height: "100%", objectFit: "fill", display: "block" }} draggable={false} />
                    ) : (
                      <div style={{ width: "100%", height: "100%", background: "#1a1a2e", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ color: "#7df5b0", fontSize: Math.max(7, 10 * boardZoom), fontFamily: "monospace" }}>▶ {clip.name}</span>
                      </div>
                    )}
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "1px 3px", background: "rgba(42,42,42,0.7)", color: "#fff", fontSize: Math.max(6, 8 * boardZoom), fontFamily: "monospace", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", pointerEvents: "none" }}>
                      {clip.name}
                    </div>
                  </div>
                  {isSel && (
                    <div
                      style={{ position: "absolute", right: -7, bottom: -7, width: 28, height: 28, background: "#ff5e3a", border: "2px solid #fff", borderRadius: 3, zIndex: 20, touchAction: "none", display: "flex", alignItems: "center", justifyContent: "center" }}
                      onPointerDown={(e) => handleBoardResizePointerDown(e, clip, "se")}
                    >
                      <span style={{ color: "#fff", fontSize: 10, lineHeight: 1, pointerEvents: "none" }}>⤡</span>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Neural Search placeholders — not yet downloaded, tap to trim & add */}
            {neuralPlaceholders.map((ph) => (
              <div
                key={ph.id}
                style={{
                  position: "absolute",
                  left: ph.boardX * boardZoom,
                  top: ph.boardY * boardZoom,
                  width: ph.boardW * boardZoom,
                  height: ph.boardH * boardZoom,
                  border: "2px dashed #a855f7",
                  boxShadow: "1px 1px 4px rgba(42,42,42,0.2)",
                  touchAction: "none",
                  cursor: "pointer",
                }}
                onClick={() => openTrimModalForPlaceholder(ph)}
              >
                <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", background: "#1a1a2e" }}>
                  {ph.thumbnailUrl && (
                    <img src={ph.thumbnailUrl} alt={ph.title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: 0.85 }} draggable={false} />
                  )}
                  <div style={{ position: "absolute", top: 2, left: 2, padding: "1px 4px", background: "#a855f7", color: "#fff", fontSize: Math.max(6, 8 * boardZoom), fontFamily: "monospace", fontWeight: 700 }}>
                    🔮 NOT ADDED
                  </div>
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "1px 3px", background: "rgba(42,42,42,0.7)", color: "#fff", fontSize: Math.max(6, 8 * boardZoom), fontFamily: "monospace", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                    {ph.title} {ph.viewCount > 0 && `· ${formatViewCount(ph.viewCount)}`}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); removeNeuralPlaceholder(ph.id); }}
                  style={{ position: "absolute", top: -8, right: -8, width: 20, height: 20, borderRadius: "50%", background: "#ff5e3a", border: "2px solid #fff", color: "#fff", fontSize: 11, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20, touchAction: "none" }}
                >
                  ✕
                </button>
              </div>
            ))}

            {/* Neural Search image placeholders — not yet downloaded, tap to preview & add */}
            {imagePlaceholders.map((ph) => (
              <div
                key={ph.id}
                style={{
                  position: "absolute",
                  left: ph.boardX * boardZoom,
                  top: ph.boardY * boardZoom,
                  width: ph.boardW * boardZoom,
                  height: ph.boardH * boardZoom,
                  border: "2px dashed #3b82f6",
                  boxShadow: "1px 1px 4px rgba(42,42,42,0.2)",
                  touchAction: "none",
                  cursor: "pointer",
                }}
                onClick={() => setImagePreviewTarget(ph)}
              >
                <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", background: "#3a3a3a" }}>
                  <img
                    src={ph.imageUrl}
                    alt={ph.title}
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: 0.9 }}
                    draggable={false}
                    onError={() => removeImagePlaceholder(ph.id)}
                  />
                  <div style={{ position: "absolute", top: 2, left: 2, padding: "1px 4px", background: "#3b82f6", color: "#fff", fontSize: Math.max(6, 8 * boardZoom), fontFamily: "monospace", fontWeight: 700 }}>
                    🖼 NOT ADDED
                  </div>
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "1px 3px", background: "rgba(42,42,42,0.7)", color: "#fff", fontSize: Math.max(6, 8 * boardZoom), fontFamily: "monospace", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                    {ph.title}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); removeImagePlaceholder(ph.id); }}
                  style={{ position: "absolute", top: -8, right: -8, width: 20, height: 20, borderRadius: "50%", background: "#ff5e3a", border: "2px solid #fff", color: "#fff", fontSize: 11, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20, touchAction: "none" }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {clips.filter((c) => c.boardX !== undefined).length === 0 && neuralPlaceholders.length === 0 && imagePlaceholders.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
              <span style={{ fontFamily: "monospace", fontSize: 10, color: "rgba(42,42,42,0.35)", textAlign: "center" }}>Tap ≡ to add media</span>
            </div>
          )}

          <div style={{ position: "absolute", bottom: 6, left: 8, fontFamily: "monospace", fontSize: 8, color: "rgba(42,42,42,0.4)", pointerEvents: "none" }}>
            {Math.round(boardZoom * 100)}% · pinch to zoom
          </div>

          {/* Preview PiP */}
          <div style={{ position: "absolute", top: 6, right: 6, zIndex: 10, pointerEvents: "none" }}>
            <canvas
              ref={canvasRef}
              width={canvasW}
              height={canvasH}
              style={{ display: "block", width: Math.round(72 * canvasW / canvasH), height: 72, border: "1.5px solid #2a2a2a", background: "#111", boxShadow: "2px 2px 0 rgba(42,42,42,0.4)" }}
            />
          </div>

          {/* Export progress */}
          {isExporting && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(255,253,245,0.9)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
              <div style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: "#2a2a2a", marginBottom: 12 }}>Exporting… {Math.round(exportProgress * 100)}%</div>
              <div style={{ width: 160, height: 8, background: "rgba(42,42,42,0.15)", border: "1px solid #2a2a2a" }}>
                <div style={{ height: "100%", width: `${exportProgress * 100}%`, background: "#c8f135", transition: "width 0.1s" }} />
              </div>
              <button onClick={cancelExport} style={{ marginTop: 16, fontFamily: "monospace", fontSize: 11, background: "transparent", border: "1.5px solid #ff5e3a", color: "#ff5e3a", padding: "5px 14px", cursor: "pointer" }}>Cancel</button>
            </div>
          )}
        </div>

        {/* ── Timeline ── */}
        <div style={{ flexShrink: 0, background: "rgba(255,253,245,0.9)", borderTop: "1.5px solid rgba(42,42,42,0.15)" }}>
          {/* Ruler */}
          <div
            style={{ height: MOBILE_RULER_H, position: "relative", overflow: "hidden", borderBottom: "1px solid rgba(42,42,42,0.12)", background: "rgba(42,42,42,0.03)", touchAction: "none" }}
            onPointerDown={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const t = Math.max(0, (e.clientX - rect.left + (scrollerRef.current?.scrollLeft ?? 0)) / pxPerSecRef.current);
              playheadRef.current = t; setPlayhead(t); setIsPlaying(false);
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              const onMove = (ev: PointerEvent) => {
                const t2 = Math.max(0, (ev.clientX - rect.left + (scrollerRef.current?.scrollLeft ?? 0)) / pxPerSecRef.current);
                playheadRef.current = t2; setPlayhead(t2);
              };
              const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
              window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
            }}
          >
            <div style={{ position: "absolute", left: -timelineScroll, top: 0, width: timelineWidth + 200, height: "100%", pointerEvents: "none" }}>
              {rulerTicks()}
            </div>
            <div style={{ position: "absolute", left: playhead * pxPerSec - timelineScroll, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none" }} />
          </div>
          {/* Tracks */}
          <div
            ref={scrollerRef}
            style={{ height: MOBILE_TRACK_H + MOBILE_NARRATION_H + 12, overflowX: "auto", overflowY: "hidden", touchAction: "pan-x", position: "relative" }}
            onScroll={(e) => { const sl = (e.target as HTMLDivElement).scrollLeft; timelineScrollRef.current = sl; setTimelineScroll(sl); }}
          >
            <div style={{ position: "relative", width: Math.max(timelineWidth, 400), height: MOBILE_TRACK_H + MOBILE_NARRATION_H + 8, minWidth: "100%" }}>
              {Array.from({ length: N_LAYERS }, (_, i) => (
                <div key={i} style={{ position: "absolute", left: 0, right: 0, top: i * MOBILE_LAYER_H, height: MOBILE_LAYER_H, background: i % 2 === 0 ? "rgba(100,130,180,0.04)" : "rgba(100,130,180,0.09)", borderTop: i > 0 ? "1px solid rgba(42,42,42,0.05)" : "none" }} />
              ))}
              {Array.from({ length: N_LAYERS }, (_, i) => (
                <button
                  key={`mute-${i}`}
                  title={mutedLayers[i] ? `Unmute layer L${i}` : `Mute layer L${i}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); toggleLayerMute(i); }}
                  style={{
                    position: "absolute",
                    left: timelineScroll + 2,
                    top: i * MOBILE_LAYER_H + 1,
                    zIndex: 20,
                    width: 20,
                    height: 16,
                    padding: 0,
                    border: "1px solid rgba(42,42,42,0.35)",
                    background: mutedLayers[i] ? "#ff5e3a" : "rgba(255,253,245,0.88)",
                    color: mutedLayers[i] ? "#fff" : "#2a2a2a",
                    fontSize: 8,
                    lineHeight: "14px",
                    fontFamily: "monospace",
                    touchAction: "manipulation",
                  }}
                >
                  {mutedLayers[i] ? "×" : `L${i}`}
                </button>
              ))}
              <div style={{ position: "absolute", left: 0, right: 0, top: MOBILE_TRACK_H + 4, height: MOBILE_NARRATION_H, background: "rgba(255,150,200,0.07)", borderTop: "1px dashed rgba(42,42,42,0.18)" }} />

              {clips.filter((c) => c.type !== "narration").map((clip, ci) => {
                const color = clip.type === "pan" ? PAN_CLIP_COLOR : CLIP_COLORS[ci % CLIP_COLORS.length];
                const isSel = clip.id === selectedClipId;
                const clipPx = Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSec);
                const layer = clip.layer ?? 1;
                return (
                  <div
                    key={clip.id}
                    style={{
                      position: "absolute",
                      left: clip.startTime * pxPerSec,
                      top: layer * MOBILE_LAYER_H + 2,
                      width: clipPx,
                      height: MOBILE_LAYER_H - 4,
                      background: color,
                      border: isSel ? "2px solid #2a2a2a" : "1.5px solid rgba(42,42,42,0.35)",
                      boxShadow: isSel ? "2px 2px 0 #2a2a2a" : "none",
                      touchAction: "none",
                      overflow: "hidden",
                    }}
                    onPointerDown={(e) => handleClipPointerDown(e, clip, "move")}
                    onClick={(e) => { e.stopPropagation(); setSelectedClipId(clip.id); setMobileDrawer("props"); }}
                  >
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.22)", touchAction: "none" }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-left")} />
                    <span style={{ position: "absolute", left: HANDLE_W + 3, right: HANDLE_W + 3, top: "50%", transform: "translateY(-50%)", fontFamily: "monospace", fontSize: 8, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", color: "#2a2a2a", pointerEvents: "none" }}>
                      {clip.type === "pan" ? "⟷ Pan" : clip.name}
                    </span>
                    <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.22)", touchAction: "none" }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-right")} />
                  </div>
                );
              })}

              {clips.filter((c) => c.type === "narration").map((clip) => {
                const isSel = clip.id === selectedClipId;
                const clipPx = Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSec);
                return (
                  <div
                    key={clip.id}
                    style={{
                      position: "absolute",
                      left: clip.startTime * pxPerSec,
                      top: MOBILE_TRACK_H + 6,
                      width: clipPx,
                      height: MOBILE_NARRATION_H,
                      background: NARRATION_COLOR,
                      border: isSel ? "1.5px solid #2a2a2a" : "1px solid rgba(180,80,130,0.4)",
                      overflow: "hidden",
                      touchAction: "none",
                    }}
                    onPointerDown={(e) => handleClipPointerDown(e, clip, "move")}
                    onClick={(e) => { e.stopPropagation(); setSelectedClipId(clip.id); setMobileDrawer("props"); }}
                  >
                    <span style={{ position: "absolute", left: 4, right: HANDLE_W + 2, top: "50%", transform: "translateY(-50%)", fontFamily: "monospace", fontSize: 8, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", color: "#5a1530", pointerEvents: "none" }}>
                      🎙 {clip.name}
                    </span>
                    <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.15)", touchAction: "none" }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-right")} />
                  </div>
                );
              })}

              <div style={{ position: "absolute", left: playhead * pxPerSec, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none", zIndex: 10 }} />
            </div>
          </div>
        </div>

        {/* ── Bottom drawer ── */}
        {mobileDrawer && (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 100 }} onClick={() => setMobileDrawer(null)} />
            <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 101, background: "#fffdf5", borderTop: "2px solid #2a2a2a", padding: "12px 16px 28px", boxShadow: "0 -4px 24px rgba(0,0,0,0.18)", maxHeight: "55vh", overflowY: "auto" }}>
              <div style={{ width: 32, height: 3, background: "rgba(42,42,42,0.28)", borderRadius: 2, margin: "0 auto 14px" }} />

              {mobileDrawer === "media" && (
                <>
                  <div style={{ fontFamily: "monospace", fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: "#6a6a6a", textTransform: "uppercase", marginBottom: 12 }}>Add Media</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <button onClick={() => { mediaUploadRef.current?.click(); setMobileDrawer(null); }} style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13 }}>
                      ↑  Upload photo / video
                    </button>
                    <button onClick={() => { setYtModalOpen(true); setYtView("search"); setYtTab("search"); setYtError(""); setMobileDrawer(null); }} style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13 }}>
                      ▶  Add YouTube clip
                    </button>
                    <button onClick={() => { addPanClip(); setMobileDrawer(null); }} style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13, background: PAN_CLIP_COLOR }}>
                      ⟷  Add pan clip
                    </button>
                    <ProGated featureName="Neural Search">
                      <button
                        onClick={() => { setNeuralModalOpen(true); setNeuralConcept(""); setNeuralError(""); setNeuralPhase(null); setMobileDrawer(null); }}
                        style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13, background: "#e4cfff" }}
                      >
                        🔮  Neural Search
                      </button>
                    </ProGated>
                    <ProGated featureName="Top 5 Neural Search">
                      <button
                        onClick={() => { setTop5ModalOpen(true); setTop5Concept(""); setTop5Error(""); setTop5Phase(null); setMobileDrawer(null); }}
                        style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13, background: "#fef3c7" }}
                      >
                        🏆  Top 5
                      </button>
                    </ProGated>
                    <ProGated featureName="Narration Recording">
                      <button
                        onClick={() => { if (isRecording) stopNarrationRecording(); else startNarrationRecording(); setMobileDrawer(null); }}
                        style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13, background: isRecording ? "#ff5e3a" : "#2a2a2a", color: "#fff" }}
                      >
                        {isRecording ? "⏹  Stop narration" : "🎙  Record narration"}
                      </button>
                      <button
                        onClick={() => { narrationUploadRef.current?.click(); setMobileDrawer(null); }}
                        style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13 }}
                      >
                        ↑  Upload audio / mp4
                      </button>
                    </ProGated>
                    <div style={{ width: "100%", height: 1, background: "rgba(42,42,42,0.15)", margin: "4px 0" }} />
                    <button
                      onClick={() => { setSaveModalOpen(true); setMobileDrawer(null); }}
                      style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13 }}
                    >
                      💾  Save project
                    </button>
                    <button
                      onClick={() => { projectFileInputRef.current?.click(); setMobileDrawer(null); }}
                      style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13 }}
                    >
                      📂  Open project
                    </button>
                  </div>
                </>
              )}

              {mobileDrawer === "props" && selectedClip && (
                <>
                  <div style={{ fontFamily: "monospace", fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: "#6a6a6a", textTransform: "uppercase", marginBottom: 12 }}>
                    {selectedClip.type === "pan" ? "⟷ Pan clip" : selectedClip.type === "narration" ? "🎙 Narration" : selectedClip.name.slice(0, 28)}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <div style={{ ...panelLabelStyle, marginBottom: 6 }}>Duration (s)</div>
                      <input
                        type="number" inputMode="decimal" step={0.1} min={0.1}
                        value={selectedClip.duration.toFixed(2)}
                        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0.1) setClips((prev) => prev.map((c) => c.id === selectedClipId ? { ...c, duration: v } : c)); }}
                        style={{ width: "100%", fontFamily: "monospace", fontSize: 16, padding: "10px", border: "1.5px solid #2a2a2a", background: "#fff", boxSizing: "border-box" } as React.CSSProperties}
                      />
                    </div>
                    {selectedClip.type !== "narration" && (
                      <div>
                        <div style={{ ...panelLabelStyle, marginBottom: 6 }}>
                          Hold {Math.round((selectedClip.holdFraction ?? HOLD_FRACTION) * 100)}% · Trans {Math.round((1 - (selectedClip.holdFraction ?? HOLD_FRACTION)) * 100)}%
                        </div>
                        <input
                          type="range" min={0.1} max={0.95} step={0.01}
                          value={selectedClip.holdFraction ?? HOLD_FRACTION}
                          onChange={(e) => { const v = parseFloat(e.target.value); if (cameraKeyframesRef.current.length > 0) setKeyframesOutOfDate(true); setClips((prev) => prev.map((c) => c.id === selectedClipId ? { ...c, holdFraction: v } : c)); }}
                          style={{ width: "100%", accentColor: "#c8f135" }}
                        />
                      </div>
                    )}
                    {(selectedClip.type === "video" || selectedClip.type === "narration") && (
                      <div>
                        <div style={{ ...panelLabelStyle, marginBottom: 6 }}>Volume {Math.round((selectedClip.muted ? 0 : (selectedClip.volume ?? 1)) * 100)}%</div>
                        <input
                          type="range" min={0} max={1} step={0.01}
                          value={selectedClip.muted ? 0 : (selectedClip.volume ?? 1)}
                          onChange={(e) => { const v = parseFloat(e.target.value); setClips((prev) => prev.map((c) => c.id === selectedClipId ? { ...c, volume: v, muted: false } : c)); }}
                          style={{ width: "100%", accentColor: "#c8f135" }}
                        />
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => copyClip(selectedClipId!)} style={{ ...miniButton, flex: 1, padding: "8px", fontSize: 12 }}>⌘ Copy</button>
                      <button onClick={() => { duplicateClip(selectedClipId!); setMobileDrawer(null); }} style={{ ...miniButton, flex: 1, padding: "8px", fontSize: 12 }}>⎘ Dup</button>
                    </div>
                    <button
                      onClick={() => { deleteClip(selectedClipId!); setMobileDrawer(null); }}
                      style={{ ...miniButton, color: "#ff5e3a", borderColor: "#ff5e3a", width: "100%", padding: "10px", fontSize: 13, textAlign: "center" }}
                    >✕ Delete clip</button>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* ── Long-press action sheet ── */}
        {mobileLongPressClipId && (
          <>
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 300 }} onClick={() => setMobileLongPressClipId(null)} />
            <div style={{ position: "fixed", left: 16, right: 16, bottom: 36, zIndex: 301, background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a" }}>
              <div onClick={() => { copyClip(mobileLongPressClipId); setMobileLongPressClipId(null); }} style={{ padding: "14px 16px", fontFamily: "monospace", fontSize: 13, borderBottom: "1px solid rgba(42,42,42,0.08)", cursor: "pointer", touchAction: "manipulation" }}>⌘ Copy</div>
              <div onClick={() => { duplicateClip(mobileLongPressClipId); setMobileLongPressClipId(null); }} style={{ padding: "14px 16px", fontFamily: "monospace", fontSize: 13, borderBottom: "1px solid rgba(42,42,42,0.08)", cursor: "pointer", touchAction: "manipulation" }}>⎘ Duplicate</div>
              <div onClick={() => { deleteClip(mobileLongPressClipId); setMobileLongPressClipId(null); }} style={{ padding: "14px 16px", fontFamily: "monospace", fontSize: 13, color: "#ff5e3a", cursor: "pointer", touchAction: "manipulation" }}>✕ Delete</div>
            </div>
          </>
        )}

        {/* ── YouTube modal (shared with desktop) ── */}
        {ytModalOpen && (
          <div
            onClick={(e) => { if (e.target === e.currentTarget) setYtModalOpen(false); }}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 640, maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", fontFamily: "monospace", overflow: "hidden" }}>
              <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>
                  {ytView === "search" ? "▶ ADD YOUTUBE CLIP" : `▶ TRIM  —  ${(ytSelected?.title ?? "").slice(0, 45)}${(ytSelected?.title?.length ?? 0) > 45 ? "…" : ""}`}
                </span>
                <button onClick={() => setYtModalOpen(false)} style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15 }}>×</button>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
                {ytView === "search" ? (
                  <>
                    <div style={{ display: "flex", marginBottom: 14, borderBottom: "1.5px solid #2a2a2a" }}>
                      {(["paste", "search"] as const).map((tab) => (
                        <button key={tab} onClick={() => { setYtTab(tab); setYtError(""); }}
                          style={{ fontFamily: "monospace", padding: "6px 14px", fontSize: 11, fontWeight: ytTab === tab ? 700 : 400, background: ytTab === tab ? "#2a2a2a" : "transparent", color: ytTab === tab ? "#fffdf5" : "#2a2a2a", border: "none", borderBottom: ytTab === tab ? "2px solid #c8f135" : "none", cursor: "pointer" }}>
                          {tab === "paste" ? "Paste URL" : "Search"}
                        </button>
                      ))}
                    </div>
                    {ytTab === "paste" ? (
                      <div>
                        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                          <input autoFocus type="text" value={ytUrlInput}
                            onChange={(e) => setYtUrlInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleYtPasteUrl(); }}
                            placeholder="https://www.youtube.com/watch?v=..."
                            style={{ flex: 1, fontFamily: "monospace", fontSize: 12, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a" }}
                          />
                          <button onClick={handleYtPasteUrl} style={{ ...miniButton, padding: "8px 16px", fontSize: 12, fontWeight: 700 }}>Next →</button>
                        </div>
                        {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, margin: 0 }}>{ytError}</p>}
                        <p style={{ fontSize: 10, color: "#9a9a9a", lineHeight: 1.6, marginTop: 10 }}>Paste a YouTube URL — you&apos;ll trim it in the next step.</p>
                      </div>
                    ) : (
                      /* Search tab — identical to desktop render, references same state */
                      (() => {
                        return (
                          <div>
                            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                              <input autoFocus type="text" value={ytQuery}
                                onChange={(e) => setYtQuery(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") handleYtSearch(); }}
                                placeholder="Search YouTube…"
                                style={{ flex: 1, fontFamily: "monospace", fontSize: 12, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a" }}
                              />
                              <button onClick={() => handleYtSearch()} disabled={ytLoading || !ytQuery.trim()}
                                style={{ ...miniButton, padding: "8px 16px", fontSize: 12, fontWeight: 700, opacity: (ytLoading || !ytQuery.trim()) ? 0.5 : 1 }}>
                                {ytLoading ? "…" : "Search"}
                              </button>
                            </div>
                            <div style={{ display: "flex", gap: 0, marginBottom: 12, border: "1.5px solid #2a2a2a", width: "fit-content" }}>
                              {([["All", false], ["Shorts", true]] as const).map(([label, val]) => {
                                const active = ytShortsOnly === val;
                                return (
                                  <button key={label} onClick={() => setYtShortsOnly(val)}
                                    style={{ ...miniButton, fontSize: 11, padding: "4px 8px", background: active ? "#2a2a2a" : "transparent", color: active ? "#fffdf5" : "#2a2a2a", marginRight: label === "Shorts" ? -1 : 0, position: "relative", zIndex: active ? 1 : 0 }}>
                                    {label}
                                  </button>
                                );
                              })}
                            </div>
                            {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, marginBottom: 8, marginTop: 0 }}>{ytError}</p>}
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {ytResults.map((r) => (
                                <div key={r.id} onClick={() => {
                                  const maxSec = parseDurationSec(r.duration);
                                  const initEnd = Math.min(30, maxSec || 30);
                                  setYtSelected(r);
                                  setYtStart(0); setYtStartInput("0:00");
                                  setYtEnd(initEnd); setYtEndInput(formatTimestamp(initEnd));
                                  ytRangeRef.current = { start: 0, end: initEnd };
                                  setYtView("trim");
                                }}
                                  style={{ display: "flex", gap: 10, padding: "8px", border: "1.5px solid rgba(42,42,42,0.2)", cursor: "pointer", background: ytSelected?.id === r.id ? "#c8f135" : "transparent" }}>
                                  {r.thumbnail && <img src={r.thumbnail} alt="" style={{ width: 80, height: 45, objectFit: "cover", flexShrink: 0 }} />}
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 700, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
                                    <div style={{ fontSize: 10, color: "#6a6a6a", marginTop: 2 }}>{r.channel} {r.duration ? `· ${r.duration}` : ""}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()
                    )}
                  </>
                ) : (
                  <>
                    {(() => {
                      const maxSec = parseDurationSec(ytSelected?.duration) || 600;
                      const clipLen = Math.max(0, ytEnd - ytStart);
                      return (
                        <div>
                          <div style={{ marginBottom: 12, fontWeight: 700, fontSize: 12, color: "#2a2a2a" }}>Set trim range (max 30 s)</div>
                          <div ref={ytSliderTrackRef}
                            style={{ position: "relative", height: 36, background: "rgba(42,42,42,0.06)", border: "1.5px solid #2a2a2a", marginBottom: 10, cursor: "pointer" }}
                            onPointerDown={(e) => {
                              const rect = ytSliderTrackRef.current!.getBoundingClientRect();
                              const frac = (e.clientX - rect.left) / rect.width;
                              const t = frac * maxSec;
                              const distStart = Math.abs(t - ytRangeRef.current.start);
                              const distEnd = Math.abs(t - ytRangeRef.current.end);
                              const which = distStart < distEnd ? "start" : "end";
                              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                              const onMove = (ev: PointerEvent) => {
                                const f2 = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
                                const newT = f2 * maxSec;
                                if (which === "start") {
                                  const newStart = Math.min(newT, ytRangeRef.current.end - 0.5);
                                  if (ytRangeRef.current.end - newStart > 30) { ytRangeRef.current.start = ytRangeRef.current.end - 30; }
                                  else { ytRangeRef.current.start = newStart; }
                                  setYtStart(ytRangeRef.current.start); setYtStartInput(formatTimestamp(ytRangeRef.current.start));
                                } else {
                                  const newEnd = Math.max(newT, ytRangeRef.current.start + 0.5);
                                  const clampedEnd = Math.min(maxSec, newEnd);
                                  if (clampedEnd - ytRangeRef.current.start > 30) { ytRangeRef.current.end = ytRangeRef.current.start + 30; }
                                  else { ytRangeRef.current.end = clampedEnd; }
                                  setYtEnd(ytRangeRef.current.end); setYtEndInput(formatTimestamp(ytRangeRef.current.end));
                                }
                              };
                              const onUp2 = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp2); };
                              window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp2);
                            }}
                          >
                            <div style={{ position: "absolute", top: 0, bottom: 0, left: `${(ytStart / maxSec) * 100}%`, width: `${((ytEnd - ytStart) / maxSec) * 100}%`, background: "rgba(200,241,53,0.45)", border: "2px solid #2a2a2a" }} />
                            <div style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: `${(ytStart / maxSec) * 100}%`, width: 10, height: 24, background: "#2a2a2a", cursor: "ew-resize", marginLeft: -5 }} />
                            <div style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: `${(ytEnd / maxSec) * 100}%`, width: 10, height: 24, background: "#2a2a2a", cursor: "ew-resize", marginLeft: -5 }} />
                          </div>
                          <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 3 }}>Start</div>
                              <input type="text" value={ytStartInput} placeholder="0:00"
                                onChange={(e) => {
                                  setYtStartInput(e.target.value);
                                  const p = parseTimestampSec(e.target.value);
                                  if (p !== null) {
                                    const curEnd = ytRangeRef.current.end;
                                    const newStart = Math.max(0, Math.min(curEnd - 0.5, p));
                                    ytRangeRef.current.start = newStart; setYtStart(newStart);
                                    if (curEnd - newStart > 30) { const newEnd = newStart + 30; ytRangeRef.current.end = newEnd; setYtEnd(newEnd); setYtEndInput(formatTimestamp(newEnd)); }
                                  }
                                }}
                                onBlur={() => setYtStartInput(formatTimestamp(ytStart))}
                                style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties}
                              />
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 3 }}>End</div>
                              <input type="text" value={ytEndInput} placeholder="0:30"
                                onChange={(e) => {
                                  setYtEndInput(e.target.value);
                                  const p = parseTimestampSec(e.target.value);
                                  if (p !== null) {
                                    const newEnd = Math.max(ytRangeRef.current.start + 0.5, Math.min(maxSec, Math.min(p, ytRangeRef.current.start + 30)));
                                    ytRangeRef.current.end = newEnd; setYtEnd(newEnd);
                                  }
                                }}
                                onBlur={() => setYtEndInput(formatTimestamp(ytEnd))}
                                style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties}
                              />
                            </div>
                          </div>
                          <div style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>
                            Clip length: {formatTimestamp(clipLen)}<span style={{ marginLeft: 8 }}>· {formatTimestamp(maxSec)} total</span>
                          </div>
                          {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, fontFamily: "monospace", marginTop: 6, marginBottom: 0 }}>{ytError}</p>}
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
              {ytView === "trim" && (
                <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, alignItems: "center" }}>
                  <button onClick={() => { setYtView("search"); setYtSelected(null); setYtError(""); }} style={{ ...miniButton, padding: "6px 12px", fontSize: 11 }}>← back</button>
                  <button onClick={handleYtConfirm}
                    style={{ ...miniButton, marginLeft: "auto", padding: "6px 18px", fontSize: 12, fontWeight: 700, background: "#c8f135", borderColor: "#2a2a2a" }}>
                    Add to board
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Toast ── */}
        {toast && (
          <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#2a2a2a", color: "#c8f135", fontFamily: "monospace", fontSize: 11, padding: "8px 16px", border: "1.5px solid #c8f135", boxShadow: "2px 2px 0 #c8f135", zIndex: 9999, pointerEvents: "none", whiteSpace: "nowrap" }}>
            {toast}
          </div>
        )}
        {renderDownloadToasts()}
        {renderNeuralSearchModal()}
        {renderTop5Modal()}
        {renderImagePreviewModal()}

        {/* ── Save modal ── */}
        {saveModalOpen && (
          <div style={{ position: "fixed", inset: 0, zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }} onClick={() => setSaveModalOpen(false)}>
            <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", padding: "24px 28px", minWidth: 280, width: "calc(100vw - 48px)", maxWidth: 360, boxShadow: "4px 4px 0 #2a2a2a" }} onClick={(e) => e.stopPropagation()}>
              <div style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "#6a6a6a", textTransform: "uppercase", marginBottom: 14 }}>Save project</div>
              <input
                type="text" value={saveName} onChange={(e) => setSaveName(e.target.value)}
                placeholder="Board name" autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") saveBoard(); if (e.key === "Escape") setSaveModalOpen(false); }}
                style={{ width: "100%", fontFamily: "monospace", fontSize: 16, padding: "12px 10px", border: "1.5px solid #2a2a2a", background: "#fff", boxSizing: "border-box" as const, marginBottom: 14, outline: "none" }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={saveBoard} disabled={isSaving} style={{ ...sketchButton, flex: 1, background: "#c8f135", fontWeight: 700, padding: "10px 0" }}>
                  {isSaving ? "Saving…" : "💾 Download .nbp"}
                </button>
                <button onClick={() => setSaveModalOpen(false)} style={{ ...sketchButton, flex: 1, padding: "10px 0" }}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Save / Load ──────────────────────────────────────────────────────────

  async function saveBoard() {
    if (isSaving) return;
    setIsSaving(true);
    setToast("Saving…");
    try {
      type ManifestClip = Omit<Clip, "sourceUrl" | "audioBlob"> & {
        assetFile?: string;
        assetMime?: string;
      };
      const manifestClips: ManifestClip[] = [];
      const zipFiles: Record<string, [Uint8Array, { level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }]> = {};

      for (const clip of clipsRef.current) {
        const { sourceUrl: _s, audioBlob: _a, sourceBlob: _b, ...rest } = clip;
        if (clip.type === "pan") {
          manifestClips.push(rest);
        } else if (clip.youtubeId) {
          manifestClips.push({ ...rest, needsRedownload: true });
        } else if (clip.type === "narration" && clip.audioBlob) {
          const buf = await clip.audioBlob.arrayBuffer();
          const assetFile = `assets/${clip.id}.${mimeToExt(clip.audioBlob.type, clip.name)}`;
          zipFiles[assetFile] = [new Uint8Array(buf), { level: 0 }];
          manifestClips.push({ ...rest, assetFile, assetMime: clip.audioBlob.type || "audio/wav" });
        } else if (clip.sourceUrl) {
          const blob = await fetch(clip.sourceUrl).then((r) => r.blob());
          const ext = mimeToExt(blob.type, clip.name);
          const assetFile = `assets/${clip.id}.${ext}`;
          const buf = await blob.arrayBuffer();
          zipFiles[assetFile] = [new Uint8Array(buf), { level: 0 }];
          manifestClips.push({ ...rest, assetFile, assetMime: blob.type });
        } else {
          manifestClips.push(rest);
        }
      }

      const manifest = {
        version: 1,
        name: saveName,
        savedAt: new Date().toISOString(),
        clips: manifestClips,
        cameraKeyframes: cameraKeyframesRef.current,
        annotations: annotationsRef.current,
        canvasAspect,
        pxPerSec: pxPerSecRef.current,
        boardZoom: boardZoomRef.current,
        boardPan: boardPanRef.current,
        characterActions: characterActionsRef.current,
        showCharacter: showCharacterRef.current,
        characterMode: characterModeRef.current,
      };
      zipFiles["manifest.json"] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];

      const zipped = zipSync(zipFiles);
      const dlBlob = new Blob([zipped], { type: "application/zip" });
      const url = URL.createObjectURL(dlBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(saveName || "board").replace(/[^a-z0-9_-]/gi, "_")}.nbp`;
      a.click();
      URL.revokeObjectURL(url);
      setSaveModalOpen(false);
      setToast("Board saved!");
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Save failed");
    } finally {
      setIsSaving(false);
    }
  }

  async function loadBoard(file: File) {
    if (isLoadingProject) return;
    setIsLoadingProject(true);
    setToast("Loading project…");
    try {
      const buffer = await file.arrayBuffer();
      const files = unzipSync(new Uint8Array(buffer));
      if (!files["manifest.json"]) throw new Error("Not a valid .nbp file");
      const manifest = JSON.parse(strFromU8(files["manifest.json"]));

      // Revoke existing blob URLs
      for (const clip of clipsRef.current) {
        if (clip.sourceUrl?.startsWith("blob:")) URL.revokeObjectURL(clip.sourceUrl);
      }
      // Clean up all video elements
      for (const vid of videoElsRef.current.values()) { vid.pause(); vid.src = ""; }
      videoElsRef.current.clear();
      imgCacheRef.current.clear();

      const loadedClips: Clip[] = [];
      for (const mc of (manifest.clips ?? [])) {
        if (mc.type === "pan") {
          loadedClips.push({ ...mc, sourceUrl: "" });
        } else if (mc.needsRedownload) {
          loadedClips.push({ ...mc, sourceUrl: "" });
        } else if (mc.assetFile && files[mc.assetFile]) {
          const data = files[mc.assetFile];
          const blob = new Blob([data], { type: mc.assetMime || "application/octet-stream" });
          const blobUrl = URL.createObjectURL(blob);
          if (mc.type === "narration") {
            loadedClips.push({ ...mc, sourceUrl: blobUrl, audioBlob: blob });
          } else if (mc.type === "image") {
            loadMedia(blobUrl, "image");
            loadedClips.push({ ...mc, sourceUrl: blobUrl });
          } else if (mc.type === "video") {
            createVideoElement(mc.id, blobUrl);
            loadedClips.push({ ...mc, sourceUrl: blobUrl });
          }
        } else {
          loadedClips.push({ ...mc, sourceUrl: mc.sourceUrl ?? "" });
        }
      }

      setClips(loadedClips);
      setCameraKeyframes(manifest.cameraKeyframes ?? []);
      setAnnotations(manifest.annotations ?? []);
      if (manifest.canvasAspect) setCanvasAspect(manifest.canvasAspect);
      if (manifest.pxPerSec) { pxPerSecRef.current = manifest.pxPerSec; setPxPerSec(manifest.pxPerSec); }
      if (manifest.boardZoom) { boardZoomRef.current = manifest.boardZoom; setBoardZoom(manifest.boardZoom); }
      if (manifest.boardPan) { boardPanRef.current = manifest.boardPan; setBoardPan(manifest.boardPan); }
      if (manifest.name) setSaveName(manifest.name);
      if (manifest.characterActions) setCharacterActions(manifest.characterActions);
      if (manifest.showCharacter !== undefined) setShowCharacter(manifest.showCharacter);
      if (manifest.characterMode) setCharacterMode(manifest.characterMode);
      setToast(`Loaded "${manifest.name ?? "board"}"`);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Failed to load project");
    } finally {
      setIsLoadingProject(false);
    }
  }

  async function redownloadYtClip(clipId: string) {
    const clip = clipsRef.current.find((c) => c.id === clipId);
    if (!clip?.youtubeId) return;
    setToast("Re-downloading video…");
    try {
      const dlRes = await fetch("/api/ytdl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${clip.youtubeId}`, start: clip.ytStart ?? 0, end: clip.ytEnd ?? 30 }),
      });
      if (!dlRes.ok) {
        const err = await dlRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Download failed (${dlRes.status})`);
      }
      const blob = await dlRes.blob();
      const blobUrl = URL.createObjectURL(blob);
      createVideoElement(clipId, blobUrl);
      setClips((prev) => prev.map((c) => c.id !== clipId ? c : { ...c, sourceUrl: blobUrl, sourceBlob: blob, needsRedownload: false }));
      setToast("Video ready");
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Re-download failed");
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={pageStyle}>
      <div ref={videoHiddenContainerRef} style={{ display: "none" }} aria-hidden="true" />
      <style>{`@keyframes nbpulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      {/* ── Header ── */}
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: "#2a2a2a" }}>Neural Board</span>
          <span style={{ fontSize: 11, color: "#6a6a6a", letterSpacing: 1, fontFamily: "monospace" }}>/ BOARD 2.0</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              onClick={generateCameraKeyframes}
              disabled={!clips.some((c) => c.boardX !== undefined || c.type === "pan")}
              title={clips.some((c) => c.boardX !== undefined || c.type === "pan")
                ? "Generate camera keyframe sequence from board positions and timeline"
                : "Upload media first"}
              style={{
                ...sketchButton,
                padding: "4px 10px",
                fontSize: 11,
                opacity: clips.some((c) => c.boardX !== undefined || c.type === "pan") ? 1 : 0.45,
                cursor: clips.some((c) => c.boardX !== undefined || c.type === "pan") ? "pointer" : "not-allowed",
              }}
            >
              ⬡ Generate camera keyframes
            </button>
            {keyframesOutOfDate && cameraKeyframes.length > 0 && (
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#ff5e3a", border: "1px solid #ff5e3a", padding: "2px 5px", whiteSpace: "nowrap" }}>
                ↻ keyframes out of date
              </span>
            )}
          </div>
          <button onClick={() => setSaveModalOpen(true)} style={{ ...sketchButton, padding: "4px 10px", fontSize: 11 }} title="Save board to file">💾 Save</button>
          <button onClick={() => projectFileInputRef.current?.click()} disabled={isLoadingProject} style={{ ...sketchButton, padding: "4px 10px", fontSize: 11, opacity: isLoadingProject ? 0.5 : 1 }} title="Load board from .nbp file">📂 Load</button>
          <a href="/editor" style={navLinkStyle}>Editor</a>
          <span style={{ ...navLinkStyle, color: "#2a2a2a", fontWeight: 700 }}>Board</span>
          {session?.user ? (
            <span style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>{session.user.email}</span>
          ) : (
            <button
              onClick={() => signIn("google", { callbackUrl: "/board2" })}
              style={{ fontFamily: "monospace", background: "transparent", border: "1px solid #2a2a2a", padding: "3px 8px", cursor: "pointer", fontSize: 10 }}
            >
              sign in →
            </button>
          )}
        </div>
      </header>

      {/* ── Main workspace ── */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column", overflow: "hidden" }}>

        {/* Top row: media | board+preview | properties */}
        <div style={{ display: "flex", flex: 1, minHeight: 0, borderBottom: "1.5px solid rgba(42,42,42,0.15)" }}>

          {/* ── Left: media library ── */}
          <div style={{ width: 210, flexShrink: 0, borderRight: "1.5px solid rgba(42,42,42,0.15)", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", background: "rgba(255,253,245,0.65)" }}>
            <div style={panelLabelStyle}>Media Library</div>
            <button onClick={() => mediaUploadRef.current?.click()} style={sketchButton}>↑ Upload media</button>
            <button
              onClick={() => addPanClip()}
              style={{ ...sketchButton, background: PAN_CLIP_COLOR, fontSize: 11, padding: "6px 10px", fontWeight: 700 }}
              title="Add a pan clip that sweeps across all board images"
            >
              ⟷ Add pan clip
            </button>
            <button
              onClick={() => { setYtModalOpen(true); setYtView("search"); setYtTab("search"); setYtError(""); }}
              style={{ ...sketchButton, fontSize: 11, padding: "6px 10px", fontWeight: 700 }}
            >
              ▶ Add YouTube
            </button>

            <ProGated featureName="Neural Search">
              <button
                onClick={() => { setNeuralModalOpen(true); setNeuralConcept(""); setNeuralError(""); setNeuralPhase(null); }}
                style={{ ...sketchButton, fontSize: 11, padding: "6px 10px", fontWeight: 700, width: "100%", background: "#e4cfff" }}
              >
                🔮 Neural Search
              </button>
            </ProGated>

            <ProGated featureName="Top 5 Neural Search">
              <button
                onClick={() => { setTop5ModalOpen(true); setTop5Concept(""); setTop5Error(""); setTop5Phase(null); }}
                style={{ ...sketchButton, fontSize: 11, padding: "6px 10px", fontWeight: 700, width: "100%", background: "#fef3c7" }}
              >
                🏆 Top 5
              </button>
            </ProGated>

            <ProGated featureName="Narration Recording">
              <button
                onClick={isRecording ? stopNarrationRecording : startNarrationRecording}
                style={{
                  ...sketchButton,
                  fontSize: 11, padding: "6px 10px", fontWeight: 700, width: "100%",
                  background: isRecording ? "#ff5e3a" : "#2a2a2a",
                  color: "#fff",
                }}
              >
                {isRecording ? (
                  <>⏹ Stop ({Math.floor(recElapsed / 60)}:{String(Math.floor(recElapsed % 60)).padStart(2, "0")})</>
                ) : "🎙 Record Narration"}
              </button>
              <button
                onClick={() => narrationUploadRef.current?.click()}
                style={{ ...sketchButton, fontSize: 11, padding: "6px 10px", fontWeight: 700, width: "100%" }}
              >
                ↑ Upload audio / mp4
              </button>
              <input
                ref={narrationUploadRef}
                type="file"
                accept="audio/*,video/mp4,video/quicktime,video/webm"
                style={{ display: "none" }}
                onChange={handleNarrationUpload}
              />
            </ProGated>
            {isRecording && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#ff5e3a", fontFamily: "monospace" }}>
                <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#ff5e3a", animation: "nbpulse 1s infinite" }} />
                recording...
              </div>
            )}

            <div style={{ width: "100%", height: 1, background: "rgba(42,42,42,0.15)", margin: "4px 0" }} />

            <ProGated featureName="AI Annotation Generation">
              {(() => {
                const hasBoardClips = clips.filter((c) => c.boardX !== undefined).length > 0;
                const hasNarration = clips.some((c) => c.type === "narration");
                const busy = !!aiPhase;
                const disabled = !hasBoardClips || busy;
                return (
                  <>
                    <button
                      onClick={() => {
                        if (disabled) return;
                        if (hasNarration) {
                          setAiError(null);
                          generateAnnotationsFromNarration();
                        } else {
                          setAiModalOpen(true);
                          setAiError(null);
                          setAiPhase(null);
                          setAiAudioFile(null);
                          setAiScriptText("");
                          setAiTab("audio");
                        }
                      }}
                      disabled={disabled}
                      title={
                        !hasBoardClips ? "Place images on the board first"
                        : hasNarration ? "Generate annotations from your timeline narration"
                        : "Generate annotations from narration audio or script"
                      }
                      style={{
                        ...sketchButton,
                        fontSize: 11,
                        padding: "6px 10px",
                        fontWeight: 700,
                        width: "100%",
                        opacity: disabled ? 0.45 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                      }}
                    >
                      {busy ? `⟳ ${aiPhase}` : hasNarration ? "✨ Generate Annotations (from narration)" : "✨ Generate Annotations"}
                    </button>
                    {!aiModalOpen && aiError && (
                      <div style={{ fontSize: 10, color: "#cc2200", marginTop: 4, fontFamily: "monospace", lineHeight: 1.4 }}>
                        ✗ {aiError}
                      </div>
                    )}
                  </>
                );
              })()}
            </ProGated>

            <input
              ref={mediaUploadRef}
              type="file"
              accept="image/*,video/*"
              multiple
              style={{ display: "none" }}
              onChange={handleMediaUpload}
            />
            <input
              ref={projectFileInputRef}
              type="file"
              accept=".nbp,.zip"
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) loadBoard(f); }}
            />
            <p style={{ fontSize: 10, color: "#9a9a9a", fontFamily: "monospace", lineHeight: 1.6, margin: "4px 0 0" }}>
              Upload images or videos — they auto-place on the board and timeline.
            </p>
          </div>

          {/* ── Center: board (primary) + preview overlay ── */}
          <div style={{ flex: 1, minWidth: 0, position: "relative", overflow: "hidden", background: "rgba(20,20,20,0.06)" }}>

            {/* Board container — fills the whole center */}
            <div
              ref={boardContainerRef}
              style={{ position: "absolute", inset: 0, overflow: "hidden", cursor: "default" }}
              onPointerDown={handleBoardPointerDown}
            >
              {/* Board surface */}
              <div
                style={{
                  position: "absolute",
                  left: boardPan.x,
                  top: boardPan.y,
                  width: BOARD_W * boardZoom,
                  height: BOARD_H * boardZoom,
                  background: "#f5ecd8",
                  border: "1.5px solid #2a2a2a",
                  boxShadow: "4px 4px 18px rgba(42,42,42,0.3)",
                }}
                onPointerDown={handleBoardSurfacePointerDown}
              >
                {boardMarquee && (() => {
                  const x = Math.min(boardMarquee.startX, boardMarquee.currentX) * boardZoom;
                  const y = Math.min(boardMarquee.startY, boardMarquee.currentY) * boardZoom;
                  const w = Math.abs(boardMarquee.currentX - boardMarquee.startX) * boardZoom;
                  const h = Math.abs(boardMarquee.currentY - boardMarquee.startY) * boardZoom;
                  return (
                    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, border: "1.5px dashed #ff5e3a", background: "rgba(255,94,58,0.1)", pointerEvents: "none", zIndex: 20 }} />
                  );
                })()}
                {/* eslint-disable-next-line react-hooks/refs */}
                {clips.filter((c) => c.boardX !== undefined).map((clip) => {
                  const isSel = clip.id === selectedClipId || selectedClipIds.includes(clip.id);
                  return (
                    <div
                      key={clip.id}
                      style={{
                        position: "absolute",
                        left: clip.boardX! * boardZoom,
                        top: clip.boardY! * boardZoom,
                        width: clip.boardW! * boardZoom,
                        height: clip.boardH! * boardZoom,
                        border: isSel ? "2px solid #ff5e3a" : "1.5px solid rgba(42,42,42,0.4)",
                        boxShadow: isSel
                          ? "0 0 0 1px #ff5e3a, 1px 1px 6px rgba(42,42,42,0.25)"
                          : "1px 1px 4px rgba(42,42,42,0.2)",
                        cursor: "grab",
                        overflow: "visible",
                      }}
                      onClick={(e) => { e.stopPropagation(); setClipSelection([clip.id]); }}
                      onPointerDown={(e) => { if (!isSpaceDown) handleBoardClipPointerDown(e, clip); }}
                    >
                      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
                        {clip.needsRedownload ? (
                          <div
                            style={{ width: "100%", height: "100%", background: "#1a1a2e", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", gap: 4 }}
                            onClick={(e) => { e.stopPropagation(); redownloadYtClip(clip.id); }}
                          >
                            <span style={{ color: "#ff9f5e", fontSize: 18, pointerEvents: "none" }}>▶</span>
                            <span style={{ color: "#ff9f5e", fontSize: 8, fontFamily: "monospace", textAlign: "center", pointerEvents: "none", padding: "0 4px" }}>click to re-download</span>
                          </div>
                        ) : clip.type === "image" ? (
                          <img
                            src={clip.sourceUrl}
                            alt={clip.name}
                            style={{ width: "100%", height: "100%", objectFit: "fill", display: "block", userSelect: "none", pointerEvents: "none" }}
                            draggable={false}
                          />
                        ) : (
                          <div style={{ width: "100%", height: "100%", background: "#1a1a2e", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <span style={{ color: "#7df5b0", fontSize: 11, fontFamily: "monospace", pointerEvents: "none" }}>▶ {clip.name}</span>
                          </div>
                        )}
                        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "1px 4px", background: "rgba(42,42,42,0.7)", color: "#fff", fontSize: 9, fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", pointerEvents: "none" }}>
                          {clip.name}
                        </div>
                      </div>
                      {isSel && (["nw", "ne", "sw", "se"] as const).map((corner) => (
                        <div
                          key={corner}
                          style={{
                            position: "absolute",
                            width: BOARD_RESIZE_PX,
                            height: BOARD_RESIZE_PX,
                            background: "#ff5e3a",
                            border: "1.5px solid #fff",
                            cursor: (corner === "nw" || corner === "se") ? "nwse-resize" : "nesw-resize",
                            zIndex: 10,
                            ...(corner === "nw" ? { left: -BOARD_RESIZE_PX / 2, top: -BOARD_RESIZE_PX / 2 } :
                                corner === "ne" ? { right: -BOARD_RESIZE_PX / 2, top: -BOARD_RESIZE_PX / 2 } :
                                corner === "sw" ? { left: -BOARD_RESIZE_PX / 2, bottom: -BOARD_RESIZE_PX / 2 } :
                                                 { right: -BOARD_RESIZE_PX / 2, bottom: -BOARD_RESIZE_PX / 2 }),
                          }}
                          onPointerDown={(e) => handleBoardResizePointerDown(e, clip, corner)}
                        />
                      ))}
                    </div>
                  );
                })}

                {/* Neural Search placeholders — not yet downloaded, click to trim & add */}
                {neuralPlaceholders.map((ph) => (
                  <div
                    key={ph.id}
                    style={{
                      position: "absolute",
                      left: ph.boardX * boardZoom,
                      top: ph.boardY * boardZoom,
                      width: ph.boardW * boardZoom,
                      height: ph.boardH * boardZoom,
                      border: "2px dashed #a855f7",
                      boxShadow: "1px 1px 4px rgba(42,42,42,0.2)",
                      cursor: "pointer",
                      overflow: "visible",
                    }}
                    onClick={(e) => { e.stopPropagation(); openTrimModalForPlaceholder(ph); }}
                    onMouseEnter={() => setHoveredPlaceholderId(ph.id)}
                    onMouseLeave={() => setHoveredPlaceholderId((prev) => (prev === ph.id ? null : prev))}
                  >
                    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#1a1a2e" }}>
                      {ph.thumbnailUrl && (
                        <img
                          src={ph.thumbnailUrl}
                          alt={ph.title}
                          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: 0.85, userSelect: "none", pointerEvents: "none" }}
                          draggable={false}
                        />
                      )}
                      <div style={{ position: "absolute", top: 3, left: 3, padding: "1px 5px", background: "#a855f7", color: "#fff", fontSize: 9, fontFamily: "monospace", fontWeight: 700, pointerEvents: "none" }}>
                        🔮 NOT ADDED
                      </div>
                    </div>
                    {hoveredPlaceholderId === ph.id && (
                      <div style={{
                        position: "absolute", bottom: 0, left: 0, right: 0, padding: "4px 6px",
                        background: "rgba(42,42,42,0.85)", color: "#fff", fontFamily: "monospace",
                        pointerEvents: "none",
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ph.title}</div>
                        {ph.viewCount > 0 && <div style={{ fontSize: 9, color: "#d4a8ff", marginTop: 1 }}>{formatViewCount(ph.viewCount)}</div>}
                      </div>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeNeuralPlaceholder(ph.id); }}
                      title="Remove"
                      style={{ position: "absolute", top: -8, right: -8, width: 18, height: 18, borderRadius: "50%", background: "#ff5e3a", border: "1.5px solid #fff", color: "#fff", fontSize: 10, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}
                    >
                      ✕
                    </button>
                  </div>
                ))}

                {/* Neural Search image placeholders — not yet downloaded, click to preview & add */}
                {imagePlaceholders.map((ph) => (
                  <div
                    key={ph.id}
                    style={{
                      position: "absolute",
                      left: ph.boardX * boardZoom,
                      top: ph.boardY * boardZoom,
                      width: ph.boardW * boardZoom,
                      height: ph.boardH * boardZoom,
                      border: "2px dashed #3b82f6",
                      boxShadow: "1px 1px 4px rgba(42,42,42,0.2)",
                      cursor: "pointer",
                      overflow: "visible",
                    }}
                    onClick={(e) => { e.stopPropagation(); setImagePreviewTarget(ph); }}
                    onMouseEnter={() => setHoveredPlaceholderId(ph.id)}
                    onMouseLeave={() => setHoveredPlaceholderId((prev) => (prev === ph.id ? null : prev))}
                  >
                    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#3a3a3a" }}>
                      <img
                        src={ph.imageUrl}
                        alt={ph.title}
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: 0.9, userSelect: "none", pointerEvents: "none" }}
                        draggable={false}
                        onError={() => removeImagePlaceholder(ph.id)}
                      />
                      <div style={{ position: "absolute", top: 3, left: 3, padding: "1px 5px", background: "#3b82f6", color: "#fff", fontSize: 9, fontFamily: "monospace", fontWeight: 700, pointerEvents: "none" }}>
                        🖼 NOT ADDED
                      </div>
                    </div>
                    {hoveredPlaceholderId === ph.id && (
                      <div style={{
                        position: "absolute", bottom: 0, left: 0, right: 0, padding: "4px 6px",
                        background: "rgba(42,42,42,0.85)", color: "#fff", fontFamily: "monospace",
                        pointerEvents: "none",
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ph.title}</div>
                      </div>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeImagePlaceholder(ph.id); }}
                      title="Remove"
                      style={{ position: "absolute", top: -8, right: -8, width: 18, height: 18, borderRadius: "50%", background: "#ff5e3a", border: "1.5px solid #fff", color: "#fff", fontSize: 10, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}
                    >
                      ✕
                    </button>
                  </div>
                ))}

                {/* SVG visual layer for non-text annotations */}
                <svg
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 4, overflow: "visible" }}
                >
                  {annotations.filter((a) => a.type !== "text").map((ann) => {
                    if (ann.type === "arrow" && ann.arrowStartX !== undefined) {
                      const x1 = ann.arrowStartX * boardZoom, y1 = ann.arrowStartY! * boardZoom;
                      const x2 = ann.arrowEndX! * boardZoom, y2 = ann.arrowEndY! * boardZoom;
                      const angle = Math.atan2(y2 - y1, x2 - x1);
                      const hl = 15;
                      const sw = ann.strokeWidth ?? 3;
                      return (
                        <g key={ann.id}>
                          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={ann.color} strokeWidth={sw} strokeLinecap="round" />
                          <line x1={x2} y1={y2} x2={x2 - hl * Math.cos(angle - Math.PI / 6)} y2={y2 - hl * Math.sin(angle - Math.PI / 6)} stroke={ann.color} strokeWidth={sw} strokeLinecap="round" />
                          <line x1={x2} y1={y2} x2={x2 - hl * Math.cos(angle + Math.PI / 6)} y2={y2 - hl * Math.sin(angle + Math.PI / 6)} stroke={ann.color} strokeWidth={sw} strokeLinecap="round" />
                        </g>
                      );
                    } else if (ann.type === "circle") {
                      return (
                        <ellipse key={ann.id}
                          cx={ann.boardX * boardZoom + ann.boardW * boardZoom / 2}
                          cy={ann.boardY * boardZoom + ann.boardH * boardZoom / 2}
                          rx={ann.boardW * boardZoom / 2} ry={ann.boardH * boardZoom / 2}
                          fill="none" stroke={ann.color} strokeWidth={ann.strokeWidth ?? 3}
                        />
                      );
                    } else if (ann.type === "highlight") {
                      const style = ann.highlightStyle ?? "rect";
                      const bx = ann.boardX * boardZoom, by = ann.boardY * boardZoom;
                      const bw = ann.boardW * boardZoom, bh = ann.boardH * boardZoom;
                      if (style === "rect") return <rect key={ann.id} x={bx} y={by} width={bw} height={bh} fill={ann.color} fillOpacity={0.3} />;
                      if (style === "underline") return <line key={ann.id} x1={bx} y1={by + bh} x2={bx + bw} y2={by + bh} stroke={ann.color} strokeWidth={ann.strokeWidth ?? 3} strokeLinecap="round" />;
                      // curlyBrace
                      const cx = bx + bw, mid = by + bh / 2, q = Math.min(20, bh * 0.15);
                      return <path key={ann.id} d={`M ${cx} ${by} C ${cx+q} ${by}, ${cx+q} ${mid - bh*0.05}, ${cx} ${mid} C ${cx+q} ${mid + bh*0.05}, ${cx+q} ${by+bh}, ${cx} ${by+bh}`} fill="none" stroke={ann.color} strokeWidth={ann.strokeWidth ?? 3} strokeLinecap="round" />;
                    } else if (ann.type === "pen" && ann.points && ann.points.length >= 2) {
                      const d = ann.points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x * boardZoom} ${p.y * boardZoom}`).join(" ");
                      return <path key={ann.id} d={d} fill="none" stroke={ann.color} strokeWidth={(ann.strokeWidth ?? 4) * boardZoom} strokeLinecap="round" strokeLinejoin="round" />;
                    } else if (ann.type === "emoji" && ann.emoji) {
                      return (
                        <text key={ann.id}
                          x={(ann.boardX + ann.boardW / 2) * boardZoom}
                          y={(ann.boardY + ann.boardH / 2) * boardZoom}
                          fontSize={(ann.fontSize ?? 120) * boardZoom}
                          textAnchor="middle" dominantBaseline="central"
                          style={{ userSelect: "none" }}
                        >{ann.emoji}</text>
                      );
                    }
                    return null;
                  })}
                  {/* Live pen preview during drawing */}
                  {penPreviewPoints && penPreviewPoints.length >= 2 && (
                    <path
                      d={penPreviewPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x * boardZoom} ${p.y * boardZoom}`).join(" ")}
                      fill="none" stroke={annotationColor} strokeWidth={4 * boardZoom}
                      strokeLinecap="round" strokeLinejoin="round" opacity={0.7}
                    />
                  )}
                </svg>

                {/* Annotation DOM overlays (hit targets + text rendering + resize handles) */}
                {/* eslint-disable-next-line react-hooks/refs */}
                {annotations.map((ann) => {
                  const isSel = ann.id === selectedAnnotationId || selectedAnnotationIds.includes(ann.id);
                  const isEditing = ann.id === editingAnnotationId;
                  const showHandles = isSel && annotationTool === "pointer" && !isEditing;
                  return (
                    <div
                      key={ann.id}
                      style={{
                        position: "absolute",
                        left: ann.boardX * boardZoom,
                        top: ann.boardY * boardZoom,
                        width: ann.type === "text" ? "auto" : ann.boardW * boardZoom,
                        height: ann.type === "text" ? "auto" : ann.boardH * boardZoom,
                        minWidth: ann.type === "text" ? ann.boardW * boardZoom : undefined,
                        outline: isSel && !isEditing ? "2px dashed #ff5e3a" : "none",
                        outlineOffset: 3,
                        cursor: annotationTool === "pointer" ? "pointer" : "default",
                        zIndex: 5,
                        pointerEvents: annotationTool === "pointer" || isEditing ? "auto" : "none",
                      }}
                      onClick={(e) => { if (annotationTool === "pointer") { e.stopPropagation(); setAnnotationSelection([ann.id]); } }}
                      onDoubleClick={(e) => {
                        if (ann.type === "text" && annotationTool === "pointer") {
                          e.stopPropagation();
                          setEditingAnnotationId(ann.id);
                          setEditingAnnotationText(ann.text ?? "");
                        }
                      }}
                      onPointerDown={(e) => { if (annotationTool === "pointer") handleAnnotationPointerDown(e, ann); }}
                    >
                      {ann.type === "text" && !isEditing && (
                        <div style={{
                          fontFamily: `'${ann.fontFamily ?? "Caveat"}', cursive`,
                          fontSize: (ann.fontSize ?? 80) * boardZoom,
                          fontWeight: ann.fontWeight ?? "normal",
                          color: ann.color,
                          userSelect: "none",
                          pointerEvents: "none",
                          whiteSpace: "pre",
                          lineHeight: 1.2,
                        }}>
                          {ann.text || <span style={{ opacity: 0.25, fontFamily: "monospace", fontSize: 11 }}>click to type…</span>}
                        </div>
                      )}
                      {ann.type === "text" && isEditing && (
                        <textarea
                          ref={(el) => { if (isEditing) editingTextareaRef.current = el; }}
                          value={editingAnnotationText}
                          onChange={(e) => setEditingAnnotationText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitTextEdit(ann.id); }
                            else if (e.key === "Escape") { if (!ann.text) deleteAnnotation(ann.id); else setEditingAnnotationId(null); }
                          }}
                          onBlur={() => commitTextEdit(ann.id)}
                          style={{
                            fontFamily: `'${ann.fontFamily ?? "Caveat"}', cursive`,
                            fontSize: (ann.fontSize ?? 80) * boardZoom,
                            fontWeight: ann.fontWeight ?? "normal",
                            color: ann.color,
                            background: "rgba(255,255,255,0.15)",
                            border: "1px dashed rgba(255,94,58,0.6)",
                            outline: "none",
                            resize: "none",
                            minWidth: ann.boardW * boardZoom,
                            minHeight: (ann.fontSize ?? 80) * boardZoom * 1.4,
                            padding: 0,
                            lineHeight: 1.2,
                            whiteSpace: "pre",
                          }}
                        />
                      )}
                      {/* Resize handles */}
                      {showHandles && (
                        ann.type === "arrow" && ann.arrowStartX !== undefined ? (
                          // Arrow: two endpoint handles
                          (["start", "end"] as const).map((which) => {
                            const hx = ((which === "start" ? ann.arrowStartX! : ann.arrowEndX!) - ann.boardX) * boardZoom;
                            const hy = ((which === "start" ? ann.arrowStartY! : ann.arrowEndY!) - ann.boardY) * boardZoom;
                            return (
                              <div key={which} style={{
                                position: "absolute", left: hx - 6, top: hy - 6,
                                width: 12, height: 12, background: "#ff5e3a",
                                border: "2px solid #fff", borderRadius: "50%",
                                cursor: "move", zIndex: 20,
                              }}
                              onPointerDown={(e) => handleArrowEndpointDrag(e, ann, which)} />
                            );
                          })
                        ) : (
                          // All other types: four corner handles
                          (["nw", "ne", "sw", "se"] as const).map((corner) => (
                            <div key={corner} style={{
                              position: "absolute",
                              ...(corner === "nw" ? { left: -5, top: -5 } :
                                  corner === "ne" ? { right: -5, top: -5 } :
                                  corner === "sw" ? { left: -5, bottom: -5 } :
                                                    { right: -5, bottom: -5 }),
                              width: 10, height: 10, background: "#ff5e3a",
                              border: "1.5px solid #fff",
                              cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                              zIndex: 20,
                            }}
                            onPointerDown={(e) => { e.stopPropagation(); handleAnnotationCornerResize(e, ann, corner); }} />
                          ))
                        )
                      )}
                    </div>
                  );
                })}

                {/* Glass pane — captures all pointer events for annotation drawing */}
                {annotationTool !== "pointer" && !isSpaceDown && !editingAnnotationId && (
                  <div
                    style={{ position: "absolute", inset: 0, zIndex: 10, cursor: annotationTool === "text" ? "text" : annotationTool === "emoji" ? "copy" : "crosshair" }}
                    onPointerDown={handleAnnotationGlassPointerDown}
                  />
                )}
              </div>

              {/* Empty state */}
              {clips.filter((c) => c.boardX !== undefined).length === 0 && neuralPlaceholders.length === 0 && imagePlaceholders.length === 0 && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 11, color: "rgba(42,42,42,0.4)" }}>
                    Upload images or videos to auto-add to the board
                  </span>
                </div>
              )}

              {/* Board info */}
              <div style={{ position: "absolute", bottom: 8, left: 8, fontFamily: "monospace", fontSize: 9, color: "rgba(42,42,42,0.4)", pointerEvents: "none" }}>
                {BOARD_W}×{BOARD_H} · {Math.round(boardZoom * 100)}% · space+drag=pan · scroll=zoom
              </div>

              {/* Annotation toolbar — collapsible, Pro gated */}
              <div style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 30, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <ProGated featureName="Annotation tools">
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); setAnnotationToolbarOpen((v) => !v); }}
                      style={{
                        fontFamily: "monospace", fontSize: 10, fontWeight: 700,
                        padding: "5px 12px", border: "1.5px solid #2a2a2a",
                        background: annotationToolbarOpen ? "#2a2a2a" : "#fffdf5",
                        color: annotationToolbarOpen ? "#c8f135" : "#2a2a2a",
                        cursor: "pointer", boxShadow: "2px 2px 4px rgba(0,0,0,0.18)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      🎨 Annotations {annotationToolbarOpen ? "▲" : "▼"}
                    </button>
                    {annotationToolbarOpen && (
                      <div style={{
                        display: "flex", alignItems: "center", gap: 2,
                        background: "#fffdf5",
                        border: "1.5px solid #2a2a2a",
                        boxShadow: "2px 2px 8px rgba(0,0,0,0.18)",
                        padding: "4px 8px",
                        whiteSpace: "nowrap",
                        position: "relative",
                      }}>
                        {/* Tool buttons */}
                        {([
                          { id: "pointer"   as AnnotationTool, icon: "↖", title: "Select / move" },
                          { id: "text"      as AnnotationTool, icon: "T",  title: "Text" },
                          { id: "arrow"     as AnnotationTool, icon: "↗",  title: "Arrow" },
                          { id: "circle"    as AnnotationTool, icon: "○",  title: "Circle / ellipse" },
                          { id: "highlight" as AnnotationTool, icon: "▭",  title: "Highlight" },
                          { id: "pen"       as AnnotationTool, icon: "✏",  title: "Freehand pen" },
                          { id: "emoji"     as AnnotationTool, icon: "😀", title: "Emoji" },
                        ]).map(({ id, icon, title }) => (
                          <button
                            key={id}
                            title={title}
                            onClick={(e) => {
                              e.stopPropagation();
                              setAnnotationTool(id);
                              if (id === "emoji") setEmojiPickerOpen((v) => !v);
                              else setEmojiPickerOpen(false);
                            }}
                            style={{
                              width: 28, height: 28, border: "none", padding: 0,
                              outline: annotationTool === id ? "2px solid #2a2a2a" : "1.5px solid rgba(42,42,42,0.25)",
                              background: annotationTool === id ? "#2a2a2a" : "transparent",
                              color: annotationTool === id ? "#fff" : "#2a2a2a",
                              cursor: "pointer", fontFamily: "monospace",
                              fontSize: id === "text" ? 13 : 15, fontWeight: 700,
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}
                          >
                            {icon}
                          </button>
                        ))}

                        <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)", margin: "0 4px" }} />

                        {/* Color swatches */}
                        {(["#cc2200", "#1a6fd4", "#e8a800", "#228b22", "#e06020", "#1a1a1a"]).map((c) => (
                          <button
                            key={c}
                            title={c}
                            onClick={(e) => { e.stopPropagation(); setAnnotationColor(c); }}
                            style={{
                              width: 18, height: 18, padding: 0,
                              background: c,
                              border: annotationColor === c ? "2.5px solid #2a2a2a" : "1.5px solid rgba(0,0,0,0.2)",
                              cursor: "pointer", flexShrink: 0,
                            }}
                          />
                        ))}

                        {/* Font picker — text tool only */}
                        {annotationTool === "text" && (
                          <>
                            <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)", margin: "0 4px" }} />
                            <select
                              value={annotationFont}
                              onChange={(e) => { e.stopPropagation(); setAnnotationFont(e.target.value); }}
                              style={{ fontFamily: "monospace", fontSize: 9, border: "1px solid rgba(42,42,42,0.3)", background: "#fff", padding: "2px 4px", cursor: "pointer" }}
                            >
                              <option value="Caveat">Caveat</option>
                              <option value="Permanent Marker">Permanent Marker</option>
                              <option value="Architects Daughter">Architects Daughter</option>
                              <option value="Patrick Hand">Patrick Hand</option>
                            </select>
                          </>
                        )}

                        {/* Highlight sub-type — highlight tool only */}
                        {annotationTool === "highlight" && (
                          <>
                            <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)", margin: "0 4px" }} />
                            {(["rect", "underline", "curlyBrace"] as const).map((s) => (
                              <button
                                key={s}
                                onClick={(e) => { e.stopPropagation(); setAnnotationHighlightStyle(s); }}
                                style={{
                                  padding: "2px 5px", fontSize: 9, fontFamily: "monospace",
                                  border: annotationHighlightStyle === s ? "2px solid #2a2a2a" : "1px solid rgba(42,42,42,0.3)",
                                  background: annotationHighlightStyle === s ? "#2a2a2a" : "transparent",
                                  color: annotationHighlightStyle === s ? "#fff" : "#2a2a2a",
                                  cursor: "pointer",
                                }}
                              >
                                {s === "rect" ? "▭" : s === "underline" ? "_" : "{}"}
                              </button>
                            ))}
                          </>
                        )}

                        {/* Emoji picker popover */}
                        {annotationTool === "emoji" && emojiPickerOpen && (
                          <div style={{
                            position: "absolute", top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
                            background: "#fffdf5", border: "1.5px solid #2a2a2a",
                            boxShadow: "3px 3px 0 #2a2a2a", padding: 8, zIndex: 50,
                            display: "grid", gridTemplateColumns: "repeat(9, 28px)", gap: 2,
                          }}>
                            {EMOJI_SET.map((em) => (
                              <button
                                key={em}
                                title={em}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAnnotationEmoji(em);
                                  setEmojiPickerOpen(false);
                                }}
                                style={{
                                  width: 28, height: 28, fontSize: 16, border: "none", padding: 0,
                                  background: annotationEmoji === em ? "#c8f135" : "transparent",
                                  cursor: "pointer", borderRadius: 2,
                                }}
                              >{em}</button>
                            ))}
                          </div>
                        )}

                        {/* Selected emoji indicator */}
                        {annotationTool === "emoji" && (
                          <span style={{ fontSize: 18, marginLeft: 4, userSelect: "none" }} title="Active emoji">
                            {annotationEmoji}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                </ProGated>
              </div>

              {/* Character toolbar — collapsible, Pro gated */}
              <div style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 29, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, marginTop: annotationToolbarOpen ? 48 : 0 }}>
                <ProGated featureName="Character">
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); setCharacterToolbarOpen((v) => !v); }}
                      style={{
                        fontFamily: "monospace", fontSize: 10, fontWeight: 700,
                        padding: "5px 12px", border: "1.5px solid #2a2a2a",
                        background: characterToolbarOpen ? "#2a2a2a" : "#fffdf5",
                        color: characterToolbarOpen ? CHARACTER_COLOR : "#2a2a2a",
                        cursor: "pointer", boxShadow: "2px 2px 4px rgba(0,0,0,0.18)",
                        whiteSpace: "nowrap",
                        marginTop: annotationToolbarOpen ? 0 : 36,
                      }}
                    >
                      🧍 Character {characterToolbarOpen ? "▲" : "▼"}
                    </button>
                    {characterToolbarOpen && (
                      <div style={{
                        display: "flex", alignItems: "center", gap: 4,
                        background: "#fffdf5", border: "1.5px solid #2a2a2a",
                        boxShadow: "2px 2px 8px rgba(0,0,0,0.18)",
                        padding: "5px 10px", whiteSpace: "nowrap", position: "relative",
                      }}>
                        {/* Show/hide toggle */}
                        <button
                          onClick={(e) => { e.stopPropagation(); setShowCharacter((v) => !v); }}
                          style={{
                            padding: "3px 8px", fontFamily: "monospace", fontSize: 9, cursor: "pointer",
                            border: "1px solid rgba(42,42,42,0.35)",
                            background: showCharacter ? CHARACTER_COLOR : "transparent",
                            color: "#2a2a2a",
                          }}
                        >
                          {showCharacter ? "● On" : "○ Off"}
                        </button>

                        {showCharacter && (
                          <>
                            <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)" }} />
                            {/* Auto / Manual mode toggle */}
                            <div style={{ display: "flex", border: "1px solid rgba(42,42,42,0.35)", overflow: "hidden" }}>
                              {(["auto", "manual"] as const).map((m) => (
                                <button
                                  key={m}
                                  title={m === "auto" ? "Follow camera keyframes automatically" : "Manually place actions only"}
                                  onClick={(e) => { e.stopPropagation(); setCharacterMode(m); }}
                                  style={{
                                    padding: "3px 7px", fontFamily: "monospace", fontSize: 9, cursor: "pointer",
                                    border: "none", borderRight: m === "auto" ? "1px solid rgba(42,42,42,0.35)" : "none",
                                    background: characterMode === m ? "#2a2a2a" : "transparent",
                                    color: characterMode === m ? CHARACTER_COLOR : "#2a2a2a",
                                    fontWeight: characterMode === m ? 700 : 400,
                                  }}
                                >
                                  {m === "auto" ? "Auto" : "Manual"}
                                </button>
                              ))}
                            </div>
                            <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)" }} />
                            {/* Action buttons — click to enter crosshair placement mode */}
                            {([
                              { mode: "walkTo" as const, label: "Walk", title: "Click board to walk to position (1.5s)" },
                              { mode: "jumpTo" as const, label: "Jump", title: "Click board to jump to position (1.0s)" },
                              { mode: "grapple" as const, label: "Grapple", title: "Click board to grapple-hook to position (1.5s)" },
                              { mode: "pointAt" as const, label: "Point", title: "Click board to point at position (2.0s)" },
                              { mode: "emote" as const, label: "Emote", title: "Choose emoji then place at playhead (2.0s)" },
                            ]).map(({ mode, label, title }) => (
                              <button
                                key={mode}
                                title={title}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (mode === "emote") {
                                    setCharacterEmojiPickerOpen((v) => !v);
                                    setCharacterAddMode(mode);
                                  } else {
                                    setCharacterEmojiPickerOpen(false);
                                    setCharacterAddMode((prev) => (prev === mode ? null : mode));
                                  }
                                }}
                                style={{
                                  padding: "3px 7px", fontFamily: "monospace", fontSize: 9,
                                  border: characterAddMode === mode ? "2px solid #2a2a2a" : "1px solid rgba(42,42,42,0.35)",
                                  background: characterAddMode === mode ? "#2a2a2a" : "transparent",
                                  color: characterAddMode === mode ? CHARACTER_COLOR : "#2a2a2a",
                                  cursor: characterAddMode === mode ? "crosshair" : "pointer",
                                }}
                              >
                                {label}
                              </button>
                            ))}

                            {characterAddMode && characterAddMode !== "emote" && (
                              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#666", marginLeft: 2 }}>
                                ← click board
                              </span>
                            )}

                            {/* Emote emoji picker */}
                            {characterEmojiPickerOpen && (
                              <div style={{
                                position: "absolute", top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
                                background: "#fffdf5", border: "1.5px solid #2a2a2a",
                                boxShadow: "3px 3px 0 #2a2a2a", padding: 8, zIndex: 55,
                                display: "grid", gridTemplateColumns: "repeat(9, 28px)", gap: 2,
                              }}>
                                {EMOJI_SET.map((em) => (
                                  <button
                                    key={em}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setCharacterEmoji(em);
                                      setCharacterEmojiPickerOpen(false);
                                      // Place emote action at playhead
                                      const newAction: CharacterAction = {
                                        id: generateId(), type: "emote",
                                        startTime: playheadRef.current, duration: 2.0,
                                        emoji: em,
                                      };
                                      setCharacterActions((prev) => [...prev, newAction]);
                                      setCharacterAddMode(null);
                                    }}
                                    style={{
                                      width: 28, height: 28, fontSize: 16, border: "none", padding: 0,
                                      background: characterEmoji === em ? CHARACTER_COLOR : "transparent",
                                      cursor: "pointer", borderRadius: 2,
                                    }}
                                  >{em}</button>
                                ))}
                              </div>
                            )}

                            {characterAddMode === "emote" && !characterEmojiPickerOpen && (
                              <span style={{ fontSize: 16, marginLeft: 2 }}>{characterEmoji}</span>
                            )}

                            <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)" }} />
                            {/* AI choreography — describe moves in plain language, optionally synced to narration */}
                            <button
                              title="Describe what the character should do, or sync emotes to your narration"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDirectCharacterOpen((v) => {
                                  const next = !v;
                                  if (next) setSyncEmotesToNarration(clipsRef.current.some((c) => c.type === "narration"));
                                  return next;
                                });
                              }}
                              style={{
                                padding: "3px 7px", fontFamily: "monospace", fontSize: 9,
                                border: "1px solid rgba(42,42,42,0.35)",
                                background: directCharacterOpen ? "#2a2a2a" : "transparent",
                                color: directCharacterOpen ? CHARACTER_COLOR : "#2a2a2a",
                                cursor: "pointer",
                              }}
                            >
                              ✨ Direct
                            </button>
                            {characterActions.some((a) => a.aiGenerated) && (
                              <button
                                title="Remove all AI-choreographed actions (hand-placed ones are kept)"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCharacterActions((prev) => prev.filter((a) => !a.aiGenerated));
                                }}
                                style={{
                                  padding: "3px 7px", fontFamily: "monospace", fontSize: 9,
                                  border: "1px solid rgba(42,42,42,0.35)", background: "transparent",
                                  color: "#2a2a2a", cursor: "pointer",
                                }}
                              >
                                🧹 Clear AI
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </>
                </ProGated>
              </div>

              {/* Character placement overlay — captures board click when characterAddMode is set */}
              {showCharacter && characterAddMode && characterAddMode !== "emote" && (
                <div
                  style={{ position: "absolute", inset: 0, cursor: "crosshair", zIndex: 28 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = boardContainerRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    const rawBx = (e.clientX - rect.left - boardPanRef.current.x) / boardZoomRef.current;
                    const rawBy = (e.clientY - rect.top - boardPanRef.current.y) / boardZoomRef.current;
                    // Snap target to top of clip surface if clicked on an image/video
                    const snapped = snapToClipTop(rawBx, rawBy, clipsRef.current);
                    const durationMap: Record<string, number> = { walkTo: 1.5, jumpTo: 1.0, grapple: 1.5, pointAt: 2.0 };
                    const newAction: CharacterAction = {
                      id: generateId(),
                      type: characterAddMode,
                      startTime: playheadRef.current,
                      duration: durationMap[characterAddMode] ?? 1.5,
                      targetX: Math.round(snapped.x),
                      targetY: Math.round(snapped.y),
                    };
                    setCharacterActions((prev) => [...prev, newAction]);
                    setCharacterAddMode(null);
                  }}
                />
              )}
            </div>

            {/* Preview overlay — small PiP, top-right */}
            <div style={{ position: "absolute", top: 8, right: 8, zIndex: 20, pointerEvents: "none" }}>
              <div style={{ fontSize: 8, fontFamily: "monospace", color: "rgba(42,42,42,0.5)", marginBottom: 2, textAlign: "right", letterSpacing: 0.5 }}>
                PREVIEW
              </div>
              <canvas
                ref={canvasRef}
                width={canvasW}
                height={canvasH}
                style={{
                  display: "block",
                  width: previewW,
                  height: PREVIEW_H_PX,
                  border: "1.5px solid #2a2a2a",
                  boxShadow: "2px 2px 6px rgba(0,0,0,0.35)",
                  background: "#111",
                }}
              />
            </div>
          </div>

          {/* ── Right: properties panel (no keyframes) ── */}
          <div style={{ width: 240, flexShrink: 0, borderLeft: "1.5px solid rgba(42,42,42,0.15)", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", background: "rgba(255,253,245,0.65)" }}>
            <div style={panelLabelStyle}>Properties</div>

            {(() => {
              const selectedAnnotation = annotations.find((a) => a.id === selectedAnnotationId) ?? null;
              if (selectedAnnotation) return (
                <>
                  <div style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700 }}>
                    {selectedAnnotation.type === "text" ? "T Text" : selectedAnnotation.type === "arrow" ? "↗ Arrow" : selectedAnnotation.type === "circle" ? "○ Circle" : selectedAnnotation.type === "highlight" ? "▭ Highlight" : selectedAnnotation.type === "pen" ? "✏ Pen" : `${selectedAnnotation.emoji ?? "😀"} Emoji`}
                  </div>
                  {(selectedAnnotation.type === "text" || selectedAnnotation.type === "emoji") && (
                    <div>
                      <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Font size (board px)</div>
                      <input
                        type="range"
                        min={20} max={300} step={1}
                        value={selectedAnnotation.fontSize ?? (selectedAnnotation.type === "emoji" ? 120 : 80)}
                        onChange={(e) => {
                          const v = parseInt(e.target.value);
                          setAnnotations((prev) => prev.map((a) => a.id === selectedAnnotation.id ? { ...a, fontSize: v } : a));
                        }}
                        style={{ width: "100%", accentColor: "#c8f135" }}
                      />
                      <div style={{ fontFamily: "monospace", fontSize: 9, color: "#6a6a6a", marginTop: 2 }}>
                        {selectedAnnotation.fontSize ?? (selectedAnnotation.type === "emoji" ? 120 : 80)}px
                      </div>
                    </div>
                  )}
                  <div>
                    <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Color</div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {["#cc2200", "#1a6fd4", "#e8a800", "#228b22", "#e06020", "#1a1a1a"].map((c) => (
                        <button key={c} onClick={() => setAnnotations((prev) => prev.map((a) => a.id === selectedAnnotation.id ? { ...a, color: c } : a))}
                          style={{ width: 20, height: 20, background: c, border: selectedAnnotation.color === c ? "2.5px solid #2a2a2a" : "1.5px solid rgba(0,0,0,0.2)", cursor: "pointer", padding: 0 }}
                        />
                      ))}
                    </div>
                  </div>
                  <div style={{ marginTop: "auto" }}>
                    <button onClick={() => deleteAnnotation(selectedAnnotation.id)} style={{ ...miniButton, color: "#ff5e3a", borderColor: "#ff5e3a" }}>
                      ✕ Delete annotation
                    </button>
                  </div>
                </>
              );
              return null;
            })()}

            {!selectedClip ? (
              !selectedAnnotationId ? (
                <p style={{ fontSize: 10, color: "#9a9a9a", fontFamily: "monospace", lineHeight: 1.6, margin: 0 }}>
                  Select a clip or annotation to view its properties.
                </p>
              ) : null
            ) : (
              <>
                <div style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selectedClip.type === "pan" ? "⟷ Pan clip" : selectedClip.type === "narration" ? "🎙 Narration" : selectedClip.name}
                </div>
                {selectedClip.type === "pan" && (
                  <div style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", background: PAN_CLIP_COLOR, padding: "3px 6px", border: "1px solid rgba(42,42,42,0.2)" }}>
                    Sweeps across all board images
                  </div>
                )}
                {selectedClip.type === "narration" && (
                  <div style={{ fontSize: 9, fontFamily: "monospace", color: "#5a1530", background: NARRATION_COLOR, padding: "3px 6px", border: "1px solid rgba(180,80,130,0.35)" }}>
                    Audio-only clip — plays during export
                  </div>
                )}

                <div style={{ fontSize: 10, fontFamily: "monospace", color: "#6a6a6a" }}>
                  Start: {selectedClip.startTime.toFixed(2)}s
                </div>

                <div>
                  <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Duration (s)</div>
                  <input
                    type="number"
                    value={selectedClip.duration.toFixed(2)}
                    step={0.1}
                    min={0.1}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v >= 0.1) {
                        setClips((prev) =>
                          prev.map((c) => c.id === selectedClipId ? { ...c, duration: v } : c)
                        );
                      }
                    }}
                    style={{ width: "100%", fontFamily: "monospace", fontSize: 11, padding: "4px 6px", border: "1px solid rgba(42,42,42,0.4)", background: "#fff", boxSizing: "border-box" }}
                  />
                </div>

                {selectedClip.type !== "narration" && (
                  <div>
                    <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Hold / Transition</div>
                    <input
                      type="range"
                      min={0.1}
                      max={0.95}
                      step={0.01}
                      value={selectedClip.holdFraction ?? HOLD_FRACTION}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (cameraKeyframesRef.current.length > 0) setKeyframesOutOfDate(true);
                        setClips((prev) =>
                          prev.map((c) => c.id === selectedClipId ? { ...c, holdFraction: v } : c)
                        );
                      }}
                      style={{ width: "100%", accentColor: "#c8f135" }}
                    />
                    <div style={{ fontFamily: "monospace", fontSize: 9, color: "#6a6a6a", marginTop: 2 }}>
                      Hold: {Math.round((selectedClip.holdFraction ?? HOLD_FRACTION) * 100)}% · Trans: {Math.round((1 - (selectedClip.holdFraction ?? HOLD_FRACTION)) * 100)}%
                    </div>
                  </div>
                )}

                {selectedClip.boardX !== undefined && (
                  <div>
                    <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Board Position</div>
                    <div style={{ fontFamily: "monospace", fontSize: 10, color: "#6a6a6a", lineHeight: 1.8 }}>
                      <div>X: {Math.round(selectedClip.boardX)} &nbsp; Y: {Math.round(selectedClip.boardY!)}</div>
                      <div>W: {Math.round(selectedClip.boardW!)} &nbsp; H: {Math.round(selectedClip.boardH!)}</div>
                    </div>
                  </div>
                )}

                {(selectedClip.type === "video" || selectedClip.type === "narration") && (
                  <div>
                    <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Volume</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="range"
                        min={0} max={1} step={0.01}
                        value={selectedClip.muted ? 0 : (selectedClip.volume ?? 1)}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setClips((prev) => prev.map((c) => c.id === selectedClipId ? { ...c, volume: v, muted: false } : c));
                        }}
                        style={{ flex: 1, accentColor: "#c8f135" }}
                      />
                      <button
                        onClick={() => setClips((prev) => prev.map((c) => c.id === selectedClipId ? { ...c, muted: !c.muted } : c))}
                        style={{ ...miniButton, background: selectedClip.muted ? "#ff5e3a" : "transparent", color: selectedClip.muted ? "#fff" : "#2a2a2a", padding: "2px 6px" }}
                      >
                        {selectedClip.muted ? "🔇" : "🔊"}
                      </button>
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 9, color: "#6a6a6a", marginTop: 2 }}>
                      {selectedClip.muted ? "Muted" : `${Math.round((selectedClip.volume ?? 1) * 100)}%`}
                    </div>
                  </div>
                )}

                <div style={{ marginTop: "auto" }}>
                  <button
                    onClick={() => deleteClip(selectedClip.id)}
                    style={{ ...miniButton, color: "#ff5e3a", borderColor: "#ff5e3a" }}
                  >
                    ✕ Delete clip
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Bottom: timeline ── */}
        <div style={{ height: TIMELINE_H, flexShrink: 0, background: "rgba(255,253,245,0.85)", display: "flex", flexDirection: "column" }}>

          {/* Timeline controls bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid rgba(42,42,42,0.12)", background: "rgba(245,236,216,0.85)", flexShrink: 0, flexWrap: "nowrap" }}>
            <button
              onClick={togglePlay}
              style={{ ...sketchButton, width: 34, height: 34, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, background: isPlaying ? "#ff5e3a" : "#c8f135", color: isPlaying ? "#fff" : "#2a2a2a" }}
            >
              {isPlaying ? "■" : "▶"}
            </button>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "#2a2a2a", border: "1.5px solid #2a2a2a", padding: "3px 8px", background: "#fffdf5", boxShadow: "2px 2px 0 #2a2a2a", minWidth: 72, textAlign: "center" }}>
              {formatTime(playhead)}
            </span>
            <button onClick={() => { setPlayhead(0); setIsPlaying(false); }} style={miniButton}>↩ reset</button>
            <button onClick={fitTimeline} style={{ ...sketchButton, height: 30, padding: "0 10px", fontSize: 11 }}>Fit</button>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#9a9a9a" }}>zoom</span>
              <button onClick={() => { const n = clamp(pxPerSec / 1.5, MIN_PX_PER_SEC, MAX_PX_PER_SEC); pxPerSecRef.current = n; setPxPerSec(n); }} style={miniButton}>−</button>
              <button onClick={() => { const n = clamp(pxPerSec * 1.5, MIN_PX_PER_SEC, MAX_PX_PER_SEC); pxPerSecRef.current = n; setPxPerSec(n); }} style={miniButton}>+</button>
            </div>
            <span style={{ fontSize: 9, fontFamily: "monospace", color: "#bbb" }}>space=play · ⌘C/V/D=copy/paste/dup · ⌫=delete · drag vertically=change layer</span>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
              {isExporting && (
                <span style={{ fontSize: 10, fontFamily: "monospace", color: "#ff5e3a" }}>{Math.round(exportProgress * 100)}%</span>
              )}
              <button
                onClick={isExporting ? cancelExport : startExport}
                style={{ ...sketchButton, padding: "4px 10px", fontSize: 11, background: isExporting ? "#ff5e3a" : "#c8f135", color: isExporting ? "#fff" : "#2a2a2a" }}
              >
                {isExporting ? "✕ Cancel" : "⬇ Export"}
              </button>
              <div style={{ display: "flex", gap: 3 }}>
                {(["16:9", "9:16"] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => setCanvasAspect(a)}
                    style={{ ...miniButton, background: canvasAspect === a ? "#2a2a2a" : "transparent", color: canvasAspect === a ? "#fff" : "#2a2a2a" }}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Ruler */}
          <div
            style={{ height: RULER_H, flexShrink: 0, position: "relative", overflow: "hidden", borderBottom: "1px solid rgba(42,42,42,0.12)", background: "rgba(42,42,42,0.04)", cursor: "col-resize" }}
            onPointerDown={handleRulerPointerDown}
          >
            <div style={{ position: "absolute", left: -timelineScroll, top: 0, width: timelineWidth + 200, height: "100%", pointerEvents: "none" }}>
              {rulerTicks()}
            </div>
            <div style={{ position: "absolute", left: playhead * pxPerSec - timelineScroll, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none" }} />
          </div>

          {/* Track — 5 visual layers above, narration audio row below */}
          <div
            ref={scrollerRef}
            style={{ flex: 1, minHeight: TRACK_H + NARRATION_TRACK_H + CHARACTER_TRACK_H + 16, position: "relative", overflowX: "auto", overflowY: "hidden" }}
            onScroll={(e) => {
              const sl = (e.target as HTMLDivElement).scrollLeft;
              timelineScrollRef.current = sl;
              setTimelineScroll(sl);
            }}
            onPointerDown={handleTimelinePointerDown}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleTimelineDrop}
            onContextMenu={(e) => {
              e.preventDefault();
              const rect = scrollerRef.current!.getBoundingClientRect();
              const timeSec = Math.max(0, (e.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current);
              const clipEl = (e.target as HTMLElement).closest("[data-clipblock]") as HTMLElement | null;
              const clipId = clipEl?.dataset.clipid;
              setContextMenu({ x: e.clientX, y: e.clientY, timeSec, clipId });
            }}
          >
            <div style={{ position: "relative", width: timelineWidth, height: TRACK_H + NARRATION_TRACK_H + CHARACTER_TRACK_H + 12 }}>
              {/* Layer row backgrounds (L0–L4) */}
              {Array.from({ length: N_LAYERS }, (_, i) => (
                <div key={i} style={{ position: "absolute", left: 0, right: 0, top: i * LAYER_H, height: LAYER_H, background: i % 2 === 0 ? "rgba(100,130,180,0.04)" : "rgba(100,130,180,0.08)", borderTop: i === 0 ? "1px solid rgba(42,42,42,0.08)" : "1px solid rgba(42,42,42,0.05)" }} />
              ))}
              {/* Layer labels L0–L4 (track scroll position) */}
              {Array.from({ length: N_LAYERS }, (_, i) => (
                <div key={i} style={{ position: "absolute", left: timelineScroll + 2, top: i * LAYER_H + 1, zIndex: 15, display: "flex", alignItems: "center", gap: 3 }}>
                  <button
                    title={mutedLayers[i] ? `Unmute layer L${i}` : `Mute layer L${i}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); toggleLayerMute(i); }}
                    style={{
                      width: 16,
                      height: 14,
                      padding: 0,
                      border: "1px solid rgba(42,42,42,0.35)",
                      background: mutedLayers[i] ? "#ff5e3a" : "rgba(255,253,245,0.85)",
                      color: mutedLayers[i] ? "#fff" : "#2a2a2a",
                      fontSize: 8,
                      lineHeight: "12px",
                      fontFamily: "monospace",
                      cursor: "pointer",
                    }}
                  >
                    {mutedLayers[i] ? "×" : "♪"}
                  </button>
                  <span style={{ fontSize: 7, fontFamily: "monospace", color: mutedLayers[i] ? "#ff5e3a" : "rgba(42,42,42,0.3)", letterSpacing: 0.5 }}>L{i}</span>
                </div>
              ))}
              {/* Narration row background */}
              <div style={{ position: "absolute", left: 0, right: 0, top: TRACK_H + 4, height: NARRATION_TRACK_H, background: "rgba(255,150,200,0.05)", borderTop: "1px dashed rgba(42,42,42,0.18)" }} />
              {/* Row label for narration row */}
              <div style={{ position: "absolute", left: timelineScroll + 2, top: TRACK_H + 6, pointerEvents: "none", zIndex: 15 }}>
                <span style={{ fontSize: 7, fontFamily: "monospace", color: "rgba(180,80,130,0.5)", letterSpacing: 0.5, textTransform: "uppercase" }}>audio</span>
              </div>
              {timelineMarquee && (() => {
                const left = Math.min(timelineMarquee.startX, timelineMarquee.currentX);
                const top = Math.min(timelineMarquee.startY, timelineMarquee.currentY);
                const width = Math.abs(timelineMarquee.currentX - timelineMarquee.startX);
                const height = Math.abs(timelineMarquee.currentY - timelineMarquee.startY);
                return (
                  <div style={{ position: "absolute", left, top, width, height, border: "1.5px dashed #ff5e3a", background: "rgba(255,94,58,0.12)", pointerEvents: "none", zIndex: 30 }} />
                );
              })()}

              {/* Visual clips (image / video / pan) */}
              {clips.filter((c) => c.type !== "narration").map((clip, ci) => {
                const color = clip.type === "pan" ? PAN_CLIP_COLOR : CLIP_COLORS[ci % CLIP_COLORS.length];
                const selected = clip.id === selectedClipId || selectedClipIds.includes(clip.id);
                const clipPx = Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSec);
                const hf = clip.holdFraction ?? HOLD_FRACTION;
                const innerW = clipPx - HANDLE_W * 2;
                const holdW = Math.max(0, innerW * hf);
                const transW = Math.max(0, innerW * (1 - hf));
                const holdColor = shadeColor(color, 0.82);
                const transColor = shadeColor(color, 1.18);
                const dividerLeft = HANDLE_W + holdW;
                const clipLayer = clip.layer ?? 1;
                return (
                  <div
                    key={clip.id}
                    data-clipblock
                    data-clipid={clip.id}
                    style={{
                      position: "absolute",
                      left: clip.startTime * pxPerSec,
                      top: clipLayer * LAYER_H + 2,
                      width: clipPx,
                      height: LAYER_H - 4,
                      border: selected ? "2px solid #2a2a2a" : "1.5px solid rgba(42,42,42,0.35)",
                      boxShadow: selected ? "2px 2px 0 #2a2a2a" : "none",
                      cursor: "grab",
                      userSelect: "none",
                      overflow: "hidden",
                    }}
                    onClick={(e) => { e.stopPropagation(); setClipSelection([clip.id]); }}
                    onPointerDown={(e) => handleClipPointerDown(e, clip, "move")}
                  >
                    {/* Hold region */}
                    <div style={{ position: "absolute", left: HANDLE_W, top: 0, width: holdW, bottom: 0, background: holdColor, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                      {holdW > 30 && (
                        <span style={{ fontSize: 7, fontFamily: "monospace", color: "rgba(42,42,42,0.5)", textTransform: "uppercase", letterSpacing: 0.5, pointerEvents: "none" }}>hold</span>
                      )}
                    </div>
                    {/* Transition region */}
                    <div style={{ position: "absolute", left: HANDLE_W + holdW, top: 0, width: transW, bottom: 0, background: transColor, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                      {transW > 36 && (
                        <span style={{ fontSize: 7, fontFamily: "monospace", color: "rgba(42,42,42,0.5)", textTransform: "uppercase", letterSpacing: 0.5, pointerEvents: "none" }}>trans</span>
                      )}
                    </div>
                    {/* Divider */}
                    <div
                      style={{ position: "absolute", left: dividerLeft - 1, top: 0, bottom: 0, width: 3, background: "rgba(42,42,42,0.65)", cursor: "col-resize", zIndex: 5 }}
                      onPointerDown={(e) => handleDividerPointerDown(e, clip)}
                    />
                    {/* Left resize handle */}
                    <div
                      style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.25)", zIndex: 6 }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-left")}
                    />
                    {/* Clip name */}
                    <span style={{ position: "absolute", left: HANDLE_W + 4, right: HANDLE_W + 4, top: "50%", transform: "translateY(-50%)", fontFamily: "monospace", fontSize: 9, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", color: "#2a2a2a", pointerEvents: "none", zIndex: 4 }}>
                      {clip.type === "pan" ? "⟷ Pan" : `${clip.name}${clip.boardX !== undefined ? " [B]" : ""}`}
                    </span>
                    {/* Right resize handle */}
                    <div
                      style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.25)", zIndex: 6 }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-right")}
                    />
                  </div>
                );
              })}

              {/* Narration clips row */}
              {clips.filter((c) => c.type === "narration").map((clip) => {
                const selected = clip.id === selectedClipId || selectedClipIds.includes(clip.id);
                const clipPx = Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSec);
                return (
                  <div
                    key={clip.id}
                    data-clipblock
                    data-clipid={clip.id}
                    style={{
                      position: "absolute",
                      left: clip.startTime * pxPerSec,
                      top: TRACK_H + 4 + 2,
                      width: clipPx,
                      height: NARRATION_TRACK_H - 4,
                      background: NARRATION_COLOR,
                      border: selected ? "2px solid #2a2a2a" : "1.5px solid rgba(180,80,130,0.5)",
                      boxShadow: selected ? "2px 2px 0 #2a2a2a" : "none",
                      cursor: "grab",
                      userSelect: "none",
                      overflow: "hidden",
                    }}
                    onClick={(e) => { e.stopPropagation(); setClipSelection([clip.id]); }}
                    onPointerDown={(e) => handleClipPointerDown(e, clip, "move")}
                  >
                    {/* Left resize handle */}
                    <div
                      style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.2)", zIndex: 6 }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-left")}
                    />
                    {/* Waveform */}
                    {clip.waveform && clip.waveform.length > 0 && (
                      <svg
                        viewBox={`0 0 ${clip.waveform.length} 1`}
                        preserveAspectRatio="none"
                        style={{ position: "absolute", left: HANDLE_W, right: HANDLE_W, top: 0, bottom: 0, width: `calc(100% - ${HANDLE_W * 2}px)`, height: "100%", pointerEvents: "none" }}
                      >
                        {clip.waveform.map((v, i) => (
                          <rect key={i} x={i} y={(1 - v) / 2} width={0.85} height={Math.max(0.02, v)} fill="rgba(120,40,80,0.4)" />
                        ))}
                      </svg>
                    )}
                    {/* Label */}
                    <span style={{ position: "absolute", left: HANDLE_W + 4, right: HANDLE_W + 4, top: "50%", transform: "translateY(-50%)", fontFamily: "monospace", fontSize: 8, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", color: "#5a1530", pointerEvents: "none", zIndex: 4 }}>
                      🎙 {clip.name} {clip.duration.toFixed(1)}s
                    </span>
                    {/* Right resize handle */}
                    <div
                      style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.2)", zIndex: 6 }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-right")}
                    />
                  </div>
                );
              })}

              {/* Character row background */}
              {showCharacter && (
                <>
                  <div style={{ position: "absolute", left: 0, right: 0, top: TRACK_H + NARRATION_TRACK_H + 8, height: CHARACTER_TRACK_H, background: "rgba(100,200,100,0.06)", borderTop: "1px dashed rgba(42,42,42,0.18)" }} />
                  <div style={{ position: "absolute", left: timelineScroll + 2, top: TRACK_H + NARRATION_TRACK_H + 10, pointerEvents: "none", zIndex: 15 }}>
                    <span style={{ fontSize: 7, fontFamily: "monospace", color: "rgba(60,130,60,0.6)", letterSpacing: 0.5, textTransform: "uppercase" }}>char</span>
                  </div>
                  {/* Character action blocks — show derived auto-actions (dimmed) + manual actions */}
                  {resolvedCharActions.map((action) => {
                    const isAuto = characterMode === "auto" && !characterActions.find((m) => m.id === action.id);
                    const actionPx = Math.max(HANDLE_W * 2 + 4, action.duration * pxPerSec);
                    const icons: Record<string, string> = {
                      walkTo: "⇒", jumpTo: "↑", grapple: "🪝", pointAt: "→", emote: action.emoji ?? "🤔", idle: "⏸",
                      flip: "🤸", zipline: "🪢", wallClimb: "🧗", sitAndWatch: "🍿", explainGesture: "💬",
                    };
                    return (
                      <div
                        key={action.id}
                        data-charaction
                        data-actionid={action.id}
                        style={{
                          position: "absolute",
                          left: action.startTime * pxPerSec,
                          top: TRACK_H + NARRATION_TRACK_H + 10,
                          width: actionPx,
                          height: CHARACTER_TRACK_H - 4,
                          background: isAuto ? "rgba(180,220,170,0.45)" : CHARACTER_COLOR,
                          border: isAuto ? "1px dashed rgba(60,130,60,0.35)" : "1.5px solid rgba(60,130,60,0.5)",
                          cursor: isAuto ? "default" : "grab",
                          userSelect: "none",
                          overflow: "hidden",
                          display: "flex",
                          alignItems: "center",
                          opacity: isAuto ? 0.7 : 1,
                        }}
                        onPointerDown={isAuto ? undefined : (e) => handleCharActionPointerDown(e, action, "move")}
                        onContextMenu={isAuto ? undefined : (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCharActionContextMenu({ x: e.clientX, y: e.clientY, actionId: action.id });
                        }}
                      >
                        {/* Left resize — manual only */}
                        {!isAuto && (
                          <div
                            style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.2)", zIndex: 6 }}
                            onPointerDown={(e) => handleCharActionPointerDown(e, action, "resize-left")}
                          />
                        )}
                        <span style={{ position: "absolute", left: HANDLE_W + 3, right: HANDLE_W + 3, fontSize: 8, fontFamily: "monospace", color: "#2a4a2a", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", pointerEvents: "none", zIndex: 4 }}>
                          {icons[action.type]} {action.type}
                        </span>
                        {/* AI-choreographed badge — drag/resize/delete work the same as any manual action */}
                        {action.aiGenerated && (
                          <span title="AI-choreographed" style={{ position: "absolute", top: -1, right: 1, fontSize: 8, zIndex: 5, pointerEvents: "none" }}>✨</span>
                        )}
                        {/* Right resize — manual only */}
                        {!isAuto && (
                          <div
                            style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.2)", zIndex: 6 }}
                            onPointerDown={(e) => handleCharActionPointerDown(e, action, "resize-right")}
                          />
                        )}
                      </div>
                    );
                  })}
                </>
              )}

              <div style={{ position: "absolute", left: playhead * pxPerSec, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none", zIndex: 10 }} />
            </div>
          </div>
        </div>
      </div>

      {/* Character action context menu */}
      {charActionContextMenu && (
        <div
          style={{ position: "fixed", left: charActionContextMenu.x, top: charActionContextMenu.y, zIndex: 9999, background: "#fffdf5", border: "1.5px solid #2a2a2a", boxShadow: "2px 2px 0 #2a2a2a", fontFamily: "monospace", minWidth: 120 }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            onClick={() => { setCharacterActions((prev) => prev.filter((a) => a.id !== charActionContextMenu.actionId)); setCharActionContextMenu(null); }}
            style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, color: "#ff5e3a" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#ffe5e5")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            ✕ Delete action
          </div>
        </div>
      )}

      {/* Timeline context menu */}
      {contextMenu && (
        <div
          style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 9998, background: "#fffdf5", border: "1.5px solid #2a2a2a", boxShadow: "2px 2px 0 #2a2a2a", fontFamily: "monospace", minWidth: 140 }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.clipId ? (
            // Clip right-click menu
            <>
              <div onClick={() => { copyClip(contextMenu.clipId!); setContextMenu(null); }}
                style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, borderBottom: "1px solid rgba(42,42,42,0.08)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#c8f135")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                ⌘C Copy
              </div>
              <div onClick={() => { duplicateClip(contextMenu.clipId!); setContextMenu(null); }}
                style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, borderBottom: "1px solid rgba(42,42,42,0.08)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#c8f135")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                ⌘D Duplicate
              </div>
              {clipboardReady && (
                <div onClick={() => { pasteClip(); setContextMenu(null); }}
                  style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, borderBottom: "1px solid rgba(42,42,42,0.08)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#c8f135")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  ⌘V Paste
                </div>
              )}
              <div onClick={() => { deleteClip(contextMenu.clipId!); setContextMenu(null); }}
                style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, color: "#ff5e3a" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#ffe5e5")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                ✕ Delete
              </div>
            </>
          ) : (
            // Empty timeline right-click menu
            <>
              <div onClick={() => { addPanClip(contextMenu.timeSec); setContextMenu(null); }}
                style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, borderBottom: "1px solid rgba(42,42,42,0.12)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = PAN_CLIP_COLOR)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                ⟷ Add pan here
              </div>
              {clipboardReady && (
                <div onClick={() => { pasteClip(); setContextMenu(null); }}
                  style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#c8f135")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  ⌘V Paste here
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Divider drag tooltip */}
      {dividerTooltip && (
        <div style={{ position: "fixed", left: dividerTooltip.x + 12, top: dividerTooltip.y - 32, background: "#2a2a2a", color: "#c8f135", fontFamily: "monospace", fontSize: 10, padding: "3px 8px", border: "1px solid #c8f135", pointerEvents: "none", zIndex: 9999, whiteSpace: "nowrap" }}>
          {dividerTooltip.label}
        </div>
      )}

      {/* YouTube Modal */}
      {ytModalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setYtModalOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 640, maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", fontFamily: "monospace", overflow: "hidden" }}>

            <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>
                {ytView === "search" ? "▶ ADD YOUTUBE CLIP" : `▶ TRIM  —  ${(ytSelected?.title ?? "").slice(0, 45)}${(ytSelected?.title?.length ?? 0) > 45 ? "…" : ""}`}
              </span>
              <button onClick={() => setYtModalOpen(false)} style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15 }}>×</button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
              {ytView === "search" ? (
                <>
                  {/* Tabs */}
                  <div style={{ display: "flex", marginBottom: 14, borderBottom: "1.5px solid #2a2a2a" }}>
                    {(["paste", "search"] as const).map((tab) => (
                      <button key={tab} onClick={() => { setYtTab(tab); setYtError(""); }}
                        style={{ fontFamily: "monospace", padding: "6px 14px", fontSize: 11, fontWeight: ytTab === tab ? 700 : 400, background: ytTab === tab ? "#2a2a2a" : "transparent", color: ytTab === tab ? "#fffdf5" : "#2a2a2a", border: "none", borderBottom: ytTab === tab ? "2px solid #c8f135" : "none", cursor: "pointer" }}>
                        {tab === "paste" ? "Paste URL" : "Search"}
                      </button>
                    ))}
                  </div>

                  {ytTab === "paste" ? (
                    <div>
                      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                        <input autoFocus type="text" value={ytUrlInput}
                          onChange={(e) => setYtUrlInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleYtPasteUrl(); }}
                          placeholder="https://www.youtube.com/watch?v=..."
                          style={{ flex: 1, fontFamily: "monospace", fontSize: 12, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a" }}
                        />
                        <button onClick={handleYtPasteUrl} style={{ ...miniButton, padding: "8px 16px", fontSize: 12, fontWeight: 700 }}>
                          Next →
                        </button>
                      </div>
                      {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, margin: 0 }}>{ytError}</p>}
                      <p style={{ fontSize: 10, color: "#9a9a9a", lineHeight: 1.6, marginTop: 10 }}>
                        Paste a YouTube URL — you&apos;ll trim it in the next step.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                        <div style={{ display: "flex", flexShrink: 0 }}>
                          {(["Shorts", "Normal"] as const).map((label) => {
                            const active = label === "Shorts" ? ytShortsOnly : !ytShortsOnly;
                            return (
                              <button key={label}
                                onClick={() => { const v = label === "Shorts"; setYtShortsOnly(v); handleYtSearch(v); }}
                                style={{ ...miniButton, fontSize: 11, padding: "4px 8px", background: active ? "#2a2a2a" : "transparent", color: active ? "#fffdf5" : "#2a2a2a", marginRight: label === "Shorts" ? -1 : 0, position: "relative", zIndex: active ? 1 : 0 }}>
                                {label}
                              </button>
                            );
                          })}
                        </div>
                        <input autoFocus type="text" value={ytQuery}
                          onChange={(e) => setYtQuery(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleYtSearch(); }}
                          placeholder="search youtube..."
                          style={{ flex: 1, fontFamily: "monospace", fontSize: 13, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a" }}
                        />
                        <button onClick={() => handleYtSearch()} disabled={ytLoading}
                          style={{ ...miniButton, padding: "8px 16px", fontSize: 12, fontWeight: 700, opacity: ytLoading ? 0.5 : 1 }}>
                          {ytLoading ? "..." : "search"}
                        </button>
                      </div>
                      {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, marginBottom: 8 }}>{ytError}</p>}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                        {ytResults.map((r) => (
                          <div key={r.id}
                            onClick={() => {
                              const maxSec = parseDurationSec(r.duration);
                              const initEnd = Math.min(30, maxSec || 30);
                              setYtSelected(r);
                              setYtStart(0); setYtStartInput("0:00");
                              setYtEnd(initEnd); setYtEndInput(formatTimestamp(initEnd));
                              ytRangeRef.current = { start: 0, end: initEnd };
                              setYtView("trim");
                            }}
                            style={{ border: "1.5px solid #2a2a2a", cursor: "pointer", background: "rgba(255,253,245,0.9)", boxShadow: "2px 2px 0 #2a2a2a", overflow: "hidden" }}
                          >
                            {r.thumbnail && <img src={r.thumbnail} alt="" style={{ width: "100%", display: "block", aspectRatio: "16/9", objectFit: "cover" }} />}
                            <div style={{ padding: "5px 7px" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, lineHeight: 1.3, marginBottom: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>
                                {r.title ?? "(no title)"}
                              </div>
                              <div style={{ fontSize: 9, color: "#6a6a6a" }}>
                                {r.channel ?? ""}{r.channel && r.duration != null ? " · " : ""}
                                {r.duration != null ? (typeof r.duration === "number" ? formatTimestamp(r.duration) : r.duration) : ""}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  {ytSelected && (() => {
                    const maxSec = parseDurationSec(ytSelected.duration) || 600;
                    const pctOf = (v: number) => Math.max(0, Math.min(100, (v / Math.max(0.1, maxSec)) * 100));
                    const clipLen = Math.max(0, ytEnd - ytStart);
                    const handleSliderMouseDown = (which: "start" | "end") => (e: React.MouseEvent) => {
                      e.preventDefault();
                      const track = ytSliderTrackRef.current;
                      if (!track) return;
                      const onMove = (ev: MouseEvent) => {
                        const rect = track.getBoundingClientRect();
                        const raw = ((ev.clientX - rect.left) / rect.width) * maxSec;
                        const clamped = Math.max(0, Math.min(maxSec, raw));
                        if (which === "start") {
                          const curEnd = ytRangeRef.current.end;
                          const newStart = Math.max(0, Math.min(clamped, curEnd - 0.5));
                          ytRangeRef.current.start = newStart;
                          setYtStart(newStart); setYtStartInput(formatTimestamp(newStart));
                          if (curEnd - newStart > 30) {
                            const newEnd = newStart + 30;
                            ytRangeRef.current.end = newEnd; setYtEnd(newEnd); setYtEndInput(formatTimestamp(newEnd));
                          }
                        } else {
                          const curStart = ytRangeRef.current.start;
                          const newEnd = Math.max(curStart + 0.5, Math.min(maxSec, Math.min(clamped, curStart + 30)));
                          ytRangeRef.current.end = newEnd; setYtEnd(newEnd); setYtEndInput(formatTimestamp(newEnd));
                        }
                      };
                      const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                      window.addEventListener("mousemove", onMove);
                      window.addEventListener("mouseup", onUp);
                    };
                    return (
                      <div>
                        <div style={{ marginBottom: 14, background: "#000", lineHeight: 0 }}>
                          <iframe
                            src={`https://www.youtube.com/embed/${ytSelected.id}?start=${Math.floor(ytStart)}&autoplay=0`}
                            style={{ width: "100%", aspectRatio: "16/9", border: "none" }}
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                            allowFullScreen
                          />
                        </div>
                        <div ref={ytSliderTrackRef} style={{ position: "relative", height: 36, margin: "0 4px 14px", userSelect: "none" }}>
                          <div style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: 0, right: 0, height: 8, background: "#d8d5c9", border: "1.5px solid #2a2a2a" }} />
                          <div style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: `${pctOf(ytStart)}%`, width: `${Math.max(0, pctOf(ytEnd) - pctOf(ytStart))}%`, height: 8, background: "#c8f135", borderTop: "1.5px solid #2a2a2a", borderBottom: "1.5px solid #2a2a2a" }} />
                          <div onMouseDown={handleSliderMouseDown("start")} style={{ position: "absolute", top: "50%", left: `${pctOf(ytStart)}%`, transform: "translate(-50%, -50%)", width: 12, height: 24, background: "#2a2a2a", cursor: "ew-resize", zIndex: 3 }} />
                          <div onMouseDown={handleSliderMouseDown("end")} style={{ position: "absolute", top: "50%", left: `${pctOf(ytEnd)}%`, transform: "translate(-50%, -50%)", width: 12, height: 24, background: "#2a2a2a", cursor: "ew-resize", zIndex: 3 }} />
                        </div>
                        <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 3 }}>Start</div>
                            <input type="text" value={ytStartInput} placeholder="0:00"
                              onChange={(e) => {
                                setYtStartInput(e.target.value);
                                const p = parseTimestampSec(e.target.value);
                                if (p !== null) {
                                  const newStart = Math.max(0, Math.min(maxSec - 0.5, p));
                                  const curEnd = ytRangeRef.current.end;
                                  ytRangeRef.current.start = newStart; setYtStart(newStart);
                                  if (curEnd <= newStart + 0.5) {
                                    const newEnd = Math.min(newStart + 30, maxSec);
                                    ytRangeRef.current.end = newEnd; setYtEnd(newEnd); setYtEndInput(formatTimestamp(newEnd));
                                  } else if (curEnd - newStart > 30) {
                                    const newEnd = newStart + 30;
                                    ytRangeRef.current.end = newEnd; setYtEnd(newEnd); setYtEndInput(formatTimestamp(newEnd));
                                  }
                                }
                              }}
                              onBlur={() => setYtStartInput(formatTimestamp(ytStart))}
                              style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties}
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 3 }}>End</div>
                            <input type="text" value={ytEndInput} placeholder="0:30"
                              onChange={(e) => {
                                setYtEndInput(e.target.value);
                                const p = parseTimestampSec(e.target.value);
                                if (p !== null) {
                                  const newEnd = Math.max(ytRangeRef.current.start + 0.5, Math.min(maxSec, Math.min(p, ytRangeRef.current.start + 30)));
                                  ytRangeRef.current.end = newEnd; setYtEnd(newEnd);
                                }
                              }}
                              onBlur={() => setYtEndInput(formatTimestamp(ytEnd))}
                              style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties}
                            />
                          </div>
                        </div>
                        <div style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>
                          Clip length: {formatTimestamp(clipLen)}
                          <span style={{ marginLeft: 8 }}>· {formatTimestamp(maxSec)} total</span>
                        </div>
                        {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, fontFamily: "monospace", marginTop: 6, marginBottom: 0 }}>{ytError}</p>}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>

            {ytView === "trim" && (
              <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => { setYtView("search"); setYtSelected(null); setYtError(""); }} style={{ ...miniButton, padding: "6px 12px", fontSize: 11 }}>← back</button>
                <button onClick={handleYtConfirm}
                  style={{ ...miniButton, marginLeft: "auto", padding: "6px 18px", fontSize: 12, fontWeight: 700, background: "#c8f135", borderColor: "#2a2a2a" }}>
                  Add to board
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* AI Annotation Modal */}
      {directCharacterOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !choreoPhase) setDirectCharacterOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 480, maxWidth: "95vw", fontFamily: "monospace", overflow: "hidden" }}>

            {/* Header */}
            <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>🎬 DIRECT CHARACTER</span>
              <button
                onClick={() => { if (!choreoPhase) setDirectCharacterOpen(false); }}
                style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15, opacity: choreoPhase ? 0.4 : 1 }}
              >×</button>
            </div>

            <div style={{ padding: 16 }}>
              <p style={{ fontSize: 11, color: "#6a6a6a", margin: "0 0 10px", lineHeight: 1.5 }}>
                Describe what the character should do through the video. GPT-4o maps it onto your actual clip order and camera timing.
              </p>
              <textarea
                value={characterDirection}
                onChange={(e) => setCharacterDirection(e.target.value)}
                disabled={!!choreoPhase}
                placeholder="He flips in onto image 1, explains it excitedly, grapples to the video and watches with popcorn, then ziplines to the last image and flips off screen"
                rows={5}
                style={{
                  width: "100%", fontFamily: "monospace", fontSize: 11,
                  border: "1.5px solid #2a2a2a", padding: "8px",
                  resize: "vertical", boxSizing: "border-box",
                  background: choreoPhase ? "#f5f5f0" : "#fff",
                } as React.CSSProperties}
              />

              {clips.some((c) => c.type === "narration") && (
                <label style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 10, fontSize: 11, cursor: choreoPhase ? "default" : "pointer" }}>
                  <input
                    type="checkbox"
                    checked={syncEmotesToNarration}
                    disabled={!!choreoPhase}
                    onChange={(e) => setSyncEmotesToNarration(e.target.checked)}
                  />
                  Sync emotes to my narration
                </label>
              )}

              {choreoPhase && (
                <div style={{ marginTop: 10, fontSize: 11, color: "#1a6fd4" }}>
                  ⟳ {choreoPhase}
                </div>
              )}
              {choreoError && (
                <div style={{ marginTop: 10, fontSize: 11, color: "#cc2200" }}>
                  ✗ {choreoError}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => { if (!choreoPhase) setDirectCharacterOpen(false); }}
                disabled={!!choreoPhase}
                style={{ ...miniButton, padding: "6px 14px", fontSize: 11, opacity: choreoPhase ? 0.4 : 1 }}
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateChoreography}
                disabled={!!choreoPhase || (!characterDirection.trim() && !(syncEmotesToNarration && clips.some((c) => c.type === "narration")))}
                style={{
                  ...miniButton, padding: "6px 18px", fontSize: 12, fontWeight: 700,
                  background: "#c8f135", borderColor: "#2a2a2a",
                  opacity: (!!choreoPhase || (!characterDirection.trim() && !(syncEmotesToNarration && clips.some((c) => c.type === "narration")))) ? 0.5 : 1,
                  cursor: (!!choreoPhase || (!characterDirection.trim() && !(syncEmotesToNarration && clips.some((c) => c.type === "narration")))) ? "not-allowed" : "pointer",
                }}
              >
                {choreoPhase ? "Working…" : "Generate choreography →"}
              </button>
            </div>
          </div>
        </div>
      )}

      {aiModalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !aiPhase) setAiModalOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 480, maxWidth: "95vw", fontFamily: "monospace", overflow: "hidden" }}>

            {/* Header */}
            <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>✨ AUTO-GENERATE ANNOTATIONS</span>
              <button
                onClick={() => { if (!aiPhase) setAiModalOpen(false); }}
                style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15, opacity: aiPhase ? 0.4 : 1 }}
              >×</button>
            </div>

            <div style={{ padding: 16 }}>
              {/* Tabs */}
              <div style={{ display: "flex", marginBottom: 14, borderBottom: "1.5px solid #2a2a2a" }}>
                {(["audio", "script"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => { if (!aiPhase) setAiTab(tab); }}
                    style={{
                      fontFamily: "monospace", fontSize: 11, fontWeight: 700,
                      padding: "5px 14px", border: "none", cursor: aiPhase ? "default" : "pointer",
                      background: aiTab === tab ? "#2a2a2a" : "transparent",
                      color: aiTab === tab ? "#fff" : "#6a6a6a",
                      borderBottom: aiTab === tab ? "2px solid #2a2a2a" : "2px solid transparent",
                      marginBottom: -2,
                    }}
                  >
                    {tab === "audio" ? "↑ Upload audio" : "✎ Paste script"}
                  </button>
                ))}
              </div>

              {aiTab === "audio" ? (
                <div>
                  <p style={{ fontSize: 11, color: "#6a6a6a", margin: "0 0 10px", lineHeight: 1.5 }}>
                    Upload a narration recording (.mp3, .wav, .m4a, .webm) — max 25MB. Whisper will transcribe it, then GPT-4o will generate annotations.
                  </p>
                  <input
                    type="file"
                    accept=".mp3,.wav,.m4a,.webm,audio/*"
                    disabled={!!aiPhase}
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      if (!f) return;
                      if (f.size > 25 * 1024 * 1024) { setAiError("File too large (max 25MB)"); return; }
                      setAiAudioFile(f);
                      setAiError(null);
                    }}
                    style={{ display: "block", marginBottom: 8, fontFamily: "monospace", fontSize: 11 }}
                  />
                  {aiAudioFile && (
                    <div style={{ fontSize: 10, color: "#228b22", marginBottom: 4 }}>
                      ✓ {aiAudioFile.name} ({(aiAudioFile.size / 1024 / 1024).toFixed(1)} MB)
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <p style={{ fontSize: 11, color: "#6a6a6a", margin: "0 0 10px", lineHeight: 1.5 }}>
                    Paste your narration script. GPT-4o will read it and generate annotations that emphasize key ideas on the board.
                  </p>
                  <textarea
                    value={aiScriptText}
                    onChange={(e) => setAiScriptText(e.target.value)}
                    disabled={!!aiPhase}
                    placeholder="Paste your narration script here…"
                    rows={8}
                    style={{
                      width: "100%", fontFamily: "monospace", fontSize: 11,
                      border: "1.5px solid #2a2a2a", padding: "8px",
                      resize: "vertical", boxSizing: "border-box",
                      background: aiPhase ? "#f5f5f0" : "#fff",
                    } as React.CSSProperties}
                  />
                </div>
              )}

              {aiPhase && (
                <div style={{ marginTop: 10, fontSize: 11, color: "#1a6fd4" }}>
                  ⟳ {aiPhase}
                </div>
              )}
              {aiError && (
                <div style={{ marginTop: 10, fontSize: 11, color: "#cc2200" }}>
                  ✗ {aiError}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => { if (!aiPhase) setAiModalOpen(false); }}
                disabled={!!aiPhase}
                style={{ ...miniButton, padding: "6px 14px", fontSize: 11, opacity: aiPhase ? 0.4 : 1 }}
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateAnnotations}
                disabled={!!aiPhase || (aiTab === "audio" ? !aiAudioFile : !aiScriptText.trim())}
                style={{
                  ...miniButton, padding: "6px 18px", fontSize: 12, fontWeight: 700,
                  background: "#c8f135", borderColor: "#2a2a2a",
                  opacity: (!!aiPhase || (aiTab === "audio" ? !aiAudioFile : !aiScriptText.trim())) ? 0.5 : 1,
                  cursor: (!!aiPhase || (aiTab === "audio" ? !aiAudioFile : !aiScriptText.trim())) ? "not-allowed" : "pointer",
                }}
              >
                {aiPhase ? "Working…" : "Generate →"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#2a2a2a", color: "#c8f135", fontFamily: "monospace", fontSize: 11, padding: "8px 16px", border: "1.5px solid #c8f135", boxShadow: "2px 2px 0 #c8f135", zIndex: 9999, pointerEvents: "none", whiteSpace: "nowrap" }}>
          {toast}
        </div>
      )}
      {renderDownloadToasts()}
      {renderNeuralSearchModal()}
      {renderTop5Modal()}
      {renderImagePreviewModal()}

      {/* Save modal */}
      {saveModalOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }} onClick={() => setSaveModalOpen(false)}>
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", padding: "24px 28px", minWidth: 300, boxShadow: "4px 4px 0 #2a2a2a" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "#6a6a6a", textTransform: "uppercase", marginBottom: 14 }}>Save project</div>
            <input
              type="text" value={saveName} onChange={(e) => setSaveName(e.target.value)}
              placeholder="Board name" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") saveBoard(); if (e.key === "Escape") setSaveModalOpen(false); }}
              style={{ width: "100%", fontFamily: "monospace", fontSize: 14, padding: "9px 10px", border: "1.5px solid #2a2a2a", background: "#fff", boxSizing: "border-box" as const, marginBottom: 14, outline: "none" }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={saveBoard} disabled={isSaving} style={{ ...sketchButton, flex: 1, background: "#c8f135", fontWeight: 700 }}>
                {isSaving ? "Saving…" : "💾 Download .nbp"}
              </button>
              <button onClick={() => setSaveModalOpen(false)} style={{ ...sketchButton, flex: 1 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Narration compilation utilities ─────────────────────────────────────────

function writeWavStr(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

function audioBufferToWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const n = buf.length;
  const dataLen = n * ch * 2;
  const ab = new ArrayBuffer(44 + dataLen);
  const v = new DataView(ab);
  writeWavStr(v, 0, "RIFF"); v.setUint32(4, 36 + dataLen, true); writeWavStr(v, 8, "WAVE");
  writeWavStr(v, 12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  writeWavStr(v, 36, "data"); v.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(c)[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

async function compileNarrationToBlob(narrationClips: Clip[]): Promise<Blob> {
  const sorted = [...narrationClips].sort((a, b) => a.startTime - b.startTime);
  if (sorted.length === 1) {
    const clip = sorted[0];
    if (clip.audioBlob) return clip.audioBlob;
    return fetch(clip.sourceUrl).then((r) => r.blob());
  }
  const tmpCtx = new AudioContext();
  const decoded: { clip: Clip; buffer: AudioBuffer }[] = [];
  try {
    for (const clip of sorted) {
      const ab = clip.audioBlob
        ? await clip.audioBlob.arrayBuffer()
        : await fetch(clip.sourceUrl).then((r) => r.arrayBuffer());
      const buffer = await tmpCtx.decodeAudioData(ab);
      decoded.push({ clip, buffer });
    }
  } finally {
    await tmpCtx.close().catch(() => {});
  }
  const sampleRate = decoded[0].buffer.sampleRate;
  const firstStart = sorted[0].startTime;
  const lastClip = sorted[sorted.length - 1];
  const totalDur = lastClip.startTime + lastClip.duration - firstStart;
  const totalSamples = Math.ceil(totalDur * sampleRate);
  const numChannels = Math.max(...decoded.map((d) => d.buffer.numberOfChannels));
  const offCtx = new OfflineAudioContext(numChannels, totalSamples, sampleRate);
  for (const { clip, buffer } of decoded) {
    const node = offCtx.createBufferSource();
    node.buffer = buffer;
    node.connect(offCtx.destination);
    node.start(clip.startTime - firstStart);
  }
  const rendered = await offCtx.startRendering();
  return audioBufferToWav(rendered);
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Courier New', Courier, monospace",
  backgroundColor: "#f5f1e8",
  backgroundImage:
    "linear-gradient(rgba(100,130,180,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(100,130,180,.18) 1px, transparent 1px)",
  backgroundSize: "22px 22px",
  color: "#2a2a2a",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 22px",
  borderBottom: "1.5px dashed #2a2a2a",
  background: "rgba(255,253,245,0.75)",
  flexShrink: 0,
};

const navLinkStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#6a6a6a",
  fontFamily: "monospace",
  textDecoration: "none",
};

const panelLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontFamily: "monospace",
  color: "#6a6a6a",
  letterSpacing: 1,
  textTransform: "uppercase",
};

const sketchButton: React.CSSProperties = {
  fontFamily: "'Courier New', monospace",
  background: "#fffdf5",
  color: "#2a2a2a",
  border: "1.5px solid #2a2a2a",
  padding: "8px 14px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: "2px 2px 0 #2a2a2a",
};

const miniButton: React.CSSProperties = {
  fontFamily: "monospace",
  background: "transparent",
  border: "1px solid #2a2a2a",
  padding: "2px 6px",
  cursor: "pointer",
  fontSize: 10,
};
