"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession, signIn } from "next-auth/react";
import rough from "roughjs";
import { ProGated } from "@/app/components/ProGated";

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
const EMOJI_SET = ["🤔","⭐","🎯","❗","💡","🔥","✨","📈","📉","⚠️","❓","💬","👀","🚀","❤️","✅","❌","🌍","🧠","🎨","🏆","💎","🔑","📌","🎬","📊","💰","🔍","🤝","🌟","💥","🎤","📣","🌈","⏰","🎁"];
const MAGNETIC_SNAP_PX = 10;
const CLIP_COLORS = ["#c8f135", "#5ec4ff", "#ff9f5e", "#d4a8ff", "#ff6b9d", "#7df5b0"];
const PAN_CLIP_COLOR = "#f0e6a8";
const HOLD_FRACTION = 0.6;
const FRAME_ALL_PADDING = 0.1;
const CLIP_FOCUS_RATIO = 0.7;
const EXPORT_FPS = 60;
const PREVIEW_H_PX = 135;

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 0;
function generateId(): string {
  return `b2_${Date.now()}_${++_idCounter}`;
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function Board2Page() {
  const { data: session } = useSession();

  const [clips, setClips] = useState<Clip[]>([]);
  const [mediaLibrary, setMediaLibrary] = useState<MediaItem[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
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
  const [hoveredPlaceholderId, setHoveredPlaceholderId] = useState<string | null>(null);
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

  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { selectedClipIdsRef.current = selectedClipIds; }, [selectedClipIds]);
  useEffect(() => { selectedAnnotationIdsRef.current = selectedAnnotationIds; }, [selectedAnnotationIds]);
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
  function updateVideoVolume(clip: Clip, vid: HTMLVideoElement) {
    const nodes = videoAudioNodesRef.current.get(clip.id);
    if (nodes) {
      nodes.gainNode.gain.value = clip.muted ? 0 : (clip.volume ?? 1);
    } else {
      vid.muted = false;
      vid.volume = clip.muted ? 0 : (clip.volume ?? 1);
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
      };
      const videos = Array.isArray(data.videos) ? data.videos : [];
      if (videos.length === 0) {
        setNeuralError("No videos found — try describing the concept differently");
        return;
      }

      // Place each candidate on the board, avoiding overlap with existing clips, existing
      // placeholders, and the other candidates from this same search.
      const { camX, camY } = getVisibleBoardCenter();
      const occupied: Array<{ boardX?: number; boardY?: number; boardW?: number; boardH?: number }> =
        [...clipsRef.current, ...neuralPlaceholders];
      const newPlaceholders: NeuralPlaceholder[] = videos.map((v) => {
        const w = 800, h = 450;
        const pos = findFreeBoardPos(occupied, w, h, camX, camY);
        occupied.push({ boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h });
        return {
          id: generateId(), boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h,
          videoId: v.videoId, title: v.title, channel: v.channel, thumbnailUrl: v.thumbnailUrl,
          viewCount: v.viewCount, durationSec: v.durationSec,
        };
      });
      setNeuralPlaceholders((prev) => [...prev, ...newPlaceholders]);
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
    setSelectedClipId(clip.id);
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
    drawFrame(playheadRef.current);
    const n = allClipsSorted.length;
    setToast(`Camera keyframes generated: ${n} clip${n !== 1 ? "s" : ""} + frame-all`);
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
        gainNode.gain.value = clip.muted ? 0 : (clip.volume ?? 1);
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
        if (selectedClipId) deleteClip(selectedClipId);
        else if (selectedAnnotationId) deleteAnnotation(selectedAnnotationId);
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
              Describe your video concept. We&apos;ll find YouTube videos to match.
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
              {neuralPhase ? "Working…" : "Find Videos →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Mobile early returns ─────────────────────────────────────────────────

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
                  <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
                    {clip.type === "image" ? (
                      <img src={clip.sourceUrl} alt={clip.name} style={{ width: "100%", height: "100%", objectFit: "fill", display: "block" }} draggable={false} />
                    ) : (
                      <div style={{ width: "100%", height: "100%", background: "#1a1a2e", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ color: "#7df5b0", fontSize: Math.max(7, 10 * boardZoom), fontFamily: "monospace" }}>▶ {clip.name}</span>
                      </div>
                    )}
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "1px 3px", background: "rgba(42,42,42,0.7)", color: "#fff", fontSize: Math.max(6, 8 * boardZoom), fontFamily: "monospace", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
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
          </div>

          {clips.filter((c) => c.boardX !== undefined).length === 0 && neuralPlaceholders.length === 0 && (
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
      </div>
    );
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
                      onClick={(e) => { e.stopPropagation(); setSelectedClipId(clip.id); }}
                      onPointerDown={(e) => { if (!isSpaceDown) handleBoardClipPointerDown(e, clip); }}
                    >
                      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
                        {clip.type === "image" ? (
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
                      onClick={(e) => { if (annotationTool === "pointer") { e.stopPropagation(); setSelectedAnnotationId(ann.id); setSelectedClipId(null); } }}
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
              {clips.filter((c) => c.boardX !== undefined).length === 0 && neuralPlaceholders.length === 0 && (
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
            style={{ flex: 1, minHeight: TRACK_H + NARRATION_TRACK_H + 12, position: "relative", overflowX: "auto", overflowY: "hidden" }}
            onScroll={(e) => {
              const sl = (e.target as HTMLDivElement).scrollLeft;
              timelineScrollRef.current = sl;
              setTimelineScroll(sl);
            }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement) === scrollerRef.current) {
                setSelectedClipId(null);
                const rect = scrollerRef.current!.getBoundingClientRect();
                const x = e.clientX - rect.left + timelineScrollRef.current;
                setPlayhead(Math.max(0, x / pxPerSecRef.current));
                setIsPlaying(false);
              }
            }}
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
            <div style={{ position: "relative", width: timelineWidth, height: TRACK_H + NARRATION_TRACK_H + 8 }}>
              {/* Layer row backgrounds (L0–L4) */}
              {Array.from({ length: N_LAYERS }, (_, i) => (
                <div key={i} style={{ position: "absolute", left: 0, right: 0, top: i * LAYER_H, height: LAYER_H, background: i % 2 === 0 ? "rgba(100,130,180,0.04)" : "rgba(100,130,180,0.08)", borderTop: i === 0 ? "1px solid rgba(42,42,42,0.08)" : "1px solid rgba(42,42,42,0.05)" }} />
              ))}
              {/* Layer labels L0–L4 (track scroll position) */}
              {Array.from({ length: N_LAYERS }, (_, i) => (
                <div key={i} style={{ position: "absolute", left: timelineScroll + 2, top: i * LAYER_H + 1, pointerEvents: "none", zIndex: 15 }}>
                  <span style={{ fontSize: 7, fontFamily: "monospace", color: "rgba(42,42,42,0.3)", letterSpacing: 0.5 }}>L{i}</span>
                </div>
              ))}
              {/* Narration row background */}
              <div style={{ position: "absolute", left: 0, right: 0, top: TRACK_H + 4, height: NARRATION_TRACK_H, background: "rgba(255,150,200,0.05)", borderTop: "1px dashed rgba(42,42,42,0.18)" }} />
              {/* Row label for narration row */}
              <div style={{ position: "absolute", left: timelineScroll + 2, top: TRACK_H + 6, pointerEvents: "none", zIndex: 15 }}>
                <span style={{ fontSize: 7, fontFamily: "monospace", color: "rgba(180,80,130,0.5)", letterSpacing: 0.5, textTransform: "uppercase" }}>audio</span>
              </div>

              {/* Visual clips (image / video / pan) */}
              {clips.filter((c) => c.type !== "narration").map((clip, ci) => {
                const color = clip.type === "pan" ? PAN_CLIP_COLOR : CLIP_COLORS[ci % CLIP_COLORS.length];
                const selected = clip.id === selectedClipId;
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
                    onClick={(e) => { e.stopPropagation(); setSelectedClipId(clip.id); }}
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
                const selected = clip.id === selectedClipId;
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
                    onClick={(e) => { e.stopPropagation(); setSelectedClipId(clip.id); }}
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

              <div style={{ position: "absolute", left: playhead * pxPerSec, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none", zIndex: 10 }} />
            </div>
          </div>
        </div>
      </div>

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
