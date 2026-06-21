"use client";

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { useSession, signIn } from "next-auth/react";
import {
  type Clip, type ClipType, type CurvePoint, type AudioEntry,
  SNAP, MIN_DURATION, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE, MASTER_PLAYBACK_RATE,
  MAX_EXPORT_DURATION, DEFAULT_CURVE, CLIP_COLORS, IMAGE_DEFAULT_DURATION,
  TEXT_DEFAULT_DURATION, TEXT_SOURCE_DURATION, DEFAULT_CROP_ZOOM, DEFAULT_CROP_X,
  DEFAULT_CROP_Y, DEFAULT_CHROMA_SIMILARITY, DEFAULT_CHROMA_SMOOTHNESS,
  DEFAULT_CHROMA_AMOUNT, COUNTDOWN_COLOR,
  snapTo, clamp, clipsOverlap, findFreeLayer, findFreeLayerOrNull,
  magneticSnap, allOtherClipEdges,
  isVisualClip, hasClipAudio,
  clipPlaybackRate, mediaPlaybackRate, clipSourceSpan, clipSourceTimeAtTimeline,
  setElementPlaybackRate, waveformValueAtSourceSec,
  formatTime, formatDuration, getMediaDuration, generateWaveform,
  parseDurationSec, parseTimestampSec, formatTimestamp,
  interpolateVolume, drawMaybeKeyedMedia, drawContainedRect,
  drawTextClip, drawCountdownClip,
} from "@/lib/timeline-core";

// ─── Board constants ──────────────────────────────────────────────────────────

const BOARD_W = 4000;
const BOARD_H = 3000;
const VIEWPORT_W = 800;
const VIEWPORT_H = 600;
const CLIP_DEFAULT_W = 300;
const CLIP_DEFAULT_H = 200;
const BOARD_BG = "#f5ecd8";
const BOARD_EDGE_MARGIN = 200;
const BOARD_CLIP_PAD = 30;

const DEFAULT_PX_PER_SEC = 100;
const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 500;
const RULER_H = 30;
const LAYER_H = 56;
const INITIAL_LAYER_COUNT = 5;
const HANDLE_W = 6;
const MAGNETIC_SNAP_PX = 10;
const CURVE_H = 12;
const LAYER_BG = ["rgba(245,236,216,0.7)", "rgba(228,218,195,0.5)"];

// ─── Board-specific types ─────────────────────────────────────────────────────

type BoardClip = Clip & {
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  cameraZoomTarget: number;
  holdFraction: number;
};

type BoardSnapshot = {
  clips: BoardClip[];
  selectedClipId: string | null;
  layerCount: number;
  mutedLayers: Record<number, boolean>;
};

type Ghost = {
  clipId: string;
  startTime: number;
  durationSec: number;
  layer: number;
  type: ClipType;
} | null;

type DragInfo = {
  kind: "move" | "resize-left" | "resize-right";
  clipId: string;
  origStartTime: number;
  origDuration: number;
  origLayer: number;
  origTrimStart: number;
  startMouseX: number;
  startMouseY: number;
  validStartTime: number;
  validDuration: number;
  validLayer: number;
  validTrimStart: number;
};

type YtSearchResult = {
  id: string;
  title: string;
  channel: string;
  duration: string | number;
  thumbnail: string;
};
type YtModalView = "search" | "trim";

type LibraryVideo = {
  id: string;
  email: string;
  youtube_url: string;
  youtube_video_id: string;
  title: string;
  thumbnail_url: string;
  duration_seconds: number;
  created_at: string;
};

// ─── Camera keyframe helpers ──────────────────────────────────────────────────

function easeInOut(t: number): number { return t * t * (3 - 2 * t); }

function defaultCameraZoom(clipW: number, clipH: number): number {
  return clamp(Math.min((VIEWPORT_W * 0.7) / clipW, (VIEWPORT_H * 0.7) / clipH), 0.5, 5.0);
}

function computeFrameAllTarget(clips: BoardClip[]): { x: number; y: number; zoom: number } {
  const visuals = clips.filter(isVisualClip);
  if (visuals.length === 0) return { x: BOARD_W / 2, y: BOARD_H / 2, zoom: 1 };
  const pad = 100;
  const minX = Math.min(...visuals.map((c) => c.boardX)) - pad;
  const minY = Math.min(...visuals.map((c) => c.boardY)) - pad;
  const maxX = Math.max(...visuals.map((c) => c.boardX + c.boardW)) + pad;
  const maxY = Math.max(...visuals.map((c) => c.boardY + c.boardH)) + pad;
  const zoom = Math.min(VIEWPORT_W / (maxX - minX), VIEWPORT_H / (maxY - minY), 4);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
}

function computeCameraAtTime(atSec: number, clips: BoardClip[]): { x: number; y: number; zoom: number; label: string } | null {
  const sorted = clips.filter(isVisualClip).sort((a, b) => a.startTime - b.startTime);
  if (sorted.length === 0) return null;

  const frameAll = computeFrameAllTarget(clips);
  const first = sorted[0];

  if (atSec <= first.startTime) {
    return { x: first.boardX + first.boardW / 2, y: first.boardY + first.boardH / 2, zoom: first.cameraZoomTarget, label: `Hold: ${first.name}` };
  }

  for (let i = 0; i < sorted.length; i++) {
    const clip = sorted[i];
    const clipEnd = clip.startTime + clip.durationSec;
    if (atSec < clipEnd) {
      const clipX = clip.boardX + clip.boardW / 2;
      const clipY = clip.boardY + clip.boardH / 2;
      const holdEnd = clip.startTime + clip.durationSec * clip.holdFraction;
      if (atSec <= holdEnd) {
        return { x: clipX, y: clipY, zoom: clip.cameraZoomTarget, label: `Hold: ${clip.name}` };
      }
      const next = sorted[i + 1];
      const nextX = next ? next.boardX + next.boardW / 2 : frameAll.x;
      const nextY = next ? next.boardY + next.boardH / 2 : frameAll.y;
      const nextZoom = next ? next.cameraZoomTarget : frameAll.zoom;
      const nextName = next ? next.name : "Frame All";
      const transSpan = clipEnd - holdEnd;
      const t = easeInOut(transSpan > 0 ? clamp((atSec - holdEnd) / transSpan, 0, 1) : 1);
      return {
        x: clipX + (nextX - clipX) * t,
        y: clipY + (nextY - clipY) * t,
        zoom: clip.cameraZoomTarget + (nextZoom - clip.cameraZoomTarget) * t,
        label: `Transition → ${nextName}`,
      };
    }
  }

  return { x: frameAll.x, y: frameAll.y, zoom: frameAll.zoom, label: "Frame All" };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function layerBg(layer: number): string {
  return LAYER_BG[(layer - 1) % LAYER_BG.length] ?? LAYER_BG[0];
}

function findFreeBoardPos(
  existing: BoardClip[], clipW: number, clipH: number,
  camX: number = BOARD_W / 2, camY: number = BOARD_H / 2
): { boardX: number; boardY: number } {
  const visuals = existing.filter(isVisualClip);
  const overlaps = (bx: number, by: number, pad: number) =>
    visuals.some((c) => !(bx + clipW + pad < c.boardX || bx > c.boardX + c.boardW + pad ||
      by + clipH + pad < c.boardY || by > c.boardY + c.boardH + pad));
  // Candidate centered on clipW/H so it appears centered; top-left derived from that
  const candidate = (rx: number, ry: number): { boardX: number; boardY: number } => {
    const bx = clamp(camX - clipW / 2 + rx, 0, BOARD_W - clipW);
    const by = clamp(camY - clipH / 2 + ry, 0, BOARD_H - clipH);
    return { boardX: bx, boardY: by };
  };
  // Phase 1: near camera (viewport-sized radius), with padding
  for (let i = 0; i < 50; i++) {
    const { boardX: bx, boardY: by } = candidate(
      (Math.random() - 0.5) * VIEWPORT_W,
      (Math.random() - 0.5) * VIEWPORT_H,
    );
    if (!overlaps(bx, by, BOARD_CLIP_PAD)) return { boardX: bx, boardY: by };
  }
  // Phase 2: near camera, no padding
  for (let i = 0; i < 50; i++) {
    const { boardX: bx, boardY: by } = candidate(
      (Math.random() - 0.5) * VIEWPORT_W,
      (Math.random() - 0.5) * VIEWPORT_H,
    );
    if (!overlaps(bx, by, 0)) return { boardX: bx, boardY: by };
  }
  // Phase 3: expanded radius (2× viewport), no padding
  for (let i = 0; i < 50; i++) {
    const { boardX: bx, boardY: by } = candidate(
      (Math.random() - 0.5) * VIEWPORT_W * 2,
      (Math.random() - 0.5) * VIEWPORT_H * 2,
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
  if (last) return { boardX: Math.min(last.boardX + 20, BOARD_W - clipW), boardY: Math.min(last.boardY + 20, BOARD_H - clipH) };
  return { boardX: clamp(camX - clipW / 2, 0, BOARD_W - clipW), boardY: clamp(camY - clipH / 2, 0, BOARD_H - clipH) };
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function BoardPage() {
  const { data: session, status } = useSession();
  const [config, setConfig] = useState<{ railwayUrl: string; railwayPassword: string } | null>(null);

  const [clips, setClips] = useState<BoardClip[]>([]);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [recError, setRecError] = useState("");
  const [recGrowingBar, setRecGrowingBar] = useState<{ startSec: number; layer: number; elapsedSec: number } | null>(null);
  const [ghost, setGhost] = useState<Ghost>(null);
  const [snapGuideSec, setSnapGuideSec] = useState<number | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [layerCount, setLayerCount] = useState(INITIAL_LAYER_COUNT);
  const [mutedLayers, setMutedLayers] = useState<Record<number, boolean>>({});
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportDurationSec, setExportDurationSec] = useState(0);

  // YouTube modal
  const [ytModalOpen, setYtModalOpen] = useState(false);
  const [ytQuery, setYtQuery] = useState("");
  const [ytResults, setYtResults] = useState<YtSearchResult[]>([]);
  const [ytView, setYtView] = useState<YtModalView>("search");
  const [ytSelected, setYtSelected] = useState<YtSearchResult | null>(null);
  const [ytStart, setYtStart] = useState(0);
  const [ytStartInput, setYtStartInput] = useState("0:00");
  const [ytEnd, setYtEnd] = useState(30);
  const [ytEndInput, setYtEndInput] = useState("0:30");
  const [ytError, setYtError] = useState("");
  const [ytLoading, setYtLoading] = useState(false);
  const [ytShortsOnly, setYtShortsOnly] = useState(true);
  const ytSliderTrackRef = useRef<HTMLDivElement>(null);

  // Library
  const [savedVideosOpen, setSavedVideosOpen] = useState(false);
  const [savedVideos, setSavedVideos] = useState<LibraryVideo[]>([]);
  const [savedVideosLoading, setSavedVideosLoading] = useState(false);
  const [savedVideosError, setSavedVideosError] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs
  const clipsRef = useRef<BoardClip[]>([]);
  const selectedClipIdRef = useRef<string | null>(null);
  const playheadDraggingRef = useRef(false);
  const dragRef = useRef<DragInfo | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recSecondsRef = useRef(0);
  const mediaUploadRef = useRef<HTMLInputElement | null>(null);
  const pxPerSecRef = useRef(DEFAULT_PX_PER_SEC);
  const pendingScrollLeftRef = useRef<number | null>(null);
  const exportCancelRef = useRef(false);
  const exportRafRef = useRef<number | null>(null);
  const isExportingRef = useRef(false);
  const undoStackRef = useRef<BoardSnapshot[]>([]);
  const layerCountRef = useRef(INITIAL_LAYER_COUNT);
  const mutedLayersRef = useRef<Record<number, boolean>>({});
  const isRecordingNarrationRef = useRef(false);
  const recStartSecRef = useRef(0);
  const recLayerRef = useRef(1);
  const recNarrationRafRef = useRef<number | null>(null);
  const recNarrationStartWallRef = useRef(0);
  const ytRangeRef = useRef({ start: 0, end: 30 });

  // Camera
  const [cameraX, setCameraX] = useState(BOARD_W / 2);
  const [cameraY, setCameraY] = useState(BOARD_H / 2);
  const [boardZoom, setBoardZoom] = useState(1);
  const cameraXRef = useRef(BOARD_W / 2);
  const cameraYRef = useRef(BOARD_H / 2);
  const boardZoomRef = useRef(1);

  // Board interactions
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardDragRef = useRef<{ clipId: string; offsetX: number; offsetY: number } | null>(null);
  const holdDragRef = useRef<{ clipId: string; startMouseX: number; startFraction: number } | null>(null);
  const panDragRef = useRef<{ startMouseX: number; startMouseY: number; startCamX: number; startCamY: number } | null>(null);
  const spaceHeldRef = useRef(false);
  const mouseOverBoardRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [boardDraggingClipId, setBoardDraggingClipId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [cameraStatusLabel, setCameraStatusLabel] = useState("");

  // Playback
  const isPlayingRef = useRef(false);
  const playheadSecRef = useRef(0);
  const playStartWallRef = useRef(0);
  const playStartHeadRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Audio
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeAudioRef = useRef<Map<string, AudioEntry>>(new Map());

  // Board canvas
  const boardCanvasRef = useRef<HTMLCanvasElement>(null);
  const boardRafRef = useRef<number | null>(null);
  // Media elements for board rendering
  const boardVideoEls = useRef<Map<string, HTMLVideoElement>>(new Map());
  const boardImageEls = useRef<Map<string, HTMLImageElement>>(new Map());

  // Sync refs
  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { selectedClipIdRef.current = selectedClipId; }, [selectedClipId]);
  useEffect(() => { playheadSecRef.current = playheadSec; }, [playheadSec]);
  useEffect(() => { recSecondsRef.current = recSeconds; }, [recSeconds]);
  useEffect(() => { layerCountRef.current = layerCount; }, [layerCount]);
  useEffect(() => { mutedLayersRef.current = mutedLayers; }, [mutedLayers]);
  useEffect(() => { pxPerSecRef.current = pxPerSec; }, [pxPerSec]);
  useEffect(() => { cameraXRef.current = cameraX; }, [cameraX]);
  useEffect(() => { cameraYRef.current = cameraY; }, [cameraY]);
  useEffect(() => { boardZoomRef.current = boardZoom; }, [boardZoom]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || pendingScrollLeftRef.current === null) return;
    el.scrollLeft = pendingScrollLeftRef.current;
    pendingScrollLeftRef.current = null;
  });

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  useEffect(() => {
    if (!session?.user?.email) return;
    fetch("/api/config").then((r) => r.json()).then((d) => setConfig(d)).catch(() => {});
  }, [session?.user?.email]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + el!.scrollLeft;
      const cursorTimeSec = cursorX / pxPerSecRef.current;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newPxPerSec = clamp(pxPerSecRef.current * factor, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
      pendingScrollLeftRef.current = Math.max(0, cursorTimeSec * newPxPerSec - (e.clientX - rect.left));
      pxPerSecRef.current = newPxPerSec;
      setPxPerSec(newPxPerSec);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (!spaceHeldRef.current) { spaceHeldRef.current = true; setSpaceHeld(true); }
        // Only play/pause when cursor is not over the board (board uses space for pan)
        if (!mouseOverBoardRef.current) {
          if (isRecordingNarrationRef.current) { stopRecording(); return; }
          if (isPlayingRef.current) { pausePlayback(); } else { startPlayback(); }
        }
        return;
      }
      if ((e.code === "Backspace" || e.code === "Delete") && selectedClipIdRef.current) {
        e.preventDefault();
        pushUndoSnapshot();
        setClips((prev) => prev.filter((c) => c.id !== selectedClipIdRef.current));
        setSelectedClipId(null);
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undoLastEdit();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") { spaceHeldRef.current = false; setSpaceHeld(false); }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      pausePlayback();
      if (exportRafRef.current !== null) cancelAnimationFrame(exportRafRef.current);
      if (boardRafRef.current !== null) cancelAnimationFrame(boardRafRef.current);
      audioCtxRef.current?.close().catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Board canvas rendering ─────────────────────────────────────────────────

  function drawBoardFrame(atSec: number, currentClips: BoardClip[]) {
    const canvas = boardCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cW = canvas.width;
    const cH = canvas.height;
    const zoom = boardZoomRef.current;
    const scaleX = (cW / VIEWPORT_W) * zoom;
    const scaleY = (cH / VIEWPORT_H) * zoom;
    const camLeft = cameraXRef.current - VIEWPORT_W / (2 * zoom);
    const camTop = cameraYRef.current - VIEWPORT_H / (2 * zoom);

    ctx.fillStyle = BOARD_BG;
    ctx.fillRect(0, 0, cW, cH);

    // Draw all visual clips bottom-layer-first (higher layer number = further back)
    const visClips = currentClips
      .filter((c) => isVisualClip(c))
      .sort((a, b) => b.layer - a.layer);

    for (const clip of visClips) {
      const cx = (clip.boardX - camLeft) * scaleX;
      const cy = (clip.boardY - camTop) * scaleY;
      const cw = clip.boardW * scaleX;
      const ch = clip.boardH * scaleY;

      // Skip clips completely outside viewport
      if (cx + cw < 0 || cx > cW || cy + ch < 0 || cy > cH) continue;

      if (clip.type === "text") {
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(cx, cy, cw, ch);
        drawTextClip(ctx, clip, cx, cy, cw, ch, cH);
      } else if (clip.type === "countdown") {
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(cx, cy, cw, ch);
        drawCountdownClip(ctx, clip, cx, cy, cw, ch, cH, atSec - clip.startTime);
      } else {
        const vidEl = boardVideoEls.current.get(clip.id);
        const imgEl = boardImageEls.current.get(clip.id);
        const mediaEl = vidEl ?? imgEl ?? null;
        if (mediaEl) {
          const mW = mediaEl instanceof HTMLVideoElement ? mediaEl.videoWidth : (mediaEl as HTMLImageElement).naturalWidth;
          const mH = mediaEl instanceof HTMLVideoElement ? mediaEl.videoHeight : (mediaEl as HTMLImageElement).naturalHeight;
          if (mW > 0 && mH > 0) {
            const rect = drawContainedRect(mW, mH, cx, cy, cw, ch);
            drawMaybeKeyedMedia(ctx, mediaEl, rect.x, rect.y, rect.w, rect.h, clip);
          } else {
            ctx.fillStyle = CLIP_COLORS[clip.type];
            ctx.fillRect(cx, cy, cw, ch);
          }
        } else {
          ctx.fillStyle = CLIP_COLORS[clip.type];
          ctx.fillRect(cx, cy, cw, ch);
        }
      }

      // Simple border
      ctx.strokeStyle = "#2a2a2a";
      ctx.lineWidth = 2;
      ctx.strokeRect(cx, cy, cw, ch);

      // Red tint when dragged clip overlaps another
      if (boardDragRef.current?.clipId === clip.id) {
        const isOverlapping = currentClips.some((other) =>
          other.id !== clip.id && isVisualClip(other) &&
          !(clip.boardX + clip.boardW < other.boardX || clip.boardX > other.boardX + other.boardW ||
            clip.boardY + clip.boardH < other.boardY || clip.boardY > other.boardY + other.boardH)
        );
        if (isOverlapping) {
          ctx.fillStyle = "rgba(255,40,40,0.3)";
          ctx.fillRect(cx, cy, cw, ch);
          ctx.strokeStyle = "#ff2828";
          ctx.lineWidth = 3;
          ctx.strokeRect(cx, cy, cw, ch);
        }
      }

      // Clip name overlay
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(cx, cy, cw, 18);
      ctx.fillStyle = "#fffdf5";
      ctx.font = "700 10px 'Courier New', monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(clip.name.slice(0, 30), cx + 4, cy + 9, cw - 8);
    }
  }

  // Start board preview RAF loop
  useEffect(() => {
    function tick() {
      drawBoardFrame(playheadSecRef.current, clipsRef.current);
      boardRafRef.current = requestAnimationFrame(tick);
    }
    boardRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (boardRafRef.current !== null) cancelAnimationFrame(boardRafRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manage video/image elements for board rendering
  useEffect(() => {
    const existing = new Set(boardVideoEls.current.keys());
    for (const clip of clips) {
      if (clip.type === "video" && !boardVideoEls.current.has(clip.id)) {
        const vid = document.createElement("video");
        vid.src = clip.blobUrl;
        vid.muted = true;
        vid.preload = "auto";
        setElementPlaybackRate(vid, clip);
        const seekOnLoad = () => {
          const atSec = playheadSecRef.current;
          if (atSec >= clip.startTime && atSec < clip.startTime + clip.durationSec) {
            vid.currentTime = clipSourceTimeAtTimeline(clip, atSec);
          }
        };
        if (vid.readyState >= 1) { seekOnLoad(); } else { vid.addEventListener("loadedmetadata", seekOnLoad, { once: true }); }
        vid.load();
        boardVideoEls.current.set(clip.id, vid);
      }
      if (clip.type === "image" && !boardImageEls.current.has(clip.id)) {
        const img = new Image();
        img.src = clip.blobUrl;
        boardImageEls.current.set(clip.id, img);
      }
      existing.delete(clip.id);
    }
    // Remove stale elements
    for (const id of existing) {
      boardVideoEls.current.delete(id);
      boardImageEls.current.delete(id);
    }
  }, [clips]);

  // ─── Undo ───────────────────────────────────────────────────────────────────

  function cloneClip(clip: BoardClip): BoardClip {
    return { ...clip, transform: { ...clip.transform }, volumeCurve: clip.volumeCurve.map((p) => ({ ...p })) };
  }

  function pushUndoSnapshot() {
    undoStackRef.current.push({
      clips: clipsRef.current.map(cloneClip),
      selectedClipId: selectedClipIdRef.current,
      layerCount: layerCountRef.current,
      mutedLayers: { ...mutedLayersRef.current },
    });
    if (undoStackRef.current.length > 80) undoStackRef.current.shift();
  }

  function undoLastEdit() {
    const snap = undoStackRef.current.pop();
    if (!snap) return;
    if (isPlayingRef.current) pausePlayback();
    setGhost(null);
    dragRef.current = null;
    const restored = snap.clips.map(cloneClip);
    clipsRef.current = restored;
    selectedClipIdRef.current = snap.selectedClipId;
    layerCountRef.current = snap.layerCount;
    mutedLayersRef.current = { ...snap.mutedLayers };
    setClips(restored);
    setSelectedClipId(snap.selectedClipId);
    setLayerCount(snap.layerCount);
    setMutedLayers({ ...snap.mutedLayers });
  }

  // ─── Layer helpers ──────────────────────────────────────────────────────────

  function ensureLayerCount(nextLayer: number) {
    if (nextLayer <= layerCountRef.current) return;
    layerCountRef.current = nextLayer;
    setLayerCount(nextLayer);
  }

  function isLayerMuted(layer: number): boolean {
    return !!mutedLayersRef.current[layer];
  }

  function toggleLayerMute(layer: number) {
    pushUndoSnapshot();
    const next = { ...mutedLayersRef.current, [layer]: !mutedLayersRef.current[layer] };
    mutedLayersRef.current = next;
    setMutedLayers(next);
    if (isPlayingRef.current) startAudioAt(playheadSecRef.current, clipsRef.current);
  }

  function addLayer() {
    pushUndoSnapshot();
    const next = layerCountRef.current + 1;
    layerCountRef.current = next;
    setLayerCount(next);
  }

  // ─── Audio ──────────────────────────────────────────────────────────────────

  function getAudioCtx(): AudioContext {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  }

  function stopAllAudio() {
    activeAudioRef.current.forEach((entry) => {
      if (entry.kind === "element") {
        entry.elem.pause();
        try { entry.source.disconnect(); } catch {}
        try { entry.gainNode.disconnect(); } catch {}
      } else {
        try { entry.bufNode.stop(); } catch {}
        try { entry.bufNode.disconnect(); } catch {}
        try { entry.gainNode.disconnect(); } catch {}
      }
    });
    activeAudioRef.current.clear();
  }

  function spawnClipAudio(clip: BoardClip, clipOffset: number, ctx: AudioContext, extraDest?: AudioNode) {
    const sourceOffset = clip.trimStart + clipOffset * clipPlaybackRate(clip);
    const gainNode = ctx.createGain();
    gainNode.gain.value = isRecordingNarrationRef.current ? 0 : interpolateVolume(clip.volumeCurve, clipOffset);
    gainNode.connect(ctx.destination);
    if (extraDest) gainNode.connect(extraDest);

    if (clip.type === "audio") {
      fetch(clip.blobUrl)
        .then((r) => r.arrayBuffer())
        .then((ab) => ctx.decodeAudioData(ab))
        .then((buffer) => {
          if (!isPlayingRef.current && !isExportingRef.current) return;
          if (activeAudioRef.current.has(clip.id)) return;
          const bufNode = ctx.createBufferSource();
          bufNode.buffer = buffer;
          bufNode.playbackRate.value = mediaPlaybackRate(clip);
          bufNode.connect(gainNode);
          const safeOffset = Math.min(sourceOffset, buffer.duration - 0.01);
          bufNode.start(0, Math.max(0, safeOffset));
          activeAudioRef.current.set(clip.id, { kind: "buffer", bufNode, gainNode });
        }).catch(() => {});
      return;
    }

    const elem = document.createElement("video");
    elem.src = clip.blobUrl;
    elem.preload = "auto";
    setElementPlaybackRate(elem, clip);
    try {
      const source = ctx.createMediaElementSource(elem);
      source.connect(gainNode);
      const play = () => {
        setElementPlaybackRate(elem, clip);
        elem.currentTime = sourceOffset;
        elem.play().catch(() => {});
      };
      if (elem.readyState >= 2) { play(); } else { elem.addEventListener("canplay", play, { once: true }); }
      elem.load();
      activeAudioRef.current.set(clip.id, { kind: "element", elem, source, gainNode });
    } catch {}
  }

  function startAudioAt(atSec: number, currentClips: BoardClip[], extraDest?: AudioNode) {
    stopAllAudio();
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    currentClips.forEach((clip) => {
      if (!hasClipAudio(clip)) return;
      if (clip.muted || isLayerMuted(clip.layer)) return;
      if (atSec < clip.startTime || atSec >= clip.startTime + clip.durationSec) return;
      spawnClipAudio(clip, atSec - clip.startTime, ctx, extraDest);
    });
  }

  function tickAudio(atSec: number, currentClips: BoardClip[], extraDest?: AudioNode) {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    activeAudioRef.current.forEach((entry, clipId) => {
      const clip = currentClips.find((c) => c.id === clipId);
      if (!clip || clip.muted || isLayerMuted(clip.layer) || atSec < clip.startTime || atSec >= clip.startTime + clip.durationSec) {
        if (entry.kind === "element") {
          entry.elem.pause();
          try { entry.source.disconnect(); } catch {}
          try { entry.gainNode.disconnect(); } catch {}
        } else {
          try { entry.bufNode.stop(); } catch {}
          try { entry.bufNode.disconnect(); } catch {}
          try { entry.gainNode.disconnect(); } catch {}
        }
        activeAudioRef.current.delete(clipId);
      } else {
        entry.gainNode.gain.value = isRecordingNarrationRef.current ? 0 : interpolateVolume(clip.volumeCurve, atSec - clip.startTime);
        if (entry.kind === "element") setElementPlaybackRate(entry.elem, clip);
        else entry.bufNode.playbackRate.value = mediaPlaybackRate(clip);
      }
    });
    currentClips.forEach((clip) => {
      if (!hasClipAudio(clip) || clip.muted || isLayerMuted(clip.layer)) return;
      if (activeAudioRef.current.has(clip.id)) return;
      if (atSec < clip.startTime || atSec >= clip.startTime + clip.durationSec) return;
      spawnClipAudio(clip, atSec - clip.startTime, ctx, extraDest);
    });
  }

  // ─── Playback ───────────────────────────────────────────────────────────────

  function startPlayback() {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const currentClips = clipsRef.current;
    const total = currentClips.length > 0 ? Math.max(...currentClips.map((c) => c.startTime + c.durationSec)) : 10;
    let startHead = playheadSecRef.current;
    if (startHead >= total) startHead = 0;
    playStartWallRef.current = performance.now();
    playStartHeadRef.current = startHead;
    isPlayingRef.current = true;
    setIsPlaying(true);
    setPlayheadSec(startHead);
    playheadSecRef.current = startHead;
    startAudioAt(startHead, currentClips);
    startBoardVideosAt(startHead, currentClips);

    function tick() {
      if (!isPlayingRef.current) return;
      const elapsed = (performance.now() - playStartWallRef.current) / 1000;
      const newHead = playStartHeadRef.current + elapsed;
      const clips2 = clipsRef.current;
      const total2 = clips2.length > 0 ? Math.max(...clips2.map((c) => c.startTime + c.durationSec)) : 10;
      if (newHead >= total2) {
        setPlayheadSec(total2);
        playheadSecRef.current = total2;
        isPlayingRef.current = false;
        setIsPlaying(false);
        if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        stopAllAudio();
        return;
      }
      setPlayheadSec(newHead);
      playheadSecRef.current = newHead;
      tickAudio(newHead, clips2);
      tickBoardVideoPlayback(newHead, clips2);
      applyKeyframeCameraAt(newHead, clips2);
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function pausePlayback() {
    isPlayingRef.current = false;
    setIsPlaying(false);
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    stopAllAudio();
    pauseAllBoardVideos();
  }

  function stopAndRewind() {
    pausePlayback();
    setPlayheadSec(0);
    playheadSecRef.current = 0;
    applyKeyframeCameraAt(0, clipsRef.current);
  }

  function seekTo(newSec: number) {
    const total = clipsRef.current.length > 0 ? Math.max(...clipsRef.current.map((c) => c.startTime + c.durationSec)) : 10;
    const clamped = Math.max(0, Math.min(total, newSec));
    setPlayheadSec(clamped);
    playheadSecRef.current = clamped;
    if (isPlayingRef.current) {
      playStartWallRef.current = performance.now();
      playStartHeadRef.current = clamped;
      startAudioAt(clamped, clipsRef.current);
      startBoardVideosAt(clamped, clipsRef.current);
    } else {
      for (const [clipId, vid] of boardVideoEls.current) {
        const clip = clipsRef.current.find((c) => c.id === clipId);
        if (!clip) continue;
        if (clamped >= clip.startTime && clamped < clip.startTime + clip.durationSec) {
          vid.currentTime = clipSourceTimeAtTimeline(clip, clamped);
        }
      }
    }
    applyKeyframeCameraAt(clamped, clipsRef.current);
  }

  function seekFromClientX(clientX: number) {
    const el = scrollerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    seekTo((clientX - rect.left + el.scrollLeft) / pxPerSecRef.current);
  }

  // ─── Board video sync (Feature A) ──────────────────────────────────────────

  function startBoardVideosAt(atSec: number, currentClips: BoardClip[]) {
    for (const [clipId, vid] of boardVideoEls.current) {
      const clip = currentClips.find((c) => c.id === clipId);
      if (!clip) continue;
      const isActive = atSec >= clip.startTime && atSec < clip.startTime + clip.durationSec;
      if (isActive) {
        setElementPlaybackRate(vid, clip);
        vid.currentTime = clipSourceTimeAtTimeline(clip, atSec);
        vid.play().catch(() => {});
      } else {
        vid.pause();
      }
    }
  }

  function pauseAllBoardVideos() {
    for (const vid of boardVideoEls.current.values()) vid.pause();
  }

  function tickBoardVideoPlayback(atSec: number, currentClips: BoardClip[]) {
    for (const [clipId, vid] of boardVideoEls.current) {
      const clip = currentClips.find((c) => c.id === clipId);
      if (!clip) continue;
      const isActive = atSec >= clip.startTime && atSec < clip.startTime + clip.durationSec;
      if (isActive && vid.paused) {
        setElementPlaybackRate(vid, clip);
        vid.currentTime = clipSourceTimeAtTimeline(clip, atSec);
        vid.play().catch(() => {});
      } else if (!isActive && !vid.paused) {
        vid.pause();
      }
    }
  }

  // ─── Board canvas interactions ──────────────────────────────────────────────

  function clientToBoardCoords(clientX: number, clientY: number): { bx: number; by: number } {
    const container = boardContainerRef.current;
    if (!container) return { bx: 0, by: 0 };
    const rect = container.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const zoom = boardZoomRef.current;
    // Canvas pixel coords (0..VIEWPORT_W, 0..VIEWPORT_H)
    const canvasX = cssX * (VIEWPORT_W / rect.width);
    const canvasY = cssY * (VIEWPORT_H / rect.height);
    // Board coords: each canvas pixel = 1/zoom board units
    const camLeft = cameraXRef.current - VIEWPORT_W / (2 * zoom);
    const camTop = cameraYRef.current - VIEWPORT_H / (2 * zoom);
    return { bx: camLeft + canvasX / zoom, by: camTop + canvasY / zoom };
  }

  function onBoardPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 && e.button !== 1) return;
    const isMiddleClick = e.button === 1;
    if (spaceHeldRef.current || isMiddleClick) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      panDragRef.current = { startMouseX: e.clientX, startMouseY: e.clientY, startCamX: cameraXRef.current, startCamY: cameraYRef.current };
      setIsPanning(true);
      return;
    }
    const { bx, by } = clientToBoardCoords(e.clientX, e.clientY);
    const visuals = clipsRef.current.filter(isVisualClip).sort((a, b) => a.layer - b.layer);
    const hit = visuals.find((c) => bx >= c.boardX && bx <= c.boardX + c.boardW && by >= c.boardY && by <= c.boardY + c.boardH);
    if (!hit) return;
    pushUndoSnapshot();
    e.currentTarget.setPointerCapture(e.pointerId);
    boardDragRef.current = { clipId: hit.id, offsetX: bx - hit.boardX, offsetY: by - hit.boardY };
    setBoardDraggingClipId(hit.id);
    setSelectedClipId(hit.id);
    selectedClipIdRef.current = hit.id;
  }

  function onBoardPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (panDragRef.current) {
      const pan = panDragRef.current;
      const containerW = boardContainerRef.current?.offsetWidth ?? VIEWPORT_W;
      const containerH = boardContainerRef.current?.offsetHeight ?? VIEWPORT_H;
      const dx = (e.clientX - pan.startMouseX) * (VIEWPORT_W / containerW);
      const dy = (e.clientY - pan.startMouseY) * (VIEWPORT_H / containerH);
      const newCamX = clamp(pan.startCamX - dx, VIEWPORT_W / 2, BOARD_W - VIEWPORT_W / 2);
      const newCamY = clamp(pan.startCamY - dy, VIEWPORT_H / 2, BOARD_H - VIEWPORT_H / 2);
      cameraXRef.current = newCamX;
      cameraYRef.current = newCamY;
      setCameraX(newCamX);
      setCameraY(newCamY);
      return;
    }
    const drag = boardDragRef.current;
    if (!drag) return;
    const { bx, by } = clientToBoardCoords(e.clientX, e.clientY);
    const newClips = clipsRef.current.map((c) => {
      if (c.id !== drag.clipId) return c;
      const newBoardX = clamp(bx - drag.offsetX, 0, BOARD_W - c.boardW);
      const newBoardY = clamp(by - drag.offsetY, 0, BOARD_H - c.boardH);
      return { ...c, boardX: newBoardX, boardY: newBoardY };
    });
    clipsRef.current = newClips;
    setClips(newClips);
  }

  function onBoardPointerUp() {
    if (panDragRef.current) { panDragRef.current = null; setIsPanning(false); return; }
    if (boardDragRef.current) { boardDragRef.current = null; setBoardDraggingClipId(null); }
  }

  function frameAll() {
    const visuals = clipsRef.current.filter(isVisualClip);
    if (visuals.length === 0) {
      const cx = BOARD_W / 2; const cy = BOARD_H / 2;
      cameraXRef.current = cx; cameraYRef.current = cy; boardZoomRef.current = 1;
      setCameraX(cx); setCameraY(cy); setBoardZoom(1);
      return;
    }
    const pad = 100;
    const minX = Math.min(...visuals.map((c) => c.boardX)) - pad;
    const minY = Math.min(...visuals.map((c) => c.boardY)) - pad;
    const maxX = Math.max(...visuals.map((c) => c.boardX + c.boardW)) + pad;
    const maxY = Math.max(...visuals.map((c) => c.boardY + c.boardH)) + pad;
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const zoom = Math.min(VIEWPORT_W / bboxW, VIEWPORT_H / bboxH, 4);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    cameraXRef.current = cx; cameraYRef.current = cy; boardZoomRef.current = zoom;
    setCameraX(cx); setCameraY(cy); setBoardZoom(zoom);
  }

  function applyKeyframeCameraAt(atSec: number, currentClips: BoardClip[]) {
    const cam = computeCameraAtTime(atSec, currentClips);
    if (!cam) return;
    cameraXRef.current = cam.x;
    cameraYRef.current = cam.y;
    boardZoomRef.current = cam.zoom;
    setCameraX(cam.x);
    setCameraY(cam.y);
    setBoardZoom(cam.zoom);
    setCameraStatusLabel(cam.label);
  }

  function resetCamera() {
    const cam = computeCameraAtTime(0, clipsRef.current);
    if (!cam) {
      const cx = BOARD_W / 2, cy = BOARD_H / 2;
      cameraXRef.current = cx; cameraYRef.current = cy; boardZoomRef.current = 1;
      setCameraX(cx); setCameraY(cy); setBoardZoom(1); setCameraStatusLabel("");
      return;
    }
    cameraXRef.current = cam.x; cameraYRef.current = cam.y; boardZoomRef.current = cam.zoom;
    setCameraX(cam.x); setCameraY(cam.y); setBoardZoom(cam.zoom); setCameraStatusLabel(cam.label);
  }

  // ─── Timeline drag ──────────────────────────────────────────────────────────

  function onScrollerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current) return;
    playheadDraggingRef.current = true;
    setSelectedClipId(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  }

  function updateHoldDrag(clientX: number) {
    const hd = holdDragRef.current;
    if (!hd) return;
    const clip = clipsRef.current.find((c) => c.id === hd.clipId);
    if (!clip || clip.durationSec <= 0) return;
    const dx = clientX - hd.startMouseX;
    const dtSec = dx / pxPerSecRef.current;
    const newFrac = clamp(hd.startFraction + dtSec / clip.durationSec, 0.05, 0.95);
    const newClips = clipsRef.current.map((c) => c.id === hd.clipId ? { ...c, holdFraction: newFrac } : c);
    clipsRef.current = newClips;
    setClips(newClips);
  }

  function onScrollerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (holdDragRef.current) { updateHoldDrag(e.clientX); return; }
    if (dragRef.current) { updateClipDrag(e.clientX, e.clientY); return; }
    if (playheadDraggingRef.current) seekFromClientX(e.clientX);
  }

  function onScrollerPointerUp() {
    if (holdDragRef.current) { holdDragRef.current = null; return; }
    if (dragRef.current) { commitClipDrag(); return; }
    playheadDraggingRef.current = false;
  }

  function onClipPointerDown(e: React.PointerEvent<HTMLDivElement>, clip: BoardClip) {
    e.stopPropagation();
    setSelectedClipId(clip.id);
    selectedClipIdRef.current = clip.id;
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const clipW = rect.width;
    let kind: DragInfo["kind"] = "move";
    if (clipW >= HANDLE_W * 3) {
      if (offsetX <= HANDLE_W) kind = "resize-left";
      else if (offsetX >= clipW - HANDLE_W) kind = "resize-right";
    }
    scrollerRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind, clipId: clip.id,
      origStartTime: clip.startTime, origDuration: clip.durationSec, origLayer: clip.layer,
      origTrimStart: clip.trimStart,
      startMouseX: e.clientX, startMouseY: e.clientY,
      validStartTime: clip.startTime, validDuration: clip.durationSec, validLayer: clip.layer,
      validTrimStart: clip.trimStart,
    };
    setGhost({ clipId: clip.id, startTime: clip.startTime, durationSec: clip.durationSec, layer: clip.layer, type: clip.type });
  }

  function updateClipDrag(clientX: number, clientY: number) {
    const drag = dragRef.current;
    if (!drag) return;
    const scroller = scrollerRef.current!;
    const rect = scroller.getBoundingClientRect();
    const dx = clientX - drag.startMouseX;
    const dtSec = dx / pxPerSecRef.current;
    const snapThreshold = MAGNETIC_SNAP_PX / pxPerSecRef.current;
    const yInLayers = clientY - rect.top + scroller.scrollTop - RULER_H;
    const hoverLayer = Math.min(layerCountRef.current, Math.max(1, Math.floor(yInLayers / LAYER_H) + 1));
    const src = clipsRef.current.find((c) => c.id === drag.clipId)!;
    const rate = clipPlaybackRate(src);
    const snapCandidates = [0, playheadSecRef.current, ...allOtherClipEdges(clipsRef.current, drag.clipId)];
    let newStart = drag.validStartTime;
    let newDur = drag.validDuration;
    let newLayer = drag.validLayer;
    let activeSnapTarget: number | null = null;

    if (drag.kind === "move") {
      const baseStart = Math.max(0, snapTo(drag.origStartTime + dtSec));
      newLayer = hoverLayer;
      newDur = drag.origDuration;
      const { snapped: snL, target: tL } = magneticSnap(baseStart, snapCandidates, snapThreshold);
      if (tL !== null) {
        newStart = Math.max(0, snL); activeSnapTarget = tL;
      } else {
        const { snapped: snR, target: tR } = magneticSnap(baseStart + newDur, snapCandidates, snapThreshold);
        if (tR !== null) { newStart = Math.max(0, snR - newDur); activeSnapTarget = tR; }
        else { newStart = baseStart; }
      }
    } else if (drag.kind === "resize-left") {
      const minStart = Math.max(0, drag.origStartTime - drag.origTrimStart / rate);
      const maxStart = drag.origStartTime + drag.origDuration - MIN_DURATION;
      const baseStart = snapTo(clamp(drag.origStartTime + dtSec, minStart, maxStart));
      const { snapped, target } = magneticSnap(baseStart, snapCandidates, snapThreshold);
      newStart = target !== null ? clamp(snapped, minStart, maxStart) : clamp(baseStart, minStart, maxStart);
      activeSnapTarget = target;
      const sourceDelta = (newStart - drag.origStartTime) * rate;
      drag.validTrimStart = clamp(drag.origTrimStart + sourceDelta, 0, src.sourceDuration);
      newDur = Math.max(MIN_DURATION, (drag.origTrimStart + drag.origDuration * rate - drag.validTrimStart) / rate);
      newLayer = drag.origLayer;
    } else {
      const maxTimelineDur = Math.max(MIN_DURATION, (src.sourceDuration - drag.origTrimStart) / rate);
      const baseDur = clamp(snapTo(drag.origDuration + dtSec), MIN_DURATION, maxTimelineDur);
      newStart = drag.origStartTime;
      newLayer = drag.origLayer;
      const { snapped: snE, target } = magneticSnap(drag.origStartTime + baseDur, snapCandidates, snapThreshold);
      const snDur = snE - drag.origStartTime;
      if (target !== null && snDur >= MIN_DURATION) {
        newDur = clamp(snDur, MIN_DURATION, maxTimelineDur); activeSnapTarget = target;
      } else { newDur = baseDur; }
    }

    const noOverlap = !clipsRef.current.some(
      (c) => c.id !== drag.clipId && c.layer === newLayer &&
        clipsOverlap(newStart, newDur, c.startTime, c.durationSec)
    );
    if (noOverlap) {
      drag.validStartTime = newStart;
      drag.validDuration = newDur;
      drag.validLayer = newLayer;
    }
    setGhost({ clipId: drag.clipId, startTime: drag.validStartTime, durationSec: drag.validDuration, layer: drag.validLayer, type: src.type });
    setSnapGuideSec(noOverlap ? activeSnapTarget : null);
  }

  function commitClipDrag() {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setGhost(null);
    setSnapGuideSec(null);
    const changed = drag.validStartTime !== drag.origStartTime || drag.validDuration !== drag.origDuration ||
      drag.validLayer !== drag.origLayer || drag.validTrimStart !== drag.origTrimStart;
    if (!changed) return;
    pushUndoSnapshot();
    setClips((prev) => prev.map((c) => c.id === drag.clipId
      ? { ...c, startTime: drag.validStartTime, durationSec: drag.validDuration, layer: drag.validLayer, trimStart: drag.validTrimStart }
      : c
    ));
  }

  function fitToTimeline() {
    if (clips.length === 0) { pxPerSecRef.current = DEFAULT_PX_PER_SEC; setPxPerSec(DEFAULT_PX_PER_SEC); return; }
    const total = Math.max(...clips.map((c) => c.startTime + c.durationSec));
    if (total <= 0) return;
    const containerW = scrollerRef.current?.offsetWidth ?? 800;
    const next = clamp((containerW - 80) / total, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
    pxPerSecRef.current = next;
    setPxPerSec(next);
    pendingScrollLeftRef.current = 0;
  }

  // ─── Recording ──────────────────────────────────────────────────────────────

  async function startRecording() {
    setRecError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const startSec = playheadSecRef.current;
      recStartSecRef.current = startSec;
      const layer = findFreeLayer(clipsRef.current, startSec, 9999, layerCountRef.current);
      ensureLayerCount(layer);
      recLayerRef.current = layer;
      isRecordingNarrationRef.current = true;
      startPlayback();
      const startWall = performance.now();
      recNarrationStartWallRef.current = startWall;
      setRecGrowingBar({ startSec, layer, elapsedSec: 0 });
      function growTick() {
        const elapsed = (performance.now() - recNarrationStartWallRef.current) / 1000;
        setRecGrowingBar((prev) => prev ? { ...prev, elapsedSec: elapsed } : null);
        recNarrationRafRef.current = requestAnimationFrame(growTick);
      }
      recNarrationRafRef.current = requestAnimationFrame(growTick);
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const blobUrl = URL.createObjectURL(blob);
        const durationSec = await getMediaDuration(blobUrl, "audio");
        const waveform = await generateWaveform(blobUrl).catch(() => undefined);
        const dur = durationSec || recSecondsRef.current;
        if (dur < 0.1) return;
        pushUndoSnapshot();
        setClips((prev) => {
          const pos = findFreeBoardPos(prev, CLIP_DEFAULT_W, CLIP_DEFAULT_H, cameraXRef.current, cameraYRef.current);
          return [...prev, {
            id: crypto.randomUUID(), type: "audio", name: "Narration", blobUrl,
            sourceDuration: dur, durationSec: dur, startTime: recStartSecRef.current,
            layer: recLayerRef.current, trimStart: 0, playbackRate: 1,
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1 }, muted: false,
            volumeCurve: [...DEFAULT_CURVE], waveform,
            boardX: pos.boardX, boardY: pos.boardY, boardW: CLIP_DEFAULT_W, boardH: CLIP_DEFAULT_H,
            cameraZoomTarget: defaultCameraZoom(CLIP_DEFAULT_W, CLIP_DEFAULT_H), holdFraction: 0.5,
          }];
        });
      };
      recorder.start();
      setRecSeconds(0);
      setRecording(true);
    } catch (e: unknown) {
      isRecordingNarrationRef.current = false;
      if (recNarrationRafRef.current !== null) { cancelAnimationFrame(recNarrationRafRef.current); recNarrationRafRef.current = null; }
      setRecGrowingBar(null);
      setRecError(e instanceof Error ? e.message : "Microphone access denied");
    }
  }

  function stopRecording() {
    if (recNarrationRafRef.current !== null) { cancelAnimationFrame(recNarrationRafRef.current); recNarrationRafRef.current = null; }
    setRecGrowingBar(null);
    if (recorderRef.current && recorderRef.current.state === "recording") recorderRef.current.stop();
    pausePlayback();
    isRecordingNarrationRef.current = false;
    setRecording(false);
  }

  async function handleMediaUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const processed = await Promise.all(
      Array.from(files).map(async (file) => {
        let type: ClipType;
        if (file.type.startsWith("audio/")) type = "audio";
        else if (file.type.startsWith("video/")) type = "video";
        else if (file.type.startsWith("image/")) type = "image";
        else return null;
        const blobUrl = URL.createObjectURL(file);
        const durationSec = await getMediaDuration(blobUrl, type);
        const waveform = type === "audio" ? await generateWaveform(blobUrl).catch(() => undefined) : undefined;
        return { type, name: file.name, blobUrl, durationSec, waveform };
      })
    );
    const valid = processed.filter((x): x is NonNullable<typeof x> => x !== null);
    if (!valid.length) return;
    pushUndoSnapshot();
    setClips((prev) => {
      const startTime = playheadSecRef.current;
      const newClips: BoardClip[] = [];
      for (const item of valid) {
        const dur = item.durationSec || (item.type === "image" ? IMAGE_DEFAULT_DURATION : 5);
        const layer = findFreeLayer([...prev, ...newClips], startTime, dur, layerCountRef.current);
        ensureLayerCount(layer);
        const pos = findFreeBoardPos([...prev, ...newClips], CLIP_DEFAULT_W, CLIP_DEFAULT_H, cameraXRef.current, cameraYRef.current);
        newClips.push({
          id: crypto.randomUUID(), type: item.type, name: item.name, blobUrl: item.blobUrl,
          sourceDuration: dur, durationSec: dur, startTime, layer, trimStart: 0, playbackRate: 1,
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1 }, muted: false,
          volumeCurve: [...DEFAULT_CURVE], waveform: item.waveform,
          boardX: pos.boardX, boardY: pos.boardY, boardW: CLIP_DEFAULT_W, boardH: CLIP_DEFAULT_H,
          cameraZoomTarget: defaultCameraZoom(CLIP_DEFAULT_W, CLIP_DEFAULT_H), holdFraction: 0.5,
        });
      }
      return [...prev, ...newClips];
    });
    e.target.value = "";
  }

  // ─── YouTube ─────────────────────────────────────────────────────────────────

  async function handleYtSearch(shortsOnlyOverride?: boolean) {
    if (!config?.railwayUrl || !ytQuery.trim()) return;
    setYtLoading(true); setYtError(""); setYtResults([]);
    try {
      const res = await fetch(`${config.railwayUrl}/video-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-neuralboard-password": config.railwayPassword },
        body: JSON.stringify({ query: ytQuery, limit: 12, shortsOnly: shortsOnlyOverride !== undefined ? shortsOnlyOverride : ytShortsOnly }),
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      setYtResults(Array.isArray(data) ? data : []);
    } catch (e) {
      setYtError(e instanceof Error ? e.message : "Search failed");
    } finally { setYtLoading(false); }
  }

  async function handleYtConfirm() {
    if (!config?.railwayUrl || !ytSelected) return;
    setYtLoading(true); setYtError("");
    try {
      const url = `https://www.youtube.com/watch?v=${ytSelected.id}`;
      const dlRes = await fetch(`${config.railwayUrl}/ytdl`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-neuralboard-password": config.railwayPassword },
        body: JSON.stringify({ url, start: ytStart, end: ytEnd }),
      });
      if (!dlRes.ok) {
        const err = await dlRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Download failed (${dlRes.status})`);
      }
      const { id } = await dlRes.json() as { id: string };
      const fileRes = await fetch(`${config.railwayUrl}/ytdl-file/${id}`, {
        headers: { "x-neuralboard-password": config.railwayPassword },
      });
      if (!fileRes.ok) throw new Error(`File fetch failed (${fileRes.status})`);
      const blob = await fileRes.blob();
      const blobUrl = URL.createObjectURL(blob);
      const durationSec = await getMediaDuration(blobUrl, "video");
      const title = (ytSelected.title ?? "YouTube clip").slice(0, 40);
      pushUndoSnapshot();
      setClips((prev) => {
        const startTime = playheadSecRef.current;
        const dur = durationSec || (ytEnd - ytStart);
        const layer = findFreeLayer(prev, startTime, dur, layerCountRef.current);
        ensureLayerCount(layer);
        const pos = findFreeBoardPos(prev, CLIP_DEFAULT_W, CLIP_DEFAULT_H, cameraXRef.current, cameraYRef.current);
        return [...prev, {
          id: crypto.randomUUID(), type: "video", name: title, blobUrl,
          sourceDuration: dur, durationSec: dur, startTime, layer, trimStart: 0, playbackRate: 1,
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1 }, muted: false,
          volumeCurve: [...DEFAULT_CURVE],
          boardX: pos.boardX, boardY: pos.boardY, boardW: CLIP_DEFAULT_W, boardH: CLIP_DEFAULT_H,
          cameraZoomTarget: defaultCameraZoom(CLIP_DEFAULT_W, CLIP_DEFAULT_H), holdFraction: 0.5,
        }];
      });
      setYtModalOpen(false);
      fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          youtube_url: `https://www.youtube.com/watch?v=${ytSelected.id}`,
          youtube_video_id: ytSelected.id,
          title: ytSelected.title ?? "YouTube video",
          thumbnail_url: ytSelected.thumbnail ?? "",
          duration_seconds: Math.round(parseDurationSec(ytSelected.duration)),
        }),
      }).catch(() => {});
      setYtView("search"); setYtSelected(null); setYtResults([]); setYtQuery("");
    } catch (e) {
      setYtError(e instanceof Error ? e.message : "Download failed");
    } finally { setYtLoading(false); }
  }

  // ─── Library ─────────────────────────────────────────────────────────────────

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }

  async function fetchLibrary() {
    setSavedVideosLoading(true); setSavedVideosError("");
    try {
      const res = await fetch("/api/library");
      if (!res.ok) throw new Error();
      setSavedVideos(await res.json());
    } catch { setSavedVideosError("Failed to load library"); }
    finally { setSavedVideosLoading(false); }
  }

  async function deleteLibraryEntry(id: string) {
    setSavedVideos((prev) => prev.filter((v) => v.id !== id));
    await fetch(`/api/library?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }

  function openFromLibrary(video: LibraryVideo) {
    setSavedVideosOpen(false);
    const maxSec = video.duration_seconds || 600;
    const initEnd = Math.min(30, maxSec);
    setYtSelected({ id: video.youtube_video_id, title: video.title, channel: "", duration: video.duration_seconds, thumbnail: video.thumbnail_url });
    setYtStart(0); setYtStartInput("0:00"); setYtEnd(initEnd); setYtEndInput(formatTimestamp(initEnd));
    ytRangeRef.current = { start: 0, end: initEnd };
    setYtView("trim"); setYtError(""); setYtModalOpen(true);
  }

  // ─── Export ──────────────────────────────────────────────────────────────────

  function cancelExport() { exportCancelRef.current = true; }

  async function startExport() {
    if (isRecordingNarrationRef.current) { alert("Stop recording before exporting"); return; }
    const currentClips = clipsRef.current;
    if (currentClips.length === 0) { alert("No clips to export"); return; }
    if (isPlayingRef.current) pausePlayback();
    setIsExporting(true);
    isExportingRef.current = true;
    exportCancelRef.current = false;
    setExportProgress(0);
    const sourceTotalDur = Math.max(...currentClips.map((c) => c.startTime + c.durationSec));
    const totalDur = Math.min(MAX_EXPORT_DURATION, sourceTotalDur);
    setExportDurationSec(totalDur);
    const canvasW = 1600;
    const canvasH = 1200;

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx2d = canvas.getContext("2d")!;

    // Load video elements
    const exportVideoEls = new Map<string, HTMLVideoElement>();
    for (const clip of currentClips) {
      if (clip.type !== "video") continue;
      const vid = document.createElement("video");
      vid.src = clip.blobUrl; vid.muted = true; vid.preload = "auto";
      setElementPlaybackRate(vid, clip);
      await new Promise<void>((res) => {
        if (vid.readyState >= 2) { res(); return; }
        vid.addEventListener("loadedmetadata", () => res(), { once: true });
        vid.addEventListener("error", () => res(), { once: true });
        vid.load();
      });
      exportVideoEls.set(clip.id, vid);
    }

    // Load image elements
    const exportImageEls = new Map<string, HTMLImageElement>();
    await Promise.all(currentClips.filter((c) => c.type === "image").map((clip) =>
      new Promise<void>((res) => {
        const img = new Image();
        img.onload = () => { exportImageEls.set(clip.id, img); res(); };
        img.onerror = () => res();
        img.src = clip.blobUrl;
      })
    ));

    const audioCtx = getAudioCtx();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const exportAudioDest = audioCtx.createMediaStreamDestination();
    const combined = new MediaStream([
      ...canvas.captureStream(30).getVideoTracks(),
      ...exportAudioDest.stream.getAudioTracks(),
    ]);
    const mimeType = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "video/webm";
    const recorder = new MediaRecorder(combined, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = mimeType === "video/mp4" ? "neuralboard-export.mp4" : "neuralboard-export.webm";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setIsExporting(false); isExportingRef.current = false; setExportProgress(0); setExportDurationSec(0);
    };

    startAudioAt(0, currentClips, exportAudioDest);
    for (const [clipId, vid] of exportVideoEls) {
      const clip = currentClips.find((c) => c.id === clipId)!;
      if (clip.startTime === 0) {
        setElementPlaybackRate(vid, clip);
        vid.currentTime = clipSourceTimeAtTimeline(clip, 0);
        vid.play().catch(() => {});
      }
    }
    recorder.start(100);
    const exportWallStart = performance.now();

    function exportFrame() {
      if (exportCancelRef.current) {
        stopAllAudio();
        for (const vid of exportVideoEls.values()) vid.pause();
        recorder.stop();
        setIsExporting(false); isExportingRef.current = false; setExportProgress(0); setExportDurationSec(0);
        return;
      }
      const elapsed = (performance.now() - exportWallStart) / 1000;
      if (elapsed >= totalDur) {
        stopAllAudio();
        for (const vid of exportVideoEls.values()) vid.pause();
        recorder.stop();
        return;
      }
      setExportProgress(elapsed / totalDur);
      tickAudio(elapsed, currentClips, exportAudioDest);

      // Manage video element lifecycle
      for (const [clipId, vid] of exportVideoEls) {
        const clip = currentClips.find((c) => c.id === clipId)!;
        const isActive = elapsed >= clip.startTime && elapsed < clip.startTime + clip.durationSec;
        setElementPlaybackRate(vid, clip);
        if (isActive && vid.paused) { vid.currentTime = clipSourceTimeAtTimeline(clip, elapsed); vid.play().catch(() => {}); }
        else if (!isActive && !vid.paused) { vid.pause(); }
      }

      // Draw board frame to export canvas — camera driven by keyframes
      const exportCam = computeCameraAtTime(elapsed, currentClips);
      const exportZoom = exportCam ? exportCam.zoom : 1;
      const exportCamX = exportCam ? exportCam.x : BOARD_W / 2;
      const exportCamY = exportCam ? exportCam.y : BOARD_H / 2;
      const scaleX = (canvasW / VIEWPORT_W) * exportZoom;
      const scaleY = (canvasH / VIEWPORT_H) * exportZoom;
      const camLeft = exportCamX - VIEWPORT_W / (2 * exportZoom);
      const camTop = exportCamY - VIEWPORT_H / (2 * exportZoom);

      ctx2d.fillStyle = BOARD_BG;
      ctx2d.fillRect(0, 0, canvasW, canvasH);

      const visClips = currentClips
        .filter((c) => isVisualClip(c) && elapsed >= c.startTime && elapsed < c.startTime + c.durationSec)
        .sort((a, b) => b.layer - a.layer);

      for (const clip of visClips) {
        const cx = (clip.boardX - camLeft) * scaleX;
        const cy = (clip.boardY - camTop) * scaleY;
        const cw = clip.boardW * scaleX;
        const ch = clip.boardH * scaleY;
        if (cx + cw < 0 || cx > canvasW || cy + ch < 0 || cy > canvasH) continue;

        if (clip.type === "text") {
          ctx2d.fillStyle = "rgba(0,0,0,0.6)"; ctx2d.fillRect(cx, cy, cw, ch);
          drawTextClip(ctx2d, clip, cx, cy, cw, ch, canvasH);
        } else if (clip.type === "countdown") {
          ctx2d.fillStyle = "rgba(0,0,0,0.7)"; ctx2d.fillRect(cx, cy, cw, ch);
          drawCountdownClip(ctx2d, clip, cx, cy, cw, ch, canvasH, elapsed - clip.startTime);
        } else {
          const vidEl = exportVideoEls.get(clip.id) ?? null;
          const imgEl = exportImageEls.get(clip.id) ?? null;
          const mediaEl = vidEl ?? imgEl ?? null;
          if (mediaEl) {
            const mW = mediaEl instanceof HTMLVideoElement ? mediaEl.videoWidth : (mediaEl as HTMLImageElement).naturalWidth;
            const mH = mediaEl instanceof HTMLVideoElement ? mediaEl.videoHeight : (mediaEl as HTMLImageElement).naturalHeight;
            if (mW > 0 && mH > 0) {
              const rect = drawContainedRect(mW, mH, cx, cy, cw, ch);
              drawMaybeKeyedMedia(ctx2d, mediaEl, rect.x, rect.y, rect.w, rect.h, clip);
            } else { ctx2d.fillStyle = CLIP_COLORS[clip.type]; ctx2d.fillRect(cx, cy, cw, ch); }
          } else { ctx2d.fillStyle = CLIP_COLORS[clip.type]; ctx2d.fillRect(cx, cy, cw, ch); }
        }
        ctx2d.strokeStyle = "#2a2a2a"; ctx2d.lineWidth = 3; ctx2d.strokeRect(cx, cy, cw, ch);
      }

      exportRafRef.current = requestAnimationFrame(exportFrame);
    }
    exportRafRef.current = requestAnimationFrame(exportFrame);
  }

  // ─── Auth gates ──────────────────────────────────────────────────────────────

  if (status === "loading") {
    return <main style={pageStyle}><div style={{ margin: "auto", fontFamily: "monospace", color: "#6a6a6a", fontSize: 13 }}>Loading...</div></main>;
  }

  if (!session?.user) {
    return (
      <main style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}>
        <div style={{ maxWidth: 360, width: "100%" }}>
          <h1 style={{ fontFamily: "'Caveat', cursive", fontSize: 38, color: "#2a2a2a", textAlign: "center", marginBottom: 4 }}>Neural Board</h1>
          <p style={{ fontSize: 12, color: "#6a6a6a", textAlign: "center", marginBottom: 24, fontFamily: "'Courier New', monospace" }}>sign in to continue</p>
          <button onClick={() => signIn("google")} style={primaryButtonStyle}>Sign in with Google</button>
        </div>
      </main>
    );
  }

  const totalDuration = clips.length > 0 ? Math.max(...clips.map((c) => c.startTime + c.durationSec)) : 10;
  const timelineW = totalDuration * pxPerSec + 200;
  const playheadX = playheadSec * pxPerSec;
  const isDraggingClip = ghost !== null;

  return (
    <main style={pageStyle}>
      <style>{`@keyframes nbpulse { 0%,100%{opacity:1} 50%{opacity:0.3} } @keyframes nbslide-in { from { transform: translateX(100%); } to { transform: translateX(0); } } @keyframes nbtoast { 0%{opacity:0;transform:translate(-50%,8px)} 100%{opacity:1;transform:translate(-50%,0)} }`}</style>

      {/* Header */}
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: "#2a2a2a" }}>Neural Board</span>
          <span style={{ fontSize: 11, color: "#6a6a6a", letterSpacing: 1, fontFamily: "monospace" }}>/ BOARD</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <a href="/editor" style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace", textDecoration: "none" }}>Editor</a>
          <a href="/builder" style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace", textDecoration: "none" }}>Builder</a>
          <span style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>{session.user.email}</span>
        </div>
      </header>

      {/* Workspace */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0, minHeight: 0 }}>

          {/* Top: media panel + board preview */}
          <div style={{ display: "flex", borderBottom: "1.5px solid rgba(42,42,42,0.15)", background: "rgba(245,236,216,0.5)" }}>

            {/* Media panel */}
            <div style={{ width: 210, flexShrink: 0, borderRight: "1.5px solid rgba(42,42,42,0.15)", padding: "16px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", letterSpacing: 1, textTransform: "uppercase", marginBottom: 2 }}>Media</div>
              {recording ? (
                <button onClick={stopRecording} style={{ ...sketchButton, background: "#ff5e3a", color: "#fff", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#fff", animation: "nbpulse 1s infinite" }} />
                  Stop Recording
                </button>
              ) : (
                <button onClick={startRecording} style={sketchButton}>● Record narration</button>
              )}
              <button onClick={() => mediaUploadRef.current?.click()} style={sketchButton}>↑ Upload media</button>
              <input ref={mediaUploadRef} type="file" accept="audio/*,video/*,image/*" multiple style={{ display: "none" }} onChange={handleMediaUpload} />
              {config?.railwayUrl && (
                <button onClick={() => { setYtModalOpen(true); setYtView("search"); setYtQuery(""); setYtResults([]); setYtError(""); }} style={sketchButton}>
                  ▶ Add YouTube clip
                </button>
              )}
              {recError && <span style={{ fontSize: 10, color: "#ff5e3a", fontFamily: "monospace" }}>{recError}</span>}
            </div>

            {/* Board preview */}
            <div style={{ flex: 1, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", letterSpacing: 1, textTransform: "uppercase" }}>
                  Board Preview · {Math.round(cameraX)},{Math.round(cameraY)} · {boardZoom.toFixed(2)}×
                </div>
                <span style={{ fontSize: 9, fontFamily: "monospace", padding: "1px 6px", background: isPlaying ? "rgba(200,241,53,0.25)" : "rgba(42,42,42,0.08)", border: `1px solid ${isPlaying ? "#c8f135" : "rgba(42,42,42,0.2)"}`, color: isPlaying ? "#5a7a00" : "#999" }}>
                  {isPlaying ? "Auto (keyframes)" : "Manual"}
                </span>
                {cameraStatusLabel && (
                  <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {cameraStatusLabel}
                  </span>
                )}
                <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
                  <button onClick={resetCamera} style={{ ...sketchButton, padding: "3px 10px", fontSize: 10, height: 24 }}>↩ Reset</button>
                  <button onClick={frameAll} style={{ ...sketchButton, padding: "3px 10px", fontSize: 10, height: 24 }}>⊞ Frame All</button>
                </div>
              </div>
              <div
                ref={boardContainerRef}
                onPointerDown={onBoardPointerDown}
                onPointerMove={onBoardPointerMove}
                onPointerUp={onBoardPointerUp}
                onPointerCancel={onBoardPointerUp}
                onMouseEnter={() => { mouseOverBoardRef.current = true; }}
                onMouseLeave={() => { mouseOverBoardRef.current = false; }}
                style={{
                  width: "min(100%, 640px)",
                  aspectRatio: `${VIEWPORT_W}/${VIEWPORT_H}`,
                  border: "1.5px solid #2a2a2a",
                  boxShadow: "3px 3px 0 #2a2a2a",
                  overflow: "hidden",
                  flexShrink: 0,
                  background: BOARD_BG,
                  cursor: isPanning ? "grabbing" : spaceHeld ? "grab" : boardDraggingClipId ? "grabbing" : "default",
                  touchAction: "none",
                }}
              >
                <canvas
                  ref={boardCanvasRef}
                  width={VIEWPORT_W}
                  height={VIEWPORT_H}
                  style={{ width: "100%", height: "100%", display: "block", pointerEvents: "none" }}
                />
              </div>
            </div>
          </div>

          {/* Transport */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderBottom: "1.5px solid rgba(42,42,42,0.15)", background: "rgba(245,236,216,0.85)", flexWrap: "wrap" }}>
            <button
              onClick={() => isPlaying ? pausePlayback() : startPlayback()}
              disabled={isExporting}
              style={{ ...sketchButton, width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, background: isPlaying ? "#ff5e3a" : "#c8f135", opacity: isExporting ? 0.4 : 1 }}
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
            <button onClick={stopAndRewind} disabled={isExporting} style={{ ...sketchButton, width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, opacity: isExporting ? 0.4 : 1 }}>⏹</button>
            <span style={{ fontFamily: "'Courier New', monospace", fontSize: 14, color: "#2a2a2a", letterSpacing: 2, border: "1.5px solid #2a2a2a", padding: "3px 10px", background: "#fffdf5", boxShadow: "2px 2px 0 #2a2a2a", minWidth: 96, textAlign: "center" }}>
              {formatTime(playheadSec)}
            </span>
            <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6a6a6a" }}>/ {formatTime(totalDuration)}</span>
            <button onClick={addLayer} disabled={isExporting} style={{ ...sketchButton, height: 36, padding: "0 12px", fontSize: 12, opacity: isExporting ? 0.4 : 1 }}>+ Layer</button>
            <button onClick={fitToTimeline} disabled={isExporting} style={{ ...sketchButton, height: 36, padding: "0 12px", fontSize: 12, opacity: isExporting ? 0.4 : 1 }}>Fit</button>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
              {isExporting && (
                <span style={{ fontSize: 10, fontFamily: "monospace", color: "#ff5e3a" }}>
                  {formatTime(exportProgress * (exportDurationSec || Math.min(totalDuration, MAX_EXPORT_DURATION)))} / {formatTime(exportDurationSec || Math.min(totalDuration, MAX_EXPORT_DURATION))}
                </span>
              )}
              <button
                onClick={isExporting ? cancelExport : startExport}
                style={{ ...sketchButton, height: 36, padding: "0 14px", fontSize: 12, background: isExporting ? "#ff5e3a" : "#c8f135", color: isExporting ? "#fff" : "#2a2a2a" }}
              >
                {isExporting ? `✕ Cancel (${Math.round(exportProgress * 100)}%)` : "⬇ Export"}
              </button>
            </div>
            <span style={{ fontSize: 9, fontFamily: "monospace", color: "#bbb" }}>[space] play/pause · [cmd/ctrl+z] undo · [⌫] delete</span>
          </div>

          {/* Timeline */}
          <div
            ref={scrollerRef}
            onPointerDown={onScrollerPointerDown}
            onPointerMove={onScrollerPointerMove}
            onPointerUp={onScrollerPointerUp}
            onPointerCancel={onScrollerPointerUp}
            style={{ overflowX: "auto", overflowY: "auto", cursor: isDraggingClip ? "grabbing" : "crosshair", userSelect: "none", position: "relative", flex: 1 }}
          >
            <div style={{ position: "relative", width: timelineW, minHeight: RULER_H + layerCount * LAYER_H }}>

              {/* Ruler */}
              <div style={{ position: "relative", height: RULER_H, borderBottom: "1.5px solid #2a2a2a", background: "rgba(245,236,216,0.9)" }}>
                {(() => {
                  const tickSec = pxPerSec > 200 ? 0.5 : pxPerSec >= 100 ? 1 : pxPerSec >= 30 ? 5 : 10;
                  const labelSec = pxPerSec > 200 ? 1 : pxPerSec >= 100 ? 5 : pxPerSec >= 30 ? 10 : 30;
                  const tickCount = Math.min(Math.ceil(totalDuration / tickSec) + 1, 2000);
                  return Array.from({ length: tickCount }, (_, i) => {
                    const timeSec = i * tickSec;
                    const showLabel = Math.abs(timeSec % labelSec) < 0.001;
                    return (
                      <div key={i} style={{ position: "absolute", left: timeSec * pxPerSec, top: 0, height: "100%", display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                        <div style={{ width: 1, background: "#2a2a2a", height: showLabel ? 14 : 7, marginTop: showLabel ? 4 : 12 }} />
                        {showLabel && <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", marginLeft: 3, lineHeight: 1 }}>{timeSec}s</span>}
                      </div>
                    );
                  });
                })()}
              </div>

              {/* Layers */}
              {Array.from({ length: layerCount }, (_, idx) => {
                const layerNum = idx + 1;
                const layerClips = clips.filter((c) => c.layer === layerNum);
                const layerGhost = ghost?.layer === layerNum ? ghost : null;
                const layerMuted = !!mutedLayers[layerNum];
                return (
                  <div key={layerNum} style={{ position: "relative", height: LAYER_H, borderBottom: `1px solid rgba(42,42,42,${layerNum === layerCount ? 0.3 : 0.1})`, background: layerBg(layerNum) }}>
                    <span style={{ position: "absolute", left: 6, top: 7, fontSize: 9, fontFamily: "monospace", color: "rgba(42,42,42,0.28)", letterSpacing: 0.5, textTransform: "uppercase", pointerEvents: "none", userSelect: "none", zIndex: 0 }}>
                      Layer {layerNum}
                    </span>
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); toggleLayerMute(layerNum); }}
                      disabled={isExporting}
                      style={{ position: "absolute", left: 6, bottom: 6, zIndex: 7, fontSize: 8, fontFamily: "monospace", padding: "1px 5px", border: "1px solid rgba(42,42,42,0.45)", background: layerMuted ? "#ff5e3a" : "rgba(245,236,216,0.88)", color: layerMuted ? "#fff" : "#2a2a2a", cursor: isExporting ? "default" : "pointer", opacity: isExporting ? 0.4 : 1 }}
                    >
                      {layerMuted ? "MUTED" : "MUTE"}
                    </button>
                    {layerClips.map((clip) => {
                      const isBeingDragged = ghost?.clipId === clip.id;
                      const clipPx = Math.max(HANDLE_W * 2 + 4, clip.durationSec * pxPerSec - 2);
                      const showHandles = clipPx >= HANDLE_W * 3;
                      return (
                        <div
                          key={clip.id}
                          onPointerDown={(e) => onClipPointerDown(e, clip)}
                          style={{ position: "absolute", left: clip.startTime * pxPerSec, top: 7, width: clipPx, height: LAYER_H - 14, background: CLIP_COLORS[clip.type], opacity: isBeingDragged ? 0.28 : 1, border: selectedClipId === clip.id ? "2px solid #ff5e3a" : "1.5px solid #2a2a2a", boxShadow: isBeingDragged ? "none" : selectedClipId === clip.id ? "0 0 0 2px #ff5e3a44, 2px 2px 0 #2a2a2a" : "2px 2px 0 #2a2a2a", cursor: isBeingDragged ? "grabbing" : "grab", display: "flex", alignItems: "center", overflow: "hidden", zIndex: 2 }}
                        >
                          {showHandles && <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.18)", cursor: "ew-resize" }} />}
                          {isVisualClip(clip) && clipPx >= 30 && !isBeingDragged && (() => {
                            const dividerLeft = clip.holdFraction * clipPx;
                            const holdSec = (clip.durationSec * clip.holdFraction).toFixed(1);
                            const transSec = (clip.durationSec * (1 - clip.holdFraction)).toFixed(1);
                            return (
                              <>
                                <div style={{ position: "absolute", left: 0, top: 0, width: dividerLeft, height: "100%", background: "rgba(80,160,255,0.18)", pointerEvents: "none", zIndex: 1 }} />
                                <div style={{ position: "absolute", left: dividerLeft, top: 0, right: 0, height: "100%", background: "rgba(255,140,0,0.18)", pointerEvents: "none", zIndex: 1 }} />
                                <div
                                  title={`Hold ${holdSec}s / Transition ${transSec}s`}
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    scrollerRef.current?.setPointerCapture(e.pointerId);
                                    holdDragRef.current = { clipId: clip.id, startMouseX: e.clientX, startFraction: clip.holdFraction };
                                  }}
                                  style={{ position: "absolute", left: dividerLeft - 4, top: 0, width: 8, height: "100%", cursor: "col-resize", zIndex: 5, display: "flex", alignItems: "stretch", justifyContent: "center" }}
                                >
                                  <div style={{ width: 2, background: "rgba(42,42,42,0.5)", height: "100%", pointerEvents: "none" }} />
                                </div>
                              </>
                            );
                          })()}
                          <div style={{ position: "relative", zIndex: 2, paddingLeft: showHandles ? HANDLE_W + 4 : 5, paddingRight: showHandles ? HANDLE_W + 4 : 5, overflow: "hidden", flexGrow: 1, pointerEvents: "none" }}>
                            <div style={{ fontSize: 10, fontFamily: "'Courier New', monospace", fontWeight: 700, color: "#2a2a2a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{clip.name}</div>
                            <div style={{ fontSize: 9, fontFamily: "monospace", color: "#555", whiteSpace: "nowrap" }}>{formatDuration(clip.durationSec)}</div>
                          </div>
                          {showHandles && <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.18)", cursor: "ew-resize" }} />}
                        </div>
                      );
                    })}
                    {layerGhost && (
                      <div style={{ position: "absolute", left: layerGhost.startTime * pxPerSec, top: 5, width: Math.max(4, layerGhost.durationSec * pxPerSec - 2), height: LAYER_H - 10, background: CLIP_COLORS[layerGhost.type], opacity: 0.6, border: "2px dashed #2a2a2a", pointerEvents: "none", zIndex: 6 }} />
                    )}
                    {recGrowingBar?.layer === layerNum && (
                      <div style={{ position: "absolute", left: recGrowingBar.startSec * pxPerSec, top: 7, width: Math.max(2, recGrowingBar.elapsedSec * pxPerSec), height: LAYER_H - 14, background: "rgba(255,94,58,0.22)", border: "2px solid #ff5e3a", pointerEvents: "none", zIndex: 5, display: "flex", alignItems: "center", paddingLeft: 5, overflow: "hidden" }}>
                        <span style={{ fontSize: 9, fontFamily: "monospace", color: "#ff5e3a", fontWeight: 700, whiteSpace: "nowrap" }}>REC</span>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Add layer placeholder */}
              <div
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); showToast("Coming soon"); }}
                style={{ position: "relative", height: 40, borderTop: "1px dashed rgba(42,42,42,0.18)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", userSelect: "none" }}
              >
                <span style={{ fontSize: 10, fontFamily: "monospace", color: "rgba(42,42,42,0.32)", letterSpacing: 1 }}>+ Add Layer</span>
              </div>

              {clips.length === 0 && (
                <div style={{ position: "absolute", left: "50%", top: RULER_H + (layerCount * LAYER_H) / 2, transform: "translate(-50%, -50%)", fontSize: 11, fontFamily: "monospace", color: "#ccc", pointerEvents: "none", whiteSpace: "nowrap" }}>
                  Record or upload to add clips
                </div>
              )}

              {/* Snap guide */}
              {snapGuideSec !== null && (
                <div style={{ position: "absolute", left: snapGuideSec * pxPerSec, top: 0, bottom: 0, width: 1, background: "rgba(80,200,255,0.9)", zIndex: 9, pointerEvents: "none", boxShadow: "0 0 4px rgba(80,200,255,0.6)" }} />
              )}

              {/* Playhead */}
              <div style={{ position: "absolute", left: playheadX, top: 0, bottom: 0, width: 2, background: "#ff5e3a", zIndex: 10, pointerEvents: "none" }}>
                <div style={{ position: "absolute", top: 0, left: -5, width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "10px solid #ff5e3a" }} />
                {recording && recGrowingBar && (
                  <div style={{ position: "absolute", top: 12, left: 5, fontSize: 9, fontFamily: "monospace", color: "#ff5e3a", background: "rgba(245,236,216,0.92)", padding: "1px 4px", borderRadius: 2, whiteSpace: "nowrap" }}>
                    REC ● {formatDuration(recGrowingBar.elapsedSec)}
                  </div>
                )}
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* YouTube Modal */}
      {ytModalOpen && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setYtModalOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 640, maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", fontFamily: "monospace", overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{ytView === "search" ? "▶ YOUTUBE SEARCH" : `▶ TRIM — ${(ytSelected?.title ?? "").slice(0, 45)}`}</span>
              <button onClick={() => setYtModalOpen(false)} style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15 }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
              {ytView === "search" ? (
                <>
                  <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                    <div style={{ display: "flex", flexShrink: 0 }}>
                      {(["Shorts", "Normal"] as const).map((label) => {
                        const active = label === "Shorts" ? ytShortsOnly : !ytShortsOnly;
                        return (
                          <button key={label} onClick={() => { const v = label === "Shorts"; setYtShortsOnly(v); handleYtSearch(v); }}
                            style={{ ...miniButton, fontSize: 11, padding: "4px 8px", background: active ? "#2a2a2a" : "transparent", color: active ? "#fffdf5" : "#2a2a2a" }}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <input autoFocus type="text" value={ytQuery} onChange={(e) => setYtQuery(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleYtSearch(); }}
                      placeholder="search youtube..."
                      style={{ flex: 1, fontFamily: "monospace", fontSize: 13, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a" }} />
                    <button onClick={() => handleYtSearch()} disabled={ytLoading}
                      style={{ ...miniButton, padding: "8px 16px", fontSize: 12, fontWeight: 700, opacity: ytLoading ? 0.5 : 1 }}>
                      {ytLoading ? "..." : "search"}
                    </button>
                  </div>
                  {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, marginBottom: 8 }}>{ytError}</p>}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                    {ytResults.map((r) => (
                      <div key={r.id} onClick={() => {
                        setYtSelected(r);
                        const maxSec = parseDurationSec(r.duration);
                        const initEnd = Math.min(30, maxSec);
                        setYtStart(0); setYtStartInput("0:00"); setYtEnd(initEnd); setYtEndInput(formatTimestamp(initEnd));
                        ytRangeRef.current = { start: 0, end: initEnd }; setYtView("trim");
                      }} style={{ border: "1.5px solid #2a2a2a", cursor: "pointer", background: "rgba(255,253,245,0.9)", boxShadow: "2px 2px 0 #2a2a2a", overflow: "hidden" }}>
                        {r.thumbnail && <img src={r.thumbnail} alt="" style={{ width: "100%", display: "block", aspectRatio: "16/9", objectFit: "cover" }} />}
                        <div style={{ padding: "5px 7px" }}>
                          <div style={{ fontSize: 10, fontWeight: 700, lineHeight: 1.3, marginBottom: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>{r.title ?? "(no title)"}</div>
                          <div style={{ fontSize: 9, color: "#6a6a6a" }}>{r.channel ?? ""}{r.channel && r.duration != null ? " · " : ""}{r.duration != null ? (typeof r.duration === "number" ? `${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, "0")}` : r.duration) : ""}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                ytSelected && (() => {
                  const maxSec = parseDurationSec(ytSelected.duration);
                  const pctOf = (v: number) => Math.max(0, Math.min(100, (v / Math.max(0.1, maxSec)) * 100));
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
                        ytRangeRef.current.start = newStart; setYtStart(newStart); setYtStartInput(formatTimestamp(newStart));
                        if (curEnd - newStart > 30) { const ne = newStart + 30; ytRangeRef.current.end = ne; setYtEnd(ne); setYtEndInput(formatTimestamp(ne)); }
                      } else {
                        const curStart = ytRangeRef.current.start;
                        const newEnd = Math.max(curStart + 0.5, Math.min(maxSec, Math.min(clamped, curStart + 30)));
                        ytRangeRef.current.end = newEnd; setYtEnd(newEnd); setYtEndInput(formatTimestamp(newEnd));
                      }
                    };
                    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
                  };
                  return (
                    <div>
                      <div style={{ marginBottom: 14, background: "#000", lineHeight: 0 }}>
                        <iframe src={`https://www.youtube.com/embed/${ytSelected.id}?start=${Math.floor(ytStart)}&autoplay=0`}
                          style={{ width: "100%", aspectRatio: "16/9", border: "none" }}
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
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
                                const ns = Math.max(0, Math.min(maxSec - 0.5, p));
                                const ce = ytRangeRef.current.end;
                                ytRangeRef.current.start = ns; setYtStart(ns);
                                if (ce <= ns + 0.5) { const ne = Math.min(ns + 30, maxSec); ytRangeRef.current.end = ne; setYtEnd(ne); setYtEndInput(formatTimestamp(ne)); }
                                else if (ce - ns > 30) { const ne = ns + 30; ytRangeRef.current.end = ne; setYtEnd(ne); setYtEndInput(formatTimestamp(ne)); }
                              }
                            }}
                            onBlur={() => setYtStartInput(formatTimestamp(ytStart))}
                            style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 3 }}>End</div>
                          <input type="text" value={ytEndInput} placeholder="0:30"
                            onChange={(e) => {
                              setYtEndInput(e.target.value);
                              const p = parseTimestampSec(e.target.value);
                              if (p !== null) { const ne = Math.max(ytRangeRef.current.start + 0.5, Math.min(maxSec, Math.min(p, ytRangeRef.current.start + 30))); ytRangeRef.current.end = ne; setYtEnd(ne); }
                            }}
                            onBlur={() => setYtEndInput(formatTimestamp(ytEnd))}
                            style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties} />
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>Clip length: {formatTimestamp(Math.max(0, ytEnd - ytStart))} · {formatTimestamp(maxSec)} total</div>
                      {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, fontFamily: "monospace", marginTop: 6, marginBottom: 0 }}>{ytError}</p>}
                    </div>
                  );
                })()
              )}
            </div>
            {ytView === "trim" && (
              <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => { setYtView("search"); setYtSelected(null); setYtError(""); }} style={{ ...miniButton, padding: "6px 12px", fontSize: 11 }}>← back</button>
                <button onClick={handleYtConfirm} disabled={ytLoading} style={{ ...miniButton, marginLeft: "auto", padding: "6px 18px", fontSize: 12, fontWeight: 700, background: "#c8f135", borderColor: "#2a2a2a", opacity: ytLoading ? 0.5 : 1 }}>
                  {ytLoading ? "downloading…" : "Add to timeline"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Saved Videos button */}
      {!savedVideosOpen && (
        <button onClick={() => { setSavedVideosOpen(true); fetchLibrary(); }}
          style={{ position: "fixed", bottom: 16, right: 16, zIndex: 900, fontFamily: "monospace", fontSize: 11, fontWeight: 700, background: "#4caf7d", color: "#fff", border: "1.5px solid #2a2a2a", padding: "7px 14px", cursor: "pointer", boxShadow: "2px 2px 0 #2a2a2a", letterSpacing: 0.5 }}>
          ▶ Saved Videos
        </button>
      )}

      {/* Saved Videos panel */}
      {savedVideosOpen && (
        <>
          <div onClick={() => setSavedVideosOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 950 }} />
          <div style={{ position: "fixed", right: 0, top: 0, bottom: 0, width: 300, background: "#fffdf5", borderLeft: "2px solid #2a2a2a", zIndex: 960, display: "flex", flexDirection: "column", fontFamily: "monospace", animation: "nbslide-in 0.18s ease" }}>
            <div style={{ padding: "12px 14px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Saved Videos</span>
              <button onClick={() => setSavedVideosOpen(false)} style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15 }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
              {savedVideosLoading && <div style={{ fontSize: 11, color: "#6a6a6a", textAlign: "center", paddingTop: 32 }}>Loading…</div>}
              {savedVideosError && !savedVideosLoading && (
                <div style={{ fontSize: 11, color: "#ff3a3a", textAlign: "center", paddingTop: 32 }}>
                  {savedVideosError}
                  <button onClick={fetchLibrary} style={{ ...miniButton, display: "block", margin: "10px auto 0", fontSize: 11, padding: "4px 12px" }}>Retry</button>
                </div>
              )}
              {!savedVideosLoading && !savedVideosError && savedVideos.length === 0 && (
                <div style={{ fontSize: 11, color: "#6a6a6a", textAlign: "center", paddingTop: 40, lineHeight: 1.7 }}>No saved videos yet.<br />Add a YouTube clip to start your library.</div>
              )}
              {!savedVideosLoading && !savedVideosError && savedVideos.map((v) => (
                <div key={v.id} onClick={() => openFromLibrary(v)}
                  style={{ display: "flex", gap: 8, padding: "9px 0", borderBottom: "1px solid rgba(42,42,42,0.1)", cursor: "pointer", alignItems: "flex-start" }}>
                  <div style={{ flexShrink: 0, width: 72, height: 40, background: "#000", overflow: "hidden", border: "1px solid rgba(42,42,42,0.2)" }}>
                    {v.thumbnail_url && <img src={v.thumbnail_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>{v.title || "(no title)"}</div>
                    {v.duration_seconds > 0 && <div style={{ fontSize: 9, color: "#6a6a6a", marginTop: 3 }}>{formatDuration(v.duration_seconds)}</div>}
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); deleteLibraryEntry(v.id); }}
                    style={{ ...miniButton, flexShrink: 0, alignSelf: "center", padding: "2px 6px", fontSize: 14, lineHeight: 1 }} title="Remove from library">×</button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 60, left: "50%", transform: "translateX(-50%)", background: "#2a2a2a", color: "#fffdf5", padding: "7px 18px", fontSize: 11, fontFamily: "monospace", zIndex: 9999, animation: "nbtoast 0.2s ease", whiteSpace: "nowrap" }}>
          {toast}
        </div>
      )}
    </main>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Courier New', Courier, monospace",
  backgroundColor: "#f5ecd8",
  backgroundImage: "linear-gradient(rgba(160,130,80,.12) 1px, transparent 1px), linear-gradient(90deg, rgba(160,130,80,.12) 1px, transparent 1px)",
  backgroundSize: "22px 22px",
  color: "#2a2a2a",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 22px",
  borderBottom: "1.5px dashed #2a2a2a",
  background: "rgba(245,236,216,0.85)",
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

const primaryButtonStyle: React.CSSProperties = {
  ...sketchButton,
  width: "100%",
  background: "#c8f135",
  padding: 14,
  fontSize: 14,
};

const miniButton: React.CSSProperties = {
  fontFamily: "monospace",
  background: "transparent",
  border: "1px solid #2a2a2a",
  padding: "2px 6px",
  cursor: "pointer",
  fontSize: 10,
};
