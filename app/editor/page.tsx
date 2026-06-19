"use client";

import { useState, useRef, useEffect } from "react";
import { useSession, signIn } from "next-auth/react";

const PX_PER_SEC = 100;
const IMAGE_DEFAULT_DURATION = 3;
const RULER_H = 30;
const LAYER_H = 56;
const NUM_LAYERS = 5;
const HANDLE_W = 6;
const MIN_DURATION = 0.5;
const SNAP = 0.1;
const CURVE_H = 12;
const MAX_EXPORT_DURATION = 90;
const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 4;
const MASTER_PLAYBACK_RATE = 1;
const LAYER_LABELS = ["Layer 1", "Layer 2", "Layer 3", "Layer 4", "Layer 5"];
const LAYER_BG = [
  "rgba(255,253,245,0.55)",
  "rgba(228,238,255,0.40)",
  "rgba(255,253,245,0.55)",
  "rgba(228,238,255,0.40)",
  "rgba(255,253,245,0.55)",
];

type ClipType = "audio" | "video" | "image";
type ClipTransform = { x: number; y: number; scaleX: number; scaleY: number };
type CurvePoint = { time: number; volume: number };

type Clip = {
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
  removeGreenScreen?: boolean;
  chromaSimilarity?: number;
  chromaSmoothness?: number;
  chromaAmount?: number;
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

const DEFAULT_TRANSFORM: ClipTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const DEFAULT_CURVE: CurvePoint[] = [{ time: 0, volume: 100 }];
const DEFAULT_CHROMA_SIMILARITY = 0.42;
const DEFAULT_CHROMA_SMOOTHNESS = 0.08;
const DEFAULT_CHROMA_AMOUNT = 0.55;

type PreviewDragKind = 'move' | 'corner-nw' | 'corner-ne' | 'corner-sw' | 'corner-se';
type PreviewDragState = {
  kind: PreviewDragKind;
  clipId: string;
  startMouseX: number;
  startMouseY: number;
  origX: number;
  origY: number;
  origScaleX: number;
  origScaleY: number;
  containerW: number;
  containerH: number;
} | null;

type YtSearchResult = {
  id: string;
  title: string;
  channel: string;
  duration: string | number;
  thumbnail: string;
};
type YtModalView = "search" | "trim";

type AudioEntry =
  | { kind: "element"; elem: HTMLMediaElement; source: MediaElementAudioSourceNode; gainNode: GainNode }
  | { kind: "buffer"; bufNode: AudioBufferSourceNode; gainNode: GainNode };

type CurveDragState = {
  clipId: string;
  pointIdx: number;
  startX: number;
  startY: number;
  origTime: number;
  origVolume: number;
  clipDuration: number;
  svgLeft: number;
  svgWidth: number;
  svgTop: number;
  svgHeight: number;
} | null;

const snapTo = (t: number) => Math.round(t / SNAP) * SNAP;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function clipsOverlap(s1: number, d1: number, s2: number, d2: number): boolean {
  return s1 < s2 + d2 - 0.001 && s1 + d1 > s2 + 0.001;
}

function findFreeLayer(existing: Clip[], startTime: number, duration: number): number {
  for (let l = 1; l <= NUM_LAYERS; l++) {
    if (!existing.some((c) => c.layer === l && clipsOverlap(startTime, duration, c.startTime, c.durationSec))) {
      return l;
    }
  }
  return 1;
}

function findFreeLayerOrNull(existing: Clip[], startTime: number, duration: number): number | null {
  for (let l = 1; l <= NUM_LAYERS; l++) {
    if (!existing.some((c) => c.layer === l && clipsOverlap(startTime, duration, c.startTime, c.durationSec))) {
      return l;
    }
  }
  return null;
}

function clipPlaybackRate(clip: Pick<Clip, "playbackRate">): number {
  return clamp(clip.playbackRate || 1, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
}

function mediaPlaybackRate(clip: Pick<Clip, "playbackRate">): number {
  return clipPlaybackRate(clip) * MASTER_PLAYBACK_RATE;
}

function clipSourceSpan(clip: Pick<Clip, "durationSec" | "playbackRate" | "sourceDuration" | "trimStart">): number {
  const available = Math.max(0, clip.sourceDuration - clip.trimStart);
  return Math.min(available, Math.max(0, clip.durationSec * clipPlaybackRate(clip)));
}

function clipSourceTimeAtTimeline(clip: Pick<Clip, "trimStart" | "startTime" | "durationSec" | "playbackRate" | "sourceDuration">, timelineSec: number): number {
  const sourceOffset = Math.max(0, timelineSec - clip.startTime) * clipPlaybackRate(clip);
  const sourceEnd = clip.trimStart + clipSourceSpan(clip);
  return clamp(clip.trimStart + sourceOffset, clip.trimStart, sourceEnd);
}

function setElementPlaybackRate(elem: HTMLMediaElement, clip: Pick<Clip, "playbackRate">) {
  const rate = mediaPlaybackRate(clip);
  elem.playbackRate = rate;
  const pitchy = elem as HTMLMediaElement & { preservesPitch?: boolean; mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };
  pitchy.preservesPitch = false;
  pitchy.mozPreservesPitch = false;
  pitchy.webkitPreservesPitch = false;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

async function getMediaDuration(blobUrl: string, type: ClipType): Promise<number> {
  if (type === "image") return IMAGE_DEFAULT_DURATION;
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

const CLIP_COLORS: Record<ClipType, string> = {
  audio: "#c8f135",
  video: "#a0d8ef",
  image: "#f5c6a0",
};

function parseDurationSec(dur: string | number | undefined): number {
  if (typeof dur === "number") return dur > 0 ? dur : 600;
  if (!dur) return 600;
  const parts = dur.split(":").map(Number);
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  const asNum = Number(dur);
  return Number.isFinite(asNum) && asNum > 0 ? asNum : 600;
}

function parseTimestampSec(value: string): number | null {
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

function formatTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function interpolateVolume(curve: CurvePoint[], t: number): number {
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

function chromaSettings(clip: Clip) {
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

function applyGreenScreenToImageData(data: Uint8ClampedArray, similarity: number, smoothness: number, amount: number) {
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

function drawContainedRect(
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

function drawMaybeKeyedMedia(
  ctx: CanvasRenderingContext2D,
  media: HTMLVideoElement | HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  clip: Clip,
) {
  const settings = chromaSettings(clip);
  if (!settings.enabled) {
    ctx.drawImage(media, dx, dy, dw, dh);
    return;
  }

  const w = Math.max(1, Math.round(dw));
  const h = Math.max(1, Math.round(dh));
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const offCtx = off.getContext("2d", { willReadFrequently: true });
  if (!offCtx) {
    ctx.drawImage(media, dx, dy, dw, dh);
    return;
  }
  offCtx.drawImage(media, 0, 0, w, h);
  const frame = offCtx.getImageData(0, 0, w, h);
  applyGreenScreenToImageData(frame.data, settings.similarity, settings.smoothness, settings.amount);
  offCtx.putImageData(frame, 0, 0);
  ctx.drawImage(off, dx, dy, dw, dh);
}

export default function EditorPage() {
  const { data: session, status } = useSession();
  const [config, setConfig] = useState<{ railwayUrl: string; railwayPassword: string } | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [recError, setRecError] = useState("");
  const [recGrowingBar, setRecGrowingBar] = useState<{ startSec: number; layer: number; elapsedSec: number } | null>(null);
  const [ghost, setGhost] = useState<Ghost>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [outputFormat, setOutputFormat] = useState<'16:9' | '9:16'>('16:9');
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
  const ytRangeRef = useRef({ start: 0, end: 30 });

  const playheadDraggingRef = useRef(false);
  const dragRef = useRef<DragInfo | null>(null);
  const selectedClipIdRef = useRef<string | null>(null);
  useEffect(() => { selectedClipIdRef.current = selectedClipId; }, [selectedClipId]);
  const clipsRef = useRef<Clip[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recSecondsRef = useRef(0);
  const mediaUploadRef = useRef<HTMLInputElement | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const previewDragRef = useRef<PreviewDragState>(null);
  const curveDragRef = useRef<CurveDragState>(null);
  const exportCancelRef = useRef(false);
  const exportRafRef = useRef<number | null>(null);
  const isExportingRef = useRef(false);
  const isRecordingNarrationRef = useRef(false);
  const recStartSecRef = useRef(0);
  const recLayerRef = useRef(1);
  const recNarrationRafRef = useRef<number | null>(null);
  const recNarrationStartWallRef = useRef(0);

  // Playback
  const isPlayingRef = useRef(false);
  const playheadSecRef = useRef(0);
  const playStartWallRef = useRef(0);
  const playStartHeadRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Audio
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeAudioRef = useRef<Map<string, AudioEntry>>(new Map());

  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { playheadSecRef.current = playheadSec; }, [playheadSec]);
  useEffect(() => { recSecondsRef.current = recSeconds; }, [recSeconds]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  useEffect(() => {
    if (!session?.user?.email) return;
    fetch("/api/config").then((r) => r.json()).then((d) => setConfig(d)).catch(() => {});
    fetch("/api/usage/check").then((r) => r.json()).then((d) => setIsSubscribed(!!d.isSubscribed)).catch(() => {});
  }, [session?.user?.email]);

  // Spacebar + Delete
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (isRecordingNarrationRef.current) { stopRecording(); return; }
        if (isPlayingRef.current) { pausePlayback(); } else { startPlayback(); }
        return;
      }
      if (e.code === "Backspace" || e.code === "Delete") {
        const selId = selectedClipIdRef.current;
        if (selId) {
          e.preventDefault();
          setClips((prev) => prev.filter((c) => c.id !== selId));
          setSelectedClipId(null);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      pausePlayback();
      if (exportRafRef.current !== null) cancelAnimationFrame(exportRafRef.current);
      audioCtxRef.current?.close().catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalDuration = clips.length > 0
    ? Math.max(...clips.map((c) => c.startTime + c.durationSec))
    : 10;
  const timelineW = totalDuration * PX_PER_SEC + 200;
  const isDraggingClip = ghost !== null;

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

  function startAudioAt(atSec: number, currentClips: Clip[], extraDest?: AudioNode) {
    stopAllAudio();
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    currentClips.forEach((clip) => {
      if (clip.type === "image") return;
      if (clip.muted) return;
      if (atSec < clip.startTime || atSec >= clip.startTime + clip.durationSec) return;
      spawnClipAudio(clip, atSec - clip.startTime, ctx, extraDest);
    });
  }

  function spawnClipAudio(clip: Clip, clipOffset: number, ctx: AudioContext, extraDest?: AudioNode) {
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
        })
        .catch(() => {});
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

  function tickAudio(atSec: number, currentClips: Clip[], extraDest?: AudioNode) {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    activeAudioRef.current.forEach((entry, clipId) => {
      const clip = currentClips.find((c) => c.id === clipId);
      if (!clip || atSec < clip.startTime || atSec >= clip.startTime + clip.durationSec) {
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
      if (clip.type === "image") return;
      if (clip.muted) return;
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
    const total = currentClips.length > 0
      ? Math.max(...currentClips.map((c) => c.startTime + c.durationSec))
      : 10;

    let startHead = playheadSecRef.current;
    if (startHead >= total) { startHead = 0; }

    playStartWallRef.current = performance.now();
    playStartHeadRef.current = startHead;
    isPlayingRef.current = true;
    setIsPlaying(true);
    setPlayheadSec(startHead);
    playheadSecRef.current = startHead;

    startAudioAt(startHead, currentClips);

    function tick() {
      if (!isPlayingRef.current) return;
      const elapsed = (performance.now() - playStartWallRef.current) / 1000;
      const newHead = playStartHeadRef.current + elapsed;
      const clips = clipsRef.current;
      const total2 = clips.length > 0
        ? Math.max(...clips.map((c) => c.startTime + c.durationSec))
        : 10;

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
      tickAudio(newHead, clips);
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
  }

  function pausePlayback() {
    isPlayingRef.current = false;
    setIsPlaying(false);
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    stopAllAudio();
  }

  function stopAndRewind() {
    pausePlayback();
    setPlayheadSec(0);
    playheadSecRef.current = 0;
  }

  // ─── Seeking ────────────────────────────────────────────────────────────────

  function seekTo(newSec: number) {
    const clamped = Math.max(0, Math.min(totalDuration, newSec));
    setPlayheadSec(clamped);
    playheadSecRef.current = clamped;
    if (isPlayingRef.current) {
      playStartWallRef.current = performance.now();
      playStartHeadRef.current = clamped;
      startAudioAt(clamped, clipsRef.current);
    }
  }

  function seekFromClientX(clientX: number) {
    const el = scrollerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    seekTo(x / PX_PER_SEC);
  }

  // ─── Timeline pointer handlers ──────────────────────────────────────────────

  function onScrollerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current) return;
    playheadDraggingRef.current = true;
    setSelectedClipId(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  }

  function onScrollerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current) { updateClipDrag(e.clientX, e.clientY); return; }
    if (playheadDraggingRef.current) seekFromClientX(e.clientX);
  }

  function onScrollerPointerUp() {
    if (dragRef.current) { commitClipDrag(); return; }
    playheadDraggingRef.current = false;
  }

  function onClipPointerDown(e: React.PointerEvent<HTMLDivElement>, clip: Clip) {
    e.stopPropagation();
    setSelectedClipId(clip.id);
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
    const dtSec = dx / PX_PER_SEC;
    const yInLayers = clientY - rect.top - RULER_H;
    const hoverLayer = Math.min(NUM_LAYERS, Math.max(1, Math.floor(yInLayers / LAYER_H) + 1));
    let newStart = drag.validStartTime;
    let newDur = drag.validDuration;
    let newLayer = drag.validLayer;
    const src = clipsRef.current.find((c) => c.id === drag.clipId)!;
    const rate = clipPlaybackRate(src);
    if (drag.kind === "move") {
      newStart = snapTo(Math.max(0, drag.origStartTime + dtSec));
      newLayer = hoverLayer;
    } else if (drag.kind === "resize-left") {
      const minStart = Math.max(0, drag.origStartTime - drag.origTrimStart / rate);
      const maxStart = drag.origStartTime + drag.origDuration - MIN_DURATION;
      newStart = snapTo(clamp(drag.origStartTime + dtSec, minStart, maxStart));
      const sourceDelta = (newStart - drag.origStartTime) * rate;
      drag.validTrimStart = clamp(drag.origTrimStart + sourceDelta, 0, src.sourceDuration);
      newDur = Math.max(MIN_DURATION, (drag.origTrimStart + drag.origDuration * rate - drag.validTrimStart) / rate);
      newLayer = drag.origLayer;
    } else {
      const maxTimelineDur = Math.max(MIN_DURATION, (src.sourceDuration - drag.origTrimStart) / rate);
      newDur = clamp(snapTo(Math.max(MIN_DURATION, drag.origDuration + dtSec)), MIN_DURATION, maxTimelineDur);
      newStart = drag.origStartTime;
      newLayer = drag.origLayer;
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
  }

  function commitClipDrag() {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setGhost(null);
    setClips((prev) =>
      prev.map((c) =>
        c.id === drag.clipId
          ? { ...c, startTime: drag.validStartTime, durationSec: drag.validDuration, layer: drag.validLayer, trimStart: drag.validTrimStart }
          : c
      )
    );
  }

  // ─── Recording ──────────────────────────────────────────────────────────────

  async function startRecording() {
    setRecError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      // Capture start position and pick layer before playback advances
      const startSec = playheadSecRef.current;
      recStartSecRef.current = startSec;
      const layer = findFreeLayer(clipsRef.current, startSec, 9999);
      recLayerRef.current = layer;

      // Mute all clip audio and start visual-only playback
      isRecordingNarrationRef.current = true;
      startPlayback();

      // Start growing bar animation
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
        const dur = durationSec || recSecondsRef.current;
        if (dur < 0.1) return;
        setClips((prev) => {
          const startTime = recStartSecRef.current;
          return [...prev, { id: crypto.randomUUID(), type: "audio", name: "Narration", blobUrl, sourceDuration: dur, durationSec: dur, startTime, layer: recLayerRef.current, trimStart: 0, playbackRate: 1, transform: DEFAULT_TRANSFORM, muted: false, volumeCurve: [...DEFAULT_CURVE] }];
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
        return { type, name: file.name, blobUrl, durationSec: await getMediaDuration(blobUrl, type) };
      })
    );
    const valid = processed.filter((x): x is NonNullable<typeof x> => x !== null);
    if (!valid.length) return;
    setClips((prev) => {
      const startTime = playheadSecRef.current;
      const newClips: Clip[] = [];
      for (const item of valid) {
        const dur = item.durationSec || (item.type === "image" ? IMAGE_DEFAULT_DURATION : 5);
        const layer = findFreeLayer([...prev, ...newClips], startTime, dur);
        newClips.push({ id: crypto.randomUUID(), type: item.type, name: item.name, blobUrl: item.blobUrl, sourceDuration: dur, durationSec: dur, startTime, layer, trimStart: 0, playbackRate: 1, transform: DEFAULT_TRANSFORM, muted: false, volumeCurve: [...DEFAULT_CURVE] });
      }
      return [...prev, ...newClips];
    });
    e.target.value = "";
  }

  // ─── YouTube ────────────────────────────────────────────────────────────────

  async function handleYtSearch(shortsOnlyOverride?: boolean) {
    if (!config?.railwayUrl || !ytQuery.trim()) return;
    setYtLoading(true);
    setYtError("");
    setYtResults([]);
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
    } finally {
      setYtLoading(false);
    }
  }

  async function handleYtConfirm() {
    if (!config?.railwayUrl || !ytSelected) return;
    setYtLoading(true);
    setYtError("");
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
      setClips((prev) => {
        const startTime = playheadSecRef.current;
        const dur = durationSec || (ytEnd - ytStart);
        return [...prev, { id: crypto.randomUUID(), type: "video", name: title, blobUrl, sourceDuration: dur, durationSec: dur, startTime, layer: findFreeLayer(prev, startTime, dur), trimStart: 0, playbackRate: 1, transform: DEFAULT_TRANSFORM, muted: false, volumeCurve: [...DEFAULT_CURVE] }];
      });
      setYtModalOpen(false);
      setYtView("search");
      setYtSelected(null);
      setYtResults([]);
      setYtQuery("");
    } catch (e) {
      setYtError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setYtLoading(false);
    }
  }

  // ─── Preview ─────────────────────────────────────────────────────────────────

  const activeVisualClips = clips
    .filter(
      (c) => (c.type === "video" || c.type === "image") &&
        playheadSec >= c.startTime && playheadSec < c.startTime + c.durationSec
    )
    .sort((a, b) => b.layer - a.layer);

  // ─── Split ───────────────────────────────────────────────────────────────────

  function splitAtPlayhead() {
    const t = playheadSecRef.current;
    const clip = clipsRef.current.find(
      (c) => t > c.startTime + 0.05 && t < c.startTime + c.durationSec - 0.05
    );
    if (!clip) return;
    const leftDur = t - clip.startTime;
    const rightDur = clip.durationSec - leftDur;
    const rate = clipPlaybackRate(clip);

    const sorted = clip.volumeCurve.slice().sort((a, b) => a.time - b.time);
    const volAtSplit = Math.round(interpolateVolume(sorted, leftDur) * 100);
    const leftCurve: CurvePoint[] = [
      ...sorted.filter(p => p.time < leftDur),
      { time: leftDur, volume: volAtSplit },
    ];
    const rightCurve: CurvePoint[] = [
      { time: 0, volume: volAtSplit },
      ...sorted.filter(p => p.time > leftDur).map(p => ({ time: p.time - leftDur, volume: p.volume })),
    ];

    const leftClip: Clip = { ...clip, id: crypto.randomUUID(), durationSec: leftDur, volumeCurve: leftCurve.length ? leftCurve : [...DEFAULT_CURVE] };
    const rightClip: Clip = { ...clip, id: crypto.randomUUID(), startTime: t, durationSec: rightDur, trimStart: clip.trimStart + leftDur * rate, volumeCurve: rightCurve.length ? rightCurve : [...DEFAULT_CURVE] };
    setClips((prev) => prev.filter((c) => c.id !== clip.id).concat([leftClip, rightClip]));
  }

  // ─── Preview transform drag ──────────────────────────────────────────────────

  function onPreviewPointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    clip: Clip,
    kind: PreviewDragKind,
  ) {
    e.stopPropagation();
    const container = previewContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const t = clip.transform;
    previewDragRef.current = {
      kind,
      clipId: clip.id,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      origX: t.x,
      origY: t.y,
      origScaleX: t.scaleX,
      origScaleY: t.scaleY,
      containerW: rect.width,
      containerH: rect.height,
    };
    container.setPointerCapture(e.pointerId);
  }

  function onPreviewPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = previewDragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startMouseX;
    const dy = e.clientY - drag.startMouseY;
    const dxPct = (dx / drag.containerW) * 100;
    const dyPct = (dy / drag.containerH) * 100;
    const dxScale = dx / drag.containerW;
    const dyScale = dy / drag.containerH;
    let newX = drag.origX;
    let newY = drag.origY;
    let newSX = drag.origScaleX;
    let newSY = drag.origScaleY;
    if (drag.kind === 'move') {
      newX = drag.origX + dxPct;
      newY = drag.origY + dyPct;
    } else if (drag.kind === 'corner-se') {
      newSX = drag.origScaleX + dxScale;
      newSY = drag.origScaleY + dyScale;
    } else if (drag.kind === 'corner-nw') {
      newX = drag.origX + dxPct;
      newY = drag.origY + dyPct;
      newSX = drag.origScaleX - dxScale;
      newSY = drag.origScaleY - dyScale;
    } else if (drag.kind === 'corner-ne') {
      newY = drag.origY + dyPct;
      newSX = drag.origScaleX + dxScale;
      newSY = drag.origScaleY - dyScale;
    } else if (drag.kind === 'corner-sw') {
      newX = drag.origX + dxPct;
      newSX = drag.origScaleX - dxScale;
      newSY = drag.origScaleY + dyScale;
    }
    newSX = Math.max(0.05, Math.min(3, newSX));
    newSY = Math.max(0.05, Math.min(3, newSY));
    newX = Math.max(-150, Math.min(150, newX));
    newY = Math.max(-150, Math.min(150, newY));
    setClips((prev) =>
      prev.map((c) =>
        c.id === drag.clipId
          ? { ...c, transform: { x: newX, y: newY, scaleX: newSX, scaleY: newSY } }
          : c
      )
    );
  }

  function onPreviewPointerUp() {
    previewDragRef.current = null;
  }

  function updateClipPlaybackRate(clipId: string, nextRate: number) {
    const playbackRate = clamp(nextRate, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
    setClips((prev) => {
      const target = prev.find((c) => c.id === clipId);
      if (!target) return prev;
      const oldRate = clipPlaybackRate(target);
      const availableSource = Math.max(0, target.sourceDuration - target.trimStart);
      const sourceSpan = Math.min(
        availableSource,
        Math.max(MIN_DURATION * oldRate, target.durationSec * oldRate),
      );
      let durationSec = Math.max(MIN_DURATION, sourceSpan / playbackRate);
      const others = prev.filter((c) => c.id !== clipId);
      let layer = target.layer;
      if (others.some((c) => c.layer === target.layer && clipsOverlap(target.startTime, durationSec, c.startTime, c.durationSec))) {
        const freeLayer = findFreeLayerOrNull(others, target.startTime, durationSec);
        if (freeLayer) {
          layer = freeLayer;
        } else {
          const nextClipStart = others
            .filter((c) => c.layer === target.layer && c.startTime >= target.startTime)
            .reduce((min, c) => Math.min(min, c.startTime), Infinity);
          if (Number.isFinite(nextClipStart)) {
            durationSec = Math.max(MIN_DURATION, nextClipStart - target.startTime);
          }
        }
      }

      return prev.map((c) =>
        c.id === clipId
          ? { ...c, playbackRate, durationSec, layer }
          : c
      );
    });
  }

  // ─── Export ──────────────────────────────────────────────────────────────────

  function cancelExport() {
    exportCancelRef.current = true;
  }

  async function startExport() {
    if (isRecordingNarrationRef.current) {
      alert("Stop recording before exporting");
      return;
    }
    const currentClips = clipsRef.current;
    if (currentClips.length === 0) {
      alert("No clips to export");
      return;
    }

    if (isPlayingRef.current) pausePlayback();
    setIsExporting(true);
    isExportingRef.current = true;
    exportCancelRef.current = false;
    setExportProgress(0);

    const sourceTotalDur = Math.max(...currentClips.map((c) => c.startTime + c.durationSec));
    const totalDur = Math.min(MAX_EXPORT_DURATION, sourceTotalDur);
    setExportDurationSec(totalDur);
    const [canvasW, canvasH] = outputFormat === '16:9' ? [1280, 720] : [720, 1280];

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx2d = canvas.getContext("2d")!;

    // Load video elements for canvas rendering (muted — audio handled by Web Audio)
    const exportVideoEls = new Map<string, HTMLVideoElement>();
    for (const clip of currentClips) {
      if (clip.type !== "video") continue;
      const vid = document.createElement("video");
      vid.src = clip.blobUrl;
      vid.muted = true;
      vid.preload = "auto";
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
    await Promise.all(
      currentClips.filter((c) => c.type === "image").map((clip) =>
        new Promise<void>((res) => {
          const img = new Image();
          img.onload = () => { exportImageEls.set(clip.id, img); res(); };
          img.onerror = () => res();
          img.src = clip.blobUrl;
        })
      )
    );

    const audioCtx = getAudioCtx();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const exportAudioDest = audioCtx.createMediaStreamDestination();

    const canvasStream = canvas.captureStream(30);
    const combined = new MediaStream([
      ...canvasStream.getVideoTracks(),
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
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setIsExporting(false);
      isExportingRef.current = false;
      setExportProgress(0);
      setExportDurationSec(0);
    };

    // Seed audio at t=0
    startAudioAt(0, currentClips, exportAudioDest);

    // Seed video elements that are active at t=0
    for (const [clipId, vid] of exportVideoEls) {
      const clip = currentClips.find((c) => c.id === clipId)!;
      if (clip.startTime === 0) {
        setElementPlaybackRate(vid, clip);
        vid.currentTime = clipSourceTimeAtTimeline(clip, 0);
        vid.play().catch(() => {});
      }
    }

    recorder.start(100); // collect data every 100ms

    const exportWallStart = performance.now();

    function exportFrame() {
      if (exportCancelRef.current) {
        stopAllAudio();
        for (const vid of exportVideoEls.values()) vid.pause();
        recorder.stop();
        setIsExporting(false);
        isExportingRef.current = false;
        setExportProgress(0);
        setExportDurationSec(0);
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

      // Manage audio (gain updates + clip lifecycle)
      tickAudio(elapsed, currentClips, exportAudioDest);

      // Manage video element lifecycle
      for (const [clipId, vid] of exportVideoEls) {
        const clip = currentClips.find((c) => c.id === clipId)!;
        const isActive = elapsed >= clip.startTime && elapsed < clip.startTime + clip.durationSec;
        setElementPlaybackRate(vid, clip);
        if (isActive && vid.paused) {
          vid.currentTime = clipSourceTimeAtTimeline(clip, elapsed);
          vid.play().catch(() => {});
        } else if (!isActive && !vid.paused) {
          vid.pause();
        }
      }

      // Draw frame
      ctx2d.fillStyle = "#111";
      ctx2d.fillRect(0, 0, canvasW, canvasH);

      const visClips = currentClips
        .filter((c) => (c.type === "video" || c.type === "image") &&
          elapsed >= c.startTime && elapsed < c.startTime + c.durationSec)
        .sort((a, b) => b.layer - a.layer); // layer 5 first (bg), layer 1 last (fg)

      for (const clip of visClips) {
        let el: HTMLVideoElement | HTMLImageElement | null = null;
        if (clip.type === "video") el = exportVideoEls.get(clip.id) ?? null;
        else if (clip.type === "image") el = exportImageEls.get(clip.id) ?? null;
        if (!el) continue;

        const tr = clip.transform;
        const x = (tr.x / 100) * canvasW;
        const y = (tr.y / 100) * canvasH;
        const w = tr.scaleX * canvasW;
        const h = tr.scaleY * canvasH;

        const mW = el instanceof HTMLVideoElement ? el.videoWidth : (el as HTMLImageElement).naturalWidth;
        const mH = el instanceof HTMLVideoElement ? el.videoHeight : (el as HTMLImageElement).naturalHeight;

        if (mW > 0 && mH > 0) {
          const rect = drawContainedRect(mW, mH, x, y, w, h);
          drawMaybeKeyedMedia(ctx2d, el, rect.x, rect.y, rect.w, rect.h, clip);
        } else {
          drawMaybeKeyedMedia(ctx2d, el, x, y, w, h, clip);
        }
      }

      exportRafRef.current = requestAnimationFrame(exportFrame);
    }

    exportRafRef.current = requestAnimationFrame(exportFrame);
  }

  // ─── Auth gates ──────────────────────────────────────────────────────────────

  if (status === "loading") {
    return (
      <main style={lockScreenStyle}>
        <div style={{ fontFamily: "monospace", color: "#6a6a6a", fontSize: 13 }}>Loading...</div>
      </main>
    );
  }

  if (!session?.user) {
    return (
      <main style={lockScreenStyle}>
        <div style={{ maxWidth: 360, width: "100%" }}>
          <h1 style={{ fontFamily: "'Caveat', cursive", fontSize: 38, color: "#2a2a2a", textAlign: "center", marginBottom: 4 }}>Neural Board</h1>
          <p style={{ fontSize: 12, color: "#6a6a6a", textAlign: "center", marginBottom: 24, fontFamily: "'Courier New', monospace" }}>sign in to continue</p>
          <button onClick={() => signIn("google")} style={primaryButtonStyle}>Sign in with Google</button>
        </div>
      </main>
    );
  }

  const playheadX = playheadSec * PX_PER_SEC;

  return (
    <main style={pageStyle}>
      <style>{`@keyframes nbpulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      {/* Header */}
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: "#2a2a2a" }}>Neural Board</span>
          <span style={{ fontSize: 11, color: "#6a6a6a", letterSpacing: 1, fontFamily: "monospace" }}>/ EDITOR</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>{session.user.email}</span>
        </div>
      </header>

      {/* Top workspace */}
      <div style={{ display: "flex", borderBottom: "1.5px solid rgba(42,42,42,0.15)", background: "rgba(255,253,245,0.5)" }}>

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
            <button
              onClick={() => { setYtModalOpen(true); setYtView("search"); setYtQuery(""); setYtResults([]); setYtError(""); }}
              style={sketchButton}
            >
              ▶ Add YouTube clip
            </button>
          )}
          {recError && <span style={{ fontSize: 10, color: "#ff5e3a", fontFamily: "monospace" }}>{recError}</span>}
        </div>

        {/* Preview */}
        <div style={{ flex: 1, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", letterSpacing: 1, textTransform: "uppercase" }}>Preview</div>
          <div style={{ display: "flex", gap: 0, marginBottom: 2 }}>
            {(['16:9', '9:16'] as const).map((fmt) => (
              <button
                key={fmt}
                onClick={() => setOutputFormat(fmt)}
                style={{ ...miniButton, fontSize: 10, padding: "3px 8px", background: outputFormat === fmt ? "#2a2a2a" : "transparent", color: outputFormat === fmt ? "#fffdf5" : "#2a2a2a" }}
              >
                {fmt === '16:9' ? '16:9 (Long)' : '9:16 (Short)'}
              </button>
            ))}
          </div>
          <div style={{
            width: outputFormat === '16:9' ? 400 : 127,
            aspectRatio: outputFormat === '16:9' ? '16/9' : '9/16',
            background: "#111",
            border: "1.5px solid #2a2a2a",
            boxShadow: "3px 3px 0 #2a2a2a",
            overflow: "hidden",
            flexShrink: 0,
            position: "relative",
          }}>
            {activeVisualClips.length === 0 && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                <span style={{ fontSize: 10, fontFamily: "monospace", color: "#555" }}>no video at playhead</span>
              </div>
            )}
            <div
              ref={previewContainerRef}
              style={{ position: "absolute", inset: 0 }}
              onPointerMove={onPreviewPointerMove}
              onPointerUp={onPreviewPointerUp}
              onPointerCancel={onPreviewPointerUp}
            >
              {activeVisualClips.map((clip) => {
                const t = clip.transform;
                const isSelected = selectedClipId === clip.id;
                return (
                  <div
                    key={clip.id}
                    style={{
                      position: "absolute",
                      left: `${t.x}%`,
                      top: `${t.y}%`,
                      width: `${t.scaleX * 100}%`,
                      height: `${t.scaleY * 100}%`,
                      zIndex: NUM_LAYERS + 1 - clip.layer,
                      cursor: isSelected ? "move" : "default",
                    }}
                    onPointerDown={isSelected ? (e) => { e.stopPropagation(); onPreviewPointerDown(e, clip, "move"); } : undefined}
                  >
                    {clip.type === "image" ? (
                      <img src={clip.blobUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }} />
                    ) : clip.removeGreenScreen ? (
                      <KeyedPreviewVideo clip={clip} playheadSec={playheadSec} isPlaying={isPlaying} />
                    ) : (
                      <PreviewVideo clip={clip} playheadSec={playheadSec} isPlaying={isPlaying} />
                    )}
                    {isSelected && (
                      <>
                        <div style={{ position: "absolute", inset: 0, border: "1.5px solid #ff5e3a", pointerEvents: "none", zIndex: 1 }} />
                        {(["nw", "ne", "sw", "se"] as const).map((corner) => {
                          const kind = `corner-${corner}` as PreviewDragKind;
                          return (
                            <div
                              key={corner}
                              onPointerDown={(e) => { e.stopPropagation(); onPreviewPointerDown(e, clip, kind); }}
                              style={{
                                position: "absolute",
                                width: 10,
                                height: 10,
                                background: "#ff5e3a",
                                border: "1px solid #fff",
                                zIndex: 2,
                                cursor: `${corner}-resize`,
                                ...(corner === "nw" ? { top: -5, left: -5 } :
                                    corner === "ne" ? { top: -5, right: -5 } :
                                    corner === "sw" ? { bottom: -5, left: -5 } :
                                                      { bottom: -5, right: -5 }),
                              }}
                            />
                          );
                        })}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Transport */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderBottom: "1.5px solid rgba(42,42,42,0.15)", background: "rgba(255,253,245,0.85)", flexWrap: "wrap" }}>
        <button
          onClick={() => isPlaying ? pausePlayback() : startPlayback()}
          disabled={isExporting}
          style={{ ...sketchButton, width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, background: isPlaying ? "#ff5e3a" : "#c8f135", opacity: isExporting ? 0.4 : 1 }}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
        <button
          onClick={stopAndRewind}
          disabled={isExporting}
          style={{ ...sketchButton, width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, opacity: isExporting ? 0.4 : 1 }}
          title="Stop and rewind"
        >
          ⏹
        </button>
        <span style={{ fontFamily: "'Courier New', monospace", fontSize: 14, color: "#2a2a2a", letterSpacing: 2, border: "1.5px solid #2a2a2a", padding: "3px 10px", background: "#fffdf5", boxShadow: "2px 2px 0 #2a2a2a", minWidth: 96, textAlign: "center" }}>
          {formatTime(playheadSec)}
        </span>
        <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6a6a6a" }}>/ {formatTime(totalDuration)}</span>
        <button
          onClick={splitAtPlayhead}
          disabled={isExporting}
          style={{ ...sketchButton, height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, opacity: isExporting ? 0.4 : 1 }}
          title="Split clip at playhead"
        >
          ✂ Split
        </button>
        {(() => {
          const selClip = selectedClipId ? clips.find((c) => c.id === selectedClipId) : null;
          if (!selClip) return null;
          return (
            <>
              {selClip.type !== "image" && (
                <button
                  onClick={() => setClips((prev) => prev.map((c) => c.id === selClip.id ? { ...c, muted: !c.muted } : c))}
                  disabled={isExporting}
                  style={{ ...sketchButton, height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, background: selClip.muted ? "#ff5e3a" : undefined, color: selClip.muted ? "#fff" : undefined, opacity: isExporting ? 0.4 : 1 }}
                  title="Toggle mute for selected clip"
                >
                  {selClip.muted ? "Unmute" : "Mute"}
                </button>
              )}
              {selClip.type !== "image" && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, border: "1.5px solid #2a2a2a", background: "#fffdf5", padding: "4px 8px", boxShadow: "2px 2px 0 #2a2a2a" }}>
                  <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a" }}>speed</span>
                  <input
                    type="range"
                    min={MIN_PLAYBACK_RATE}
                    max={MAX_PLAYBACK_RATE}
                    step={0.05}
                    value={clipPlaybackRate(selClip)}
                    onChange={(e) => updateClipPlaybackRate(selClip.id, Number(e.target.value))}
                    disabled={isExporting}
                    style={{ width: 130 }}
                  />
                  <span style={{ minWidth: 42, fontSize: 10, fontFamily: "monospace", color: "#2a2a2a", fontWeight: 700 }}>
                    {clipPlaybackRate(selClip).toFixed(2)}x
                  </span>
                  <button
                    onClick={() => updateClipPlaybackRate(selClip.id, 1)}
                    disabled={isExporting}
                    style={{ ...miniButton, fontSize: 10, padding: "2px 7px", opacity: isExporting ? 0.4 : 1 }}
                    title="Reset speed"
                  >
                    Reset
                  </button>
                </div>
              )}
              {selClip.type === "video" && (
                <>
                  <button
                    onClick={() => setClips((prev) => prev.map((c) => c.id === selClip.id ? { ...c, removeGreenScreen: !c.removeGreenScreen } : c))}
                    disabled={isExporting}
                    style={{ ...sketchButton, height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, background: selClip.removeGreenScreen ? "#c8f135" : undefined, opacity: isExporting ? 0.4 : 1 }}
                    title="Remove green background from selected video"
                  >
                    Remove green
                  </button>
                  {selClip.removeGreenScreen && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, border: "1.5px solid #2a2a2a", background: "#fffdf5", padding: "4px 8px", boxShadow: "2px 2px 0 #2a2a2a", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a" }}>amount</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={selClip.chromaAmount ?? DEFAULT_CHROMA_AMOUNT}
                        onChange={(e) => setClips((prev) => prev.map((c) => c.id === selClip.id ? { ...c, chromaAmount: Number(e.target.value) } : c))}
                        style={{ width: 90 }}
                      />
                      <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a" }}>key</span>
                      <input
                        type="range"
                        min={0.18}
                        max={0.85}
                        step={0.01}
                        value={selClip.chromaSimilarity ?? DEFAULT_CHROMA_SIMILARITY}
                        onChange={(e) => setClips((prev) => prev.map((c) => c.id === selClip.id ? { ...c, chromaSimilarity: Number(e.target.value) } : c))}
                        style={{ width: 90 }}
                      />
                      <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a" }}>edge</span>
                      <input
                        type="range"
                        min={0.01}
                        max={0.25}
                        step={0.01}
                        value={selClip.chromaSmoothness ?? DEFAULT_CHROMA_SMOOTHNESS}
                        onChange={(e) => setClips((prev) => prev.map((c) => c.id === selClip.id ? { ...c, chromaSmoothness: Number(e.target.value) } : c))}
                        style={{ width: 70 }}
                      />
                    </div>
                  )}
                </>
              )}
            </>
          );
        })()}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
          {isExporting && (
            <span style={{ fontSize: 10, fontFamily: "monospace", color: "#ff5e3a" }}>
              {formatTime(exportProgress * (exportDurationSec || Math.min(totalDuration, MAX_EXPORT_DURATION)))} / {formatTime(exportDurationSec || Math.min(totalDuration, MAX_EXPORT_DURATION))}
            </span>
          )}
          <button
            onClick={isExporting ? cancelExport : startExport}
            style={{ ...sketchButton, height: 36, padding: "0 14px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, background: isExporting ? "#ff5e3a" : "#c8f135", color: isExporting ? "#fff" : "#2a2a2a" }}
            title={isExporting ? "Cancel export" : "Export to MP4"}
          >
            {isExporting ? `✕ Cancel (${Math.round(exportProgress * 100)}%)` : "⬇ Export"}
          </button>
        </div>
        <span style={{ fontSize: 9, fontFamily: "monospace", color: "#bbb" }}>[space] play/pause · [⌫] delete selected</span>
      </div>

      {/* Timeline */}
      <div
        ref={scrollerRef}
        onPointerDown={onScrollerPointerDown}
        onPointerMove={onScrollerPointerMove}
        onPointerUp={onScrollerPointerUp}
        onPointerCancel={onScrollerPointerUp}
        style={{ overflowX: "auto", overflowY: "hidden", cursor: isDraggingClip ? "grabbing" : "crosshair", userSelect: "none", position: "relative", flex: 1 }}
      >
        <div style={{ position: "relative", width: timelineW, minHeight: RULER_H + NUM_LAYERS * LAYER_H }}>

          {/* Ruler */}
          <div style={{ position: "relative", height: RULER_H, borderBottom: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.9)" }}>
            {Array.from({ length: Math.ceil(totalDuration) + 1 }, (_, i) => {
              const showLabel = i % 5 === 0;
              return (
                <div key={i} style={{ position: "absolute", left: i * PX_PER_SEC, top: 0, height: "100%", display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                  <div style={{ width: 1, background: "#2a2a2a", height: showLabel ? 14 : 7, marginTop: showLabel ? 4 : 12 }} />
                  {showLabel && <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", marginLeft: 3, lineHeight: 1 }}>{i}s</span>}
                </div>
              );
            })}
          </div>

          {/* Layers */}
          {LAYER_LABELS.map((label, idx) => {
            const layerNum = idx + 1;
            const layerClips = clips.filter((c) => c.layer === layerNum);
            const layerGhost = ghost?.layer === layerNum ? ghost : null;
            return (
              <div key={layerNum} style={{ position: "relative", height: LAYER_H, borderBottom: `1px solid rgba(42,42,42,${layerNum === NUM_LAYERS ? 0.3 : 0.1})`, background: LAYER_BG[idx] }}>
                <span style={{ position: "absolute", left: 6, top: "50%", transform: "translateY(-50%)", fontSize: 9, fontFamily: "monospace", color: "rgba(42,42,42,0.22)", letterSpacing: 0.5, textTransform: "uppercase", pointerEvents: "none", userSelect: "none", zIndex: 0 }}>
                  {label}
                </span>
                {layerClips.map((clip) => {
                  const isBeingDragged = ghost?.clipId === clip.id;
                  const clipPx = Math.max(HANDLE_W * 2 + 4, clip.durationSec * PX_PER_SEC - 2);
                  const showHandles = clipPx >= HANDLE_W * 3;
                  const sortedCurve = clip.volumeCurve.slice().sort((a, b) => a.time - b.time);
                  const linePoints = sortedCurve.map((pt) => {
                    const px = clipPx > 0 ? (pt.time / clip.durationSec) * clipPx : 0;
                    const py = CURVE_H - 2 - (pt.volume / 100) * (CURVE_H - 4);
                    return `${px},${py}`;
                  }).join(" ");
                  return (
                    <div
                      key={clip.id}
                      onPointerDown={(e) => onClipPointerDown(e, clip)}
                      style={{ position: "absolute", left: clip.startTime * PX_PER_SEC, top: 7, width: clipPx, height: LAYER_H - 14, background: CLIP_COLORS[clip.type], opacity: isBeingDragged ? 0.28 : 1, border: selectedClipId === clip.id ? "2px solid #ff5e3a" : "1.5px solid #2a2a2a", boxShadow: isBeingDragged ? "none" : selectedClipId === clip.id ? "0 0 0 2px #ff5e3a44, 2px 2px 0 #2a2a2a" : "2px 2px 0 #2a2a2a", cursor: isBeingDragged ? "grabbing" : "grab", display: "flex", alignItems: "center", overflow: "hidden", zIndex: 2 }}
                    >
                      {showHandles && <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.18)", cursor: "ew-resize" }} />}
                      <div style={{ paddingLeft: showHandles ? HANDLE_W + 4 : 5, paddingRight: showHandles ? HANDLE_W + 4 : 5, paddingBottom: CURVE_H, overflow: "hidden", flexGrow: 1, pointerEvents: "none" }}>
                        <div style={{ fontSize: 10, fontFamily: "'Courier New', monospace", fontWeight: 700, color: "#2a2a2a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{clip.name}</div>
                        <div style={{ fontSize: 9, fontFamily: "monospace", color: "#555", whiteSpace: "nowrap" }}>{formatDuration(clip.durationSec)}</div>
                      </div>
                      {showHandles && <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.18)", cursor: "ew-resize" }} />}
                      {/* Volume curve SVG — audio and video clips only */}
                      {clip.type !== "image" && (
                        <svg
                          style={{ position: "absolute", bottom: 0, left: 0, width: "100%", height: CURVE_H, overflow: "visible", zIndex: 4, cursor: "crosshair" }}
                          viewBox={`0 0 ${clipPx} ${CURVE_H}`}
                          preserveAspectRatio="none"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                            const svgX = e.clientX - rect.left;
                            const svgY = e.clientY - rect.top;
                            const time = Math.max(0, Math.min(clip.durationSec, (svgX / rect.width) * clip.durationSec));
                            const volume = Math.max(0, Math.min(100, Math.round(100 - (svgY / rect.height) * 100)));
                            setClips((prev) => prev.map((c) => c.id !== clip.id ? c : {
                              ...c,
                              volumeCurve: [...c.volumeCurve, { time, volume }].sort((a, b) => a.time - b.time),
                            }));
                          }}
                        >
                          {/* Background strip */}
                          <rect x={0} y={0} width={clipPx} height={CURVE_H} fill="rgba(0,0,0,0.08)" />
                          {/* Curve line */}
                          {sortedCurve.length > 1 && (
                            <polyline
                              points={linePoints}
                              fill="none"
                              stroke="rgba(0,0,0,0.5)"
                              strokeWidth={1.5}
                              pointerEvents="none"
                            />
                          )}
                          {/* Curve points */}
                          {clip.volumeCurve.map((pt, ptIdx) => {
                            const px = clipPx > 0 ? (pt.time / clip.durationSec) * clipPx : 0;
                            const py = CURVE_H - 2 - (pt.volume / 100) * (CURVE_H - 4);
                            return (
                              <circle
                                key={ptIdx}
                                cx={px}
                                cy={py}
                                r={3.5}
                                fill="rgba(0,0,0,0.7)"
                                stroke="#fffdf5"
                                strokeWidth={1}
                                style={{ cursor: "ns-resize" }}
                                onClick={(e) => e.stopPropagation()}
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  if (clip.volumeCurve.length <= 1) return;
                                  setClips((prev) => prev.map((c) => c.id !== clip.id ? c : {
                                    ...c,
                                    volumeCurve: c.volumeCurve.filter((_, i) => i !== ptIdx),
                                  }));
                                }}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  const svgEl = (e.currentTarget as SVGCircleElement).ownerSVGElement!;
                                  const rect = svgEl.getBoundingClientRect();
                                  (e.currentTarget as SVGCircleElement).setPointerCapture(e.pointerId);
                                  curveDragRef.current = {
                                    clipId: clip.id,
                                    pointIdx: ptIdx,
                                    startX: e.clientX,
                                    startY: e.clientY,
                                    origTime: pt.time,
                                    origVolume: pt.volume,
                                    clipDuration: clip.durationSec,
                                    svgLeft: rect.left,
                                    svgWidth: rect.width,
                                    svgTop: rect.top,
                                    svgHeight: rect.height,
                                  };
                                }}
                                onPointerMove={(e) => {
                                  const drag = curveDragRef.current;
                                  if (!drag || drag.clipId !== clip.id || drag.pointIdx !== ptIdx) return;
                                  const dx = e.clientX - drag.startX;
                                  const dy = e.clientY - drag.startY;
                                  const dt = (dx / drag.svgWidth) * drag.clipDuration;
                                  const dv = -(dy / drag.svgHeight) * 100;
                                  const newTime = Math.max(0, Math.min(drag.clipDuration, drag.origTime + dt));
                                  const newVolume = Math.max(0, Math.min(100, Math.round(drag.origVolume + dv)));
                                  setClips((prev) => prev.map((c) => c.id !== drag.clipId ? c : {
                                    ...c,
                                    volumeCurve: c.volumeCurve.map((p, i) => i === drag.pointIdx ? { time: newTime, volume: newVolume } : p),
                                  }));
                                }}
                                onPointerUp={() => {
                                  curveDragRef.current = null;
                                  setClips((prev) => prev.map((c) => c.id !== clip.id ? c : {
                                    ...c,
                                    volumeCurve: c.volumeCurve.slice().sort((a, b) => a.time - b.time),
                                  }));
                                }}
                              />
                            );
                          })}
                        </svg>
                      )}
                    </div>
                  );
                })}
                {layerGhost && (
                  <div style={{ position: "absolute", left: layerGhost.startTime * PX_PER_SEC, top: 5, width: Math.max(4, layerGhost.durationSec * PX_PER_SEC - 2), height: LAYER_H - 10, background: CLIP_COLORS[layerGhost.type], opacity: 0.6, border: "2px dashed #2a2a2a", boxShadow: "3px 3px 10px rgba(42,42,42,0.22)", pointerEvents: "none", zIndex: 6, transform: "scale(1.03)", transformOrigin: "center center" }} />
                )}
                {recGrowingBar?.layer === layerNum && (
                  <div style={{ position: "absolute", left: recGrowingBar.startSec * PX_PER_SEC, top: 7, width: Math.max(2, recGrowingBar.elapsedSec * PX_PER_SEC), height: LAYER_H - 14, background: "rgba(255,94,58,0.22)", border: "2px solid #ff5e3a", pointerEvents: "none", zIndex: 5, display: "flex", alignItems: "center", paddingLeft: 5, overflow: "hidden" }}>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: "#ff5e3a", fontWeight: 700, whiteSpace: "nowrap" }}>REC</span>
                  </div>
                )}
              </div>
            );
          })}

          {clips.length === 0 && (
            <div style={{ position: "absolute", left: "50%", top: RULER_H + (NUM_LAYERS * LAYER_H) / 2, transform: "translate(-50%, -50%)", fontSize: 11, fontFamily: "monospace", color: "#ccc", pointerEvents: "none", whiteSpace: "nowrap" }}>
              Record or upload to add clips
            </div>
          )}

          {/* Playhead */}
          <div style={{ position: "absolute", left: playheadX, top: 0, bottom: 0, width: 2, background: "#ff5e3a", zIndex: 10, pointerEvents: "none" }}>
            <div style={{ position: "absolute", top: 0, left: -5, width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "10px solid #ff5e3a" }} />
            {recording && recGrowingBar && (
              <div style={{ position: "absolute", top: 12, left: 5, fontSize: 9, fontFamily: "monospace", color: "#ff5e3a", background: "rgba(255,253,245,0.92)", padding: "1px 4px", borderRadius: 2, whiteSpace: "nowrap", border: "1px solid rgba(255,94,58,0.4)" }}>
                REC ● {formatDuration(recGrowingBar.elapsedSec)}
              </div>
            )}
          </div>

        </div>
      </div>

      {/* YouTube Modal */}
      {ytModalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setYtModalOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 640, maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", fontFamily: "monospace", overflow: "hidden" }}>

            <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>
                {ytView === "search" ? "▶ YOUTUBE SEARCH" : `▶ TRIM  —  ${(ytSelected?.title ?? "").slice(0, 45)}${(ytSelected?.title?.length ?? 0) > 45 ? "…" : ""}`}
              </span>
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
                          <button key={label}
                            onClick={() => { const v = label === "Shorts"; setYtShortsOnly(v); handleYtSearch(v); }}
                            style={{ ...miniButton, fontSize: 11, padding: "4px 8px", background: active ? "#2a2a2a" : "transparent", color: active ? "#fffdf5" : "#2a2a2a", marginRight: label === "Shorts" ? -1 : 0, position: "relative", zIndex: active ? 1 : 0 }}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <input
                      autoFocus
                      type="text"
                      value={ytQuery}
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
                          setYtSelected(r);
                          const maxSec = parseDurationSec(r.duration);
                          const initEnd = Math.min(30, maxSec);
                          setYtStart(0);
                          setYtStartInput("0:00");
                          setYtEnd(initEnd);
                          setYtEndInput(formatTimestamp(initEnd));
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
                            {r.duration != null ? (typeof r.duration === "number" ? `${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, "0")}` : r.duration) : ""}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {ytSelected && (() => {
                    const maxSec = parseDurationSec(ytSelected.duration);
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
                          setYtStart(newStart);
                          setYtStartInput(formatTimestamp(newStart));
                          if (curEnd - newStart > 30) {
                            const newEnd = newStart + 30;
                            ytRangeRef.current.end = newEnd;
                            setYtEnd(newEnd);
                            setYtEndInput(formatTimestamp(newEnd));
                          }
                        } else {
                          const curStart = ytRangeRef.current.start;
                          const newEnd = Math.max(curStart + 0.5, Math.min(maxSec, Math.min(clamped, curStart + 30)));
                          ytRangeRef.current.end = newEnd;
                          setYtEnd(newEnd);
                          setYtEndInput(formatTimestamp(newEnd));
                        }
                      };
                      const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                      window.addEventListener("mousemove", onMove);
                      window.addEventListener("mouseup", onUp);
                    };

                    return (
                      <div>
                        {/* YouTube embed */}
                        <div style={{ marginBottom: 14, background: "#000", lineHeight: 0 }}>
                          <iframe
                            src={`https://www.youtube.com/embed/${ytSelected.id}?start=${Math.floor(ytStart)}&autoplay=0`}
                            style={{ width: "100%", aspectRatio: "16/9", border: "none" }}
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                            allowFullScreen
                          />
                        </div>

                        {/* Dual-handle selection bar */}
                        <div
                          ref={ytSliderTrackRef}
                          style={{ position: "relative", height: 36, margin: "0 4px 14px", userSelect: "none" }}
                        >
                          <div style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: 0, right: 0, height: 8, background: "#d8d5c9", border: "1.5px solid #2a2a2a" }} />
                          <div style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: `${pctOf(ytStart)}%`, width: `${Math.max(0, pctOf(ytEnd) - pctOf(ytStart))}%`, height: 8, background: "#c8f135", borderTop: "1.5px solid #2a2a2a", borderBottom: "1.5px solid #2a2a2a" }} />
                          <div onMouseDown={handleSliderMouseDown("start")} style={{ position: "absolute", top: "50%", left: `${pctOf(ytStart)}%`, transform: "translate(-50%, -50%)", width: 12, height: 24, background: "#2a2a2a", cursor: "ew-resize", zIndex: 3 }} />
                          <div onMouseDown={handleSliderMouseDown("end")} style={{ position: "absolute", top: "50%", left: `${pctOf(ytEnd)}%`, transform: "translate(-50%, -50%)", width: 12, height: 24, background: "#2a2a2a", cursor: "ew-resize", zIndex: 3 }} />
                        </div>

                        {/* Start / End time inputs */}
                        <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 3 }}>Start</div>
                            <input
                              type="text"
                              value={ytStartInput}
                              placeholder="0:00"
                              onChange={(e) => {
                                setYtStartInput(e.target.value);
                                const p = parseTimestampSec(e.target.value);
                                if (p !== null) {
                                  const newStart = Math.max(0, Math.min(maxSec - 0.5, p));
                                  const curEnd = ytRangeRef.current.end;
                                  ytRangeRef.current.start = newStart;
                                  setYtStart(newStart);
                                  if (curEnd <= newStart + 0.5) {
                                    const newEnd = Math.min(newStart + 30, maxSec);
                                    ytRangeRef.current.end = newEnd;
                                    setYtEnd(newEnd);
                                    setYtEndInput(formatTimestamp(newEnd));
                                  } else if (curEnd - newStart > 30) {
                                    const newEnd = newStart + 30;
                                    ytRangeRef.current.end = newEnd;
                                    setYtEnd(newEnd);
                                    setYtEndInput(formatTimestamp(newEnd));
                                  }
                                }
                              }}
                              onBlur={() => setYtStartInput(formatTimestamp(ytStart))}
                              style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties}
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 3 }}>End</div>
                            <input
                              type="text"
                              value={ytEndInput}
                              placeholder="0:30"
                              onChange={(e) => {
                                setYtEndInput(e.target.value);
                                const p = parseTimestampSec(e.target.value);
                                if (p !== null) {
                                  const newEnd = Math.max(ytRangeRef.current.start + 0.5, Math.min(maxSec, Math.min(p, ytRangeRef.current.start + 30)));
                                  ytRangeRef.current.end = newEnd;
                                  setYtEnd(newEnd);
                                }
                              }}
                              onBlur={() => setYtEndInput(formatTimestamp(ytEnd))}
                              style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties}
                            />
                          </div>
                        </div>

                        {/* Clip length readout */}
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
                <button onClick={handleYtConfirm} disabled={ytLoading} style={{ ...miniButton, marginLeft: "auto", padding: "6px 18px", fontSize: 12, fontWeight: 700, background: "#c8f135", borderColor: "#2a2a2a", opacity: ytLoading ? 0.5 : 1 }}>
                  {ytLoading ? "downloading…" : "Add to timeline"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function PreviewVideo({ clip, playheadSec, isPlaying }: { clip: Clip; playheadSec: number; isPlaying: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  const sourceTime = (ph: number) => clipSourceTimeAtTimeline(clip, ph);
  const trimEndSrc = clip.trimStart + clipSourceSpan(clip);

  // Reinit when clip changes
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const offset = sourceTime(playheadSec);
    vid.src = clip.blobUrl;
    setElementPlaybackRate(vid, clip);
    vid.load();
    if (isPlayingRef.current) {
      vid.addEventListener("canplay", () => { setElementPlaybackRate(vid, clip); vid.currentTime = offset; vid.play().catch(() => {}); }, { once: true });
    } else {
      vid.addEventListener("loadedmetadata", () => { vid.currentTime = offset; }, { once: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, clip.blobUrl, clip.playbackRate]);

  // Enforce trim end during playback
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const onTimeUpdate = () => { if (vid.currentTime >= trimEndSrc) vid.pause(); };
    vid.addEventListener("timeupdate", onTimeUpdate);
    return () => vid.removeEventListener("timeupdate", onTimeUpdate);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimEndSrc]);

  // Play/pause transitions
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const offset = sourceTime(playheadSec);
    setElementPlaybackRate(vid, clip);
    if (isPlaying) {
      vid.currentTime = offset;
      vid.play().catch(() => {});
    } else {
      vid.pause();
      vid.currentTime = offset;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // Still-frame sync when scrubbing paused
  useEffect(() => {
    if (isPlayingRef.current) return;
    const vid = videoRef.current;
    if (!vid) return;
    vid.currentTime = sourceTime(playheadSec);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadSec]);

  return (
    <video
      ref={videoRef}
      muted
      playsInline
      preload="auto"
      style={{ width: "100%", height: "100%", objectFit: "contain" }}
    />
  );
}

function KeyedPreviewVideo({ clip, playheadSec, isPlaying }: { clip: Clip; playheadSec: number; isPlaying: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  const sourceTime = (ph: number) => clipSourceTimeAtTimeline(clip, ph);
  const trimEndSrc = clip.trimStart + clipSourceSpan(clip);

  function draw() {
    const vid = videoRef.current;
    const canvas = canvasRef.current;
    if (!vid || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.round(rect.width * dpr));
    const targetH = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const mediaW = vid.videoWidth;
    const mediaH = vid.videoHeight;
    if (mediaW > 0 && mediaH > 0 && vid.readyState >= 2) {
      const drawRect = drawContainedRect(mediaW, mediaH, 0, 0, rect.width, rect.height);
      drawMaybeKeyedMedia(ctx, vid, drawRect.x, drawRect.y, drawRect.w, drawRect.h, clip);
    }
  }

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const offset = sourceTime(playheadSec);
    vid.src = clip.blobUrl;
    setElementPlaybackRate(vid, clip);
    vid.load();
    const onReady = () => {
      setElementPlaybackRate(vid, clip);
      vid.currentTime = offset;
      if (isPlayingRef.current) vid.play().catch(() => {});
      draw();
    };
    vid.addEventListener("loadedmetadata", onReady, { once: true });
    vid.addEventListener("canplay", draw);
    return () => {
      vid.removeEventListener("canplay", draw);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, clip.blobUrl, clip.playbackRate]);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const onTimeUpdate = () => { if (vid.currentTime >= trimEndSrc) vid.pause(); };
    vid.addEventListener("timeupdate", onTimeUpdate);
    return () => vid.removeEventListener("timeupdate", onTimeUpdate);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimEndSrc]);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const offset = sourceTime(playheadSec);
    setElementPlaybackRate(vid, clip);
    if (isPlaying) {
      vid.currentTime = offset;
      vid.play().catch(() => {});
    } else {
      vid.pause();
      vid.currentTime = offset;
      vid.addEventListener("seeked", draw, { once: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  useEffect(() => {
    if (isPlayingRef.current) return;
    const vid = videoRef.current;
    if (!vid) return;
    vid.currentTime = sourceTime(playheadSec);
    vid.addEventListener("seeked", draw, { once: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadSec, clip.chromaSimilarity, clip.chromaSmoothness, clip.chromaAmount]);

  useEffect(() => {
    function tick() {
      draw();
      if (isPlayingRef.current) rafRef.current = requestAnimationFrame(tick);
    }
    if (isPlaying) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    } else if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      draw();
    }
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying, clip.chromaSimilarity, clip.chromaSmoothness, clip.chromaAmount]);

  return (
    <>
      <video ref={videoRef} muted playsInline preload="auto" style={{ display: "none" }} />
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", pointerEvents: "none" }} />
    </>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Courier New', Courier, monospace",
  backgroundColor: "#f5f1e8",
  backgroundImage: "linear-gradient(rgba(100,130,180,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(100,130,180,.18) 1px, transparent 1px)",
  backgroundSize: "22px 22px",
  color: "#2a2a2a",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 22px",
  borderBottom: "1.5px dashed #2a2a2a",
  background: "rgba(255,253,245,0.75)",
};

const lockScreenStyle: React.CSSProperties = {
  ...pageStyle,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 32,
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
