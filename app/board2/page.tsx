"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession, signIn } from "next-auth/react";

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
  type: "image" | "video" | "pan";
  name: string;
  sourceUrl: string;
  startTime: number;
  duration: number;
  boardX?: number;
  boardY?: number;
  boardW?: number;
  boardH?: number;
  holdFraction?: number;
};

type MediaItem = {
  id: string;
  name: string;
  type: "image" | "video";
  url: string;
  duration?: number;
};

type TimelineDrag = {
  kind: "move" | "resize-left" | "resize-right";
  clipId: string;
  origStartTime: number;
  origDuration: number;
  cursorOffsetSec: number;
};

type YtSearchResult = {
  id: string;
  title: string;
  channel: string;
  duration: string | number;
  thumbnail: string;
};
type YtModalView = "search" | "trim";
type YtTab = "paste" | "search";

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
const TRACK_H = 64;
const TIMELINE_H = 280;
const HANDLE_W = 6;
const BOARD_RESIZE_PX = 10;
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

function getVideoDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const vid = document.createElement("video");
    vid.src = url;
    vid.onloadedmetadata = () => resolve(isFinite(vid.duration) ? vid.duration : 5);
    vid.onerror = () => resolve(5);
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

function findFreeBoardPos(
  existing: Clip[],
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function Board2Page() {
  const { data: session } = useSession();

  const [clips, setClips] = useState<Clip[]>([]);
  const [mediaLibrary, setMediaLibrary] = useState<MediaItem[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [canvasAspect, setCanvasAspect] = useState<"16:9" | "9:16">("16:9");
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [timelineScroll, setTimelineScroll] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [boardZoom, setBoardZoom] = useState(0.18);
  const [boardPan, setBoardPan] = useState({ x: 20, y: 20 });
  const [toast, setToast] = useState<string | null>(null);
  const [cameraKeyframes, setCameraKeyframes] = useState<CameraKeyframe[]>([]);
  const [isSpaceDown, setIsSpaceDown] = useState(false);
  const [dividerTooltip, setDividerTooltip] = useState<{ label: string; x: number; y: number } | null>(null);
  const [keyframesOutOfDate, setKeyframesOutOfDate] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; timeSec: number } | null>(null);

  // ── YouTube modal ──
  const [ytModalOpen, setYtModalOpen] = useState(false);
  const [ytTab, setYtTab] = useState<YtTab>("paste");
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
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const videoCacheRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const exportCancelRef = useRef(false);
  const exportRafRef = useRef<number | null>(null);
  const isExportingRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraKeyframesRef = useRef<CameraKeyframe[]>([]);
  const pxPerSecRef = useRef(DEFAULT_PX_PER_SEC);
  const timelineScrollRef = useRef(0);
  const pendingScrollLeftRef = useRef<number | null>(null);
  const timelineDragRef = useRef<TimelineDrag | null>(null);
  const rafCallbackRef = useRef<FrameRequestCallback>(() => {});
  const dividerDragRef = useRef<{ clipId: string; innerStartPx: number; innerWidthPx: number } | null>(null);
  const videoHiddenContainerRef = useRef<HTMLDivElement>(null);
  const ytVideoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map()); // clip.id → HTMLVideoElement
  const ytBlobUrlsRef = useRef<Map<string, string>>(new Map()); // clip.id → blob URL for revocation
  const ytSliderTrackRef = useRef<HTMLDivElement>(null);
  const ytRangeRef = useRef({ start: 0, end: 30 });

  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { playheadRef.current = playhead; }, [playhead]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { canvasWRef.current = canvasW; canvasHRef.current = canvasH; }, [canvasW, canvasH]);
  useEffect(() => { boardZoomRef.current = boardZoom; }, [boardZoom]);
  useEffect(() => { boardPanRef.current = boardPan; }, [boardPan]);
  useEffect(() => { cameraKeyframesRef.current = cameraKeyframes; }, [cameraKeyframes]);
  useEffect(() => { pxPerSecRef.current = pxPerSec; }, [pxPerSec]);

  useEffect(() => {
    if (!toast) return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, [toast]);

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
    H: number
  ) => {
    ctx.fillStyle = "#f5ecd8";
    ctx.fillRect(0, 0, W, H);
    const cam = interpolateCameraKeyframes(currentCameraKeyframes, time);
    const sf = cam.boardZoom * W / BOARD_W;
    for (const clip of currentClips) {
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
        const vid = ytVideoElsRef.current.get(clip.id) ?? videoCacheRef.current.get(clip.sourceUrl);
        if (vid && vid.readyState >= 2) {
          ctx.drawImage(vid, sx - sw / 2, sy - sh / 2, sw, sh);
        }
      }
    }
    ctx.globalAlpha = 1;
  }, []);

  const drawFrame = useCallback((time: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderToCtx(ctx, time, clipsRef.current, cameraKeyframesRef.current, canvasWRef.current, canvasHRef.current);
  }, [renderToCtx]);

  // ─ RAF playback loop ──────────────────────────────────────────────────────

  const rafLoop = useCallback(() => {
    if (!isPlayingRef.current) return;
    const now = performance.now();
    if (lastRafTimeRef.current !== null) {
      const dt = (now - lastRafTimeRef.current) / 1000;
      const next = playheadRef.current + dt;
      const maxEnd = clipsRef.current.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
      if (next >= maxEnd) {
        playheadRef.current = maxEnd; setPlayhead(maxEnd); setIsPlaying(false);
        isPlayingRef.current = false;
        for (const vid of ytVideoElsRef.current.values()) vid.pause();
        drawFrame(maxEnd); return;
      }
      playheadRef.current = next; setPlayhead(next);
    }
    lastRafTimeRef.current = now;
    const t = playheadRef.current;
    // Manage YouTube video playback per frame
    for (const clip of clipsRef.current) {
      if (clip.type !== "video") continue;
      const vid = ytVideoElsRef.current.get(clip.id);
      if (!vid) continue;
      const isActive = t >= clip.startTime && t < clip.startTime + clip.duration;
      if (isActive) {
        if (vid.paused) { vid.currentTime = t - clip.startTime; vid.play().catch(() => {}); }
      } else {
        if (!vid.paused) vid.pause();
      }
    }
    drawFrame(t);
    rafIdRef.current = requestAnimationFrame(rafCallbackRef.current);
  }, [drawFrame]);

  useEffect(() => { rafCallbackRef.current = rafLoop; }, [rafLoop]);

  useEffect(() => {
    if (isPlaying) { lastRafTimeRef.current = null; rafIdRef.current = requestAnimationFrame(rafLoop); }
    else {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null;
      for (const vid of ytVideoElsRef.current.values()) vid.pause();
    }
    return () => { if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); };
  }, [isPlaying, rafLoop]);

  useEffect(() => { if (!isPlaying) drawFrame(playhead); }, [playhead, clips, canvasAspect, isPlaying, drawFrame]);

  useEffect(() => {
    if (isPlaying) return;
    for (const clip of clipsRef.current) {
      if (clip.type !== "video") continue;
      const vid = ytVideoElsRef.current.get(clip.id) ?? videoCacheRef.current.get(clip.sourceUrl);
      if (!vid) continue;
      const relTime = playhead - clip.startTime;
      if (relTime >= 0 && relTime <= clip.duration) vid.currentTime = relTime;
    }
  }, [playhead, isPlaying]);

  // ─ Media loading ──────────────────────────────────────────────────────────

  function loadMedia(url: string, type: "image" | "video") {
    if (type === "image") {
      if (!imgCacheRef.current.has(url)) {
        const img = new Image();
        img.onload = () => drawFrame(playheadRef.current);
        img.src = url;
        imgCacheRef.current.set(url, img);
      }
    } else {
      if (!videoCacheRef.current.has(url)) {
        const vid = document.createElement("video");
        vid.muted = true; vid.preload = "auto"; vid.src = url;
        videoCacheRef.current.set(url, vid);
      }
    }
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
      const vid = videoCacheRef.current.get(url);
      if (vid && vid.videoWidth > 0) {
        const scale = Math.min(1, 800 / vid.videoWidth, 600 / vid.videoHeight);
        return { w: Math.round(vid.videoWidth * scale), h: Math.round(vid.videoHeight * scale) };
      }
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
    setClips((prev) => {
      const endTime = prev.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
      const pos = findFreeBoardPos(prev, w, h, camX, camY);
      return [
        ...prev,
        {
          id: clipId, type: item.type, name: item.name, sourceUrl: item.url,
          startTime: endTime, duration: clipDuration,
          boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h,
        },
      ];
    });
    setSelectedClipId(clipId);
  }

  function deleteClip(clipId: string) {
    const vid = ytVideoElsRef.current.get(clipId);
    if (vid) {
      vid.pause();
      vid.src = "";
      if (videoHiddenContainerRef.current?.contains(vid)) videoHiddenContainerRef.current.removeChild(vid);
      ytVideoElsRef.current.delete(clipId);
    }
    const blobUrl = ytBlobUrlsRef.current.get(clipId);
    if (blobUrl) { URL.revokeObjectURL(blobUrl); ytBlobUrlsRef.current.delete(clipId); }
    setClips((prev) => prev.filter((c) => c.id !== clipId));
    setSelectedClipId((prev) => (prev === clipId ? null : prev));
  }

  function addPanClip(atTime?: number) {
    const id = generateId();
    const startTime = atTime ?? clipsRef.current.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const clip: Clip = { id, type: "pan", name: "Pan", sourceUrl: "", startTime, duration: 5, holdFraction: 0.5 };
    setClips((prev) => [...prev, clip]);
    setSelectedClipId(id);
    if (cameraKeyframesRef.current.length > 0) setKeyframesOutOfDate(true);
  }

  // ─ Media upload ───────────────────────────────────────────────────────────

  async function handleMediaUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const type: "image" | "video" = file.type.startsWith("video") ? "video" : "image";
      loadMedia(url, type);
      const duration = type === "video" ? await getVideoDuration(url) : undefined;
      const item: MediaItem = { id: generateId(), name: file.name, type, url, duration };
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

  async function handleYtConfirm() {
    if (!ytSelected) return;
    setYtLoading(true); setYtError("");
    try {
      const url = `https://www.youtube.com/watch?v=${ytSelected.id}`;
      const dlRes = await fetch("/api/ytdl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, start: ytStart, end: ytEnd }),
      });
      if (!dlRes.ok) {
        const err = await dlRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Download failed (${dlRes.status})`);
      }
      const blob = await dlRes.blob();
      const blobUrl = URL.createObjectURL(blob);
      const title = (ytSelected.title ?? "YouTube clip").slice(0, 40);
      const clipDuration = ytEnd - ytStart;
      const clipId = generateId();

      // Create video element keyed by clip ID, attach to hidden container
      const vid = document.createElement("video");
      vid.src = blobUrl;
      vid.muted = true;
      vid.preload = "auto";
      vid.playsInline = true;
      if (videoHiddenContainerRef.current) videoHiddenContainerRef.current.appendChild(vid);
      ytVideoElsRef.current.set(clipId, vid);
      ytBlobUrlsRef.current.set(clipId, blobUrl);

      // Wait for metadata to get natural dimensions
      const dims = await new Promise<{ w: number; h: number }>((resolve) => {
        const timer = setTimeout(() => resolve({ w: 800, h: 450 }), 3000);
        vid.addEventListener("loadedmetadata", () => {
          clearTimeout(timer);
          if (vid.videoWidth > 0 && vid.videoHeight > 0) {
            const scale = Math.min(1, 800 / vid.videoWidth, 600 / vid.videoHeight);
            resolve({ w: Math.round(vid.videoWidth * scale), h: Math.round(vid.videoHeight * scale) });
          } else {
            resolve({ w: 800, h: 450 });
          }
        }, { once: true });
      });

      const { camX, camY } = getVisibleBoardCenter();
      setClips((prev) => {
        const endTime = prev.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
        const pos = findFreeBoardPos(prev, dims.w, dims.h, camX, camY);
        return [...prev, {
          id: clipId, type: "video" as const, name: title, sourceUrl: blobUrl,
          startTime: endTime, duration: clipDuration,
          boardX: pos.boardX, boardY: pos.boardY, boardW: dims.w, boardH: dims.h,
        }];
      });
      setSelectedClipId(clipId);
      setYtModalOpen(false);
      setYtView("search"); setYtTab("paste"); setYtSelected(null);
      setYtResults([]); setYtQuery(""); setYtUrlInput("");
    } catch (e) {
      setYtError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setYtLoading(false);
    }
  }

  // ─ Board clip drag ────────────────────────────────────────────────────────

  function handleBoardClipPointerDown(e: React.PointerEvent, clip: Clip) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelectedClipId(clip.id);
    const startX = e.clientX, startY = e.clientY;
    const origX = clip.boardX!, origY = clip.boardY!;
    const onMove = (ev: PointerEvent) => {
      const zoom = boardZoomRef.current;
      setClips((prev) =>
        prev.map((c) =>
          c.id !== clip.id ? c : {
            ...c,
            boardX: Math.round(origX + (ev.clientX - startX) / zoom),
            boardY: Math.round(origY + (ev.clientY - startY) / zoom),
          }
        )
      );
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
    timelineDragRef.current = {
      kind, clipId: clip.id,
      origStartTime: clip.startTime, origDuration: clip.duration,
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
            return { ...c, startTime: newStart };
          }
          if (drag.kind === "resize-right") {
            const rawEnd = Math.max(drag.origStartTime + 0.1, cursorSec);
            const { snapped, target } = magneticSnap(rawEnd, snapTargets, threshold);
            const newEnd = target !== null ? Math.max(drag.origStartTime + 0.1, snapped) : rawEnd;
            return { ...c, duration: newEnd - drag.origStartTime };
          }
          // resize-left
          const rawStart = clamp(cursorSec, 0, drag.origStartTime + drag.origDuration - 0.1);
          const { snapped, target } = magneticSnap(rawStart, snapTargets, threshold);
          const newStart = target !== null
            ? clamp(snapped, 0, drag.origStartTime + drag.origDuration - 0.1)
            : rawStart;
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
    const startTime = Math.max(0, (e.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current);
    loadMedia(item.url, item.type);
    const { w, h } = getMediaDimensions(item.url, item.type);
    const { camX, camY } = getVisibleBoardCenter();
    const clipId = generateId();
    setClips((prev) => {
      const pos = findFreeBoardPos(prev, w, h, camX, camY);
      return [
        ...prev,
        {
          id: clipId, type: item.type, name: item.name, sourceUrl: item.url,
          startTime, duration: item.duration ?? (item.type === "video" ? 5 : 4),
          boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h,
        },
      ];
    });
    setSelectedClipId(clipId);
  }

  // ─ Play / pause ───────────────────────────────────────────────────────────

  function togglePlay() {
    if (isPlaying) { setIsPlaying(false); return; }
    const maxEnd = clips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const ph = playheadRef.current;
    if (ph >= maxEnd && maxEnd > 0) setPlayhead(0);
    // Pre-warm YouTube videos during this user gesture to unlock programmatic .play() later
    for (const clip of clipsRef.current) {
      if (clip.type !== "video") continue;
      const vid = ytVideoElsRef.current.get(clip.id);
      if (!vid || clip.startTime + clip.duration <= ph) continue;
      vid.currentTime = Math.max(0, ph - clip.startTime);
      vid.play().then(() => vid.pause()).catch(() => {});
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

  // ─ Export ─────────────────────────────────────────────────────────────────

  function cancelExport() { exportCancelRef.current = true; }

  async function startExport() {
    if (clips.length === 0) { alert("No clips to export"); return; }
    if (isPlayingRef.current) setIsPlaying(false);
    setIsExporting(true); isExportingRef.current = true; exportCancelRef.current = false; setExportProgress(0);
    const currentClips = clipsRef.current;
    const currentCameraKeyframes = cameraKeyframesRef.current;
    const totalDur = currentClips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const W = canvasWRef.current, H = canvasHRef.current;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = W; exportCanvas.height = H;
    const exportCtx = exportCanvas.getContext("2d")!;
    // Seed videos: clips starting at t=0 begin playing immediately; others wait at t=0
    for (const clip of currentClips) {
      if (clip.type !== "video") continue;
      const vid = ytVideoElsRef.current.get(clip.id) ?? videoCacheRef.current.get(clip.sourceUrl);
      if (!vid) continue;
      if (clip.startTime === 0) {
        vid.currentTime = 0;
        vid.play().catch(() => {});
      } else {
        vid.pause();
        vid.currentTime = 0;
      }
    }
    const canvasStream = exportCanvas.captureStream(EXPORT_FPS);
    const mimeType = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "video/webm";
    const recorder = new MediaRecorder(canvasStream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = mimeType === "video/mp4" ? "board2-export.mp4" : "board2-export.webm";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setIsExporting(false); isExportingRef.current = false; setExportProgress(0);
    };
    recorder.start(100);
    const exportWallStart = performance.now();
    function exportFrame() {
      if (exportCancelRef.current) {
        for (const vid of ytVideoElsRef.current.values()) vid.pause();
        for (const vid of videoCacheRef.current.values()) vid.pause();
        recorder.stop(); setIsExporting(false); isExportingRef.current = false; setExportProgress(0); return;
      }
      const elapsed = (performance.now() - exportWallStart) / 1000;
      if (elapsed >= totalDur) {
        for (const vid of ytVideoElsRef.current.values()) vid.pause();
        for (const vid of videoCacheRef.current.values()) vid.pause();
        recorder.stop(); return;
      }
      setExportProgress(elapsed / totalDur);
      // Manage video lifecycle: seek+play once on activation, pause when inactive, let it run
      for (const clip of currentClips) {
        if (clip.type !== "video") continue;
        const vid = ytVideoElsRef.current.get(clip.id) ?? videoCacheRef.current.get(clip.sourceUrl);
        if (!vid) continue;
        const isActive = elapsed >= clip.startTime && elapsed < clip.startTime + clip.duration;
        if (isActive && vid.paused) {
          vid.currentTime = elapsed - clip.startTime;
          vid.play().catch(() => {});
        } else if (!isActive && !vid.paused) {
          vid.pause();
        }
      }
      renderToCtx(exportCtx, elapsed, currentClips, currentCameraKeyframes, W, H);
      exportRafRef.current = requestAnimationFrame(exportFrame);
    }
    exportRafRef.current = requestAnimationFrame(exportFrame);
  }

  // ─ Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        isSpaceDownRef.current = true;
        setIsSpaceDown(true);
        if (boardContainerRef.current) boardContainerRef.current.style.cursor = "grab";
      }
      if (e.code === "Delete" || e.code === "Backspace") {
        if (selectedClipId) deleteClip(selectedClipId);
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
          <a href="/board" style={navLinkStyle}>Board</a>
          <span style={{ ...navLinkStyle, color: "#2a2a2a", fontWeight: 700 }}>Board 2.0</span>
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
              onClick={() => { setYtModalOpen(true); setYtView("search"); setYtTab("paste"); setYtError(""); }}
              style={{ ...sketchButton, fontSize: 11, padding: "6px 10px", fontWeight: 700 }}
            >
              ▶ Add YouTube
            </button>
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
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) setSelectedClipId(null);
                }}
              >
                {/* eslint-disable-next-line react-hooks/refs */}
                {clips.filter((c) => c.boardX !== undefined).map((clip) => {
                  const isSel = clip.id === selectedClipId;
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
              </div>

              {/* Empty state */}
              {clips.filter((c) => c.boardX !== undefined).length === 0 && (
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

            {!selectedClip ? (
              <p style={{ fontSize: 10, color: "#9a9a9a", fontFamily: "monospace", lineHeight: 1.6, margin: 0 }}>
                Select a clip to view its properties.
              </p>
            ) : (
              <>
                <div style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selectedClip.type === "pan" ? "⟷ Pan clip" : selectedClip.name}
                </div>
                {selectedClip.type === "pan" && (
                  <div style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", background: PAN_CLIP_COLOR, padding: "3px 6px", border: "1px solid rgba(42,42,42,0.2)" }}>
                    Sweeps across all board images
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

                {selectedClip.boardX !== undefined && (
                  <div>
                    <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Board Position</div>
                    <div style={{ fontFamily: "monospace", fontSize: 10, color: "#6a6a6a", lineHeight: 1.8 }}>
                      <div>X: {Math.round(selectedClip.boardX)} &nbsp; Y: {Math.round(selectedClip.boardY!)}</div>
                      <div>W: {Math.round(selectedClip.boardW!)} &nbsp; H: {Math.round(selectedClip.boardH!)}</div>
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
            <span style={{ fontSize: 9, fontFamily: "monospace", color: "#bbb" }}>cmd+scroll=zoom · space+drag=pan board · ⌫=delete clip</span>
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

          {/* Track */}
          <div
            ref={scrollerRef}
            style={{ flex: 1, minHeight: TRACK_H + 12, position: "relative", overflowX: "auto", overflowY: "hidden" }}
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
              if ((e.target as HTMLElement).closest("[data-clipblock]")) return;
              e.preventDefault();
              const rect = scrollerRef.current!.getBoundingClientRect();
              const timeSec = Math.max(0, (e.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current);
              setContextMenu({ x: e.clientX, y: e.clientY, timeSec });
            }}
          >
            <div style={{ position: "relative", width: timelineWidth, minHeight: TRACK_H, height: "100%" }}>
              <div style={{ position: "absolute", inset: 0, background: "rgba(100,130,180,0.05)", borderTop: "1px solid rgba(42,42,42,0.08)" }} />

              {clips.map((clip, ci) => {
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
                return (
                  <div
                    key={clip.id}
                    data-clipblock
                    style={{
                      position: "absolute",
                      left: clip.startTime * pxPerSec,
                      top: 4,
                      width: clipPx,
                      height: TRACK_H - 8,
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

              <div style={{ position: "absolute", left: playhead * pxPerSec, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none", zIndex: 10 }} />
            </div>
          </div>
        </div>
      </div>

      {/* Timeline context menu */}
      {contextMenu && (
        <div
          style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 9998, background: "#fffdf5", border: "1.5px solid #2a2a2a", boxShadow: "2px 2px 0 #2a2a2a", fontFamily: "monospace", minWidth: 130 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            onClick={() => { addPanClip(contextMenu.timeSec); setContextMenu(null); }}
            style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, borderBottom: "1px solid rgba(42,42,42,0.12)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = PAN_CLIP_COLOR)}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            ⟷ Add pan here
          </div>
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
                <button onClick={handleYtConfirm} disabled={ytLoading}
                  style={{ ...miniButton, marginLeft: "auto", padding: "6px 18px", fontSize: 12, fontWeight: 700, background: "#c8f135", borderColor: "#2a2a2a", opacity: ytLoading ? 0.5 : 1 }}>
                  {ytLoading ? "downloading…" : "Add to board"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#2a2a2a", color: "#c8f135", fontFamily: "monospace", fontSize: 11, padding: "8px 16px", border: "1.5px solid #c8f135", boxShadow: "2px 2px 0 #c8f135", zIndex: 9999, pointerEvents: "none", whiteSpace: "nowrap" }}>
          {toast}
        </div>
      )}
    </div>
  );
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

