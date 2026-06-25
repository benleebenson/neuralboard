"use client";

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { useSession, signIn } from "next-auth/react";
import {
  type ClipType, type ClipTransform, type CurvePoint, type Clip, type AudioEntry,
  IMAGE_DEFAULT_DURATION, TEXT_DEFAULT_DURATION, TEXT_SOURCE_DURATION,
  SNAP, MIN_DURATION, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE, MASTER_PLAYBACK_RATE,
  MAX_EXPORT_DURATION, DEFAULT_TRANSFORM, DEFAULT_CURVE, CLIP_COLORS,
  DEFAULT_CROP_ZOOM, DEFAULT_CROP_X, DEFAULT_CROP_Y,
  DEFAULT_CHROMA_SIMILARITY, DEFAULT_CHROMA_SMOOTHNESS, DEFAULT_CHROMA_AMOUNT,
  DEFAULT_TEXT, DEFAULT_TEXT_FONT, DEFAULT_TEXT_SIZE, DEFAULT_TEXT_COLOR, COUNTDOWN_COLOR,
  snapTo, clamp, clipsOverlap, findFreeLayer, findFreeLayerOrNull,
  magneticSnap, allOtherClipEdges,
  isVisualClip, hasClipAudio, isCroppableClip,
  clipCropZoom, clipCropX, clipCropY,
  clipPlaybackRate, mediaPlaybackRate, clipSourceSpan, clipSourceTimeAtTimeline,
  setElementPlaybackRate, waveformValueAtSourceSec,
  formatTime, formatDuration, getMediaDuration, generateWaveform,
  parseDurationSec, parseTimestampSec, formatTimestamp,
  interpolateVolume, drawContainedRect, cropSourceRect,
  drawMaybeKeyedMedia, drawTextClip, drawCountdownClip,
} from "@/lib/timeline-core";

const DEFAULT_PX_PER_SEC = 100;
const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 500;
const RULER_H = 30;
const LAYER_H = 56;
const INITIAL_LAYER_COUNT = 5;
const HANDLE_W = 6;
const MAGNETIC_SNAP_PX = 10;
const CURVE_H = 12;
const LAYER_BG = [
  "rgba(255,253,245,0.55)",
  "rgba(228,238,255,0.40)",
];


type EditorSnapshot = {
  clips: Clip[];
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

const DEFAULT_TEXT_TRANSFORM: ClipTransform = { x: 20, y: 38, scaleX: 0.6, scaleY: 0.18 };
const DEFAULT_COUNTDOWN_TRANSFORM: ClipTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const TEXT_FONTS = ["Arial", "Helvetica", "Georgia", "Times New Roman", "Courier New", "Impact", "Verdana"];
const COUNTDOWN_DEFAULT_DURATION = 10;

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

type CropDragKind = "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se";
type CropDraft = { clipId: string; x: number; y: number; size: number } | null;
type CropDragState = {
  kind: CropDragKind;
  clipId: string;
  startMouseX: number;
  startMouseY: number;
  startX: number;
  startY: number;
  startSize: number;
  boxW: number;
  boxH: number;
} | null;

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

type RevealDragState = {
  clipId: string;
  handleIdx: number;
  origOffsets: number[];
  clipStartPx: number;
  clipDuration: number;
} | null;

type EntrySfxOption = {
  id: string;
  label: string;
  blobUrl: string;
  durationSec: number;
  custom?: boolean;
};

type ActiveSfxEntry = {
  bufNode: AudioBufferSourceNode;
  gainNode: GainNode;
  clipId: string;
  sfxId: string;
  startTime: number;
  durationSec: number;
};

function layerBg(layer: number): string {
  return LAYER_BG[(layer - 1) % LAYER_BG.length] ?? LAYER_BG[0];
}

function wavBlobFromSamples(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function makeEntrySfxSamples(kind: string, durationSec: number, sampleRate = 44100): Float32Array {
  const count = Math.max(1, Math.floor(durationSec * sampleRate));
  const samples = new Float32Array(count);
  let seed = 13;
  const noise = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate;
    const p = i / count;
    let value = 0;
    if (kind === "pop") {
      const env = Math.exp(-14 * p);
      value = Math.sin(2 * Math.PI * (520 - 280 * p) * t) * env;
    } else if (kind === "whoosh") {
      const env = Math.sin(Math.PI * p);
      value = noise() * env * 0.55 + Math.sin(2 * Math.PI * (180 + 900 * p) * t) * env * 0.18;
    } else if (kind === "click") {
      const env = Math.exp(-45 * p);
      value = (Math.sin(2 * Math.PI * 1900 * t) + noise() * 0.5) * env;
    } else if (kind === "sparkle") {
      const env = Math.exp(-5 * p);
      value = (
        Math.sin(2 * Math.PI * 980 * t) * 0.35 +
        Math.sin(2 * Math.PI * 1470 * t) * 0.28 +
        Math.sin(2 * Math.PI * 1960 * t) * 0.18
      ) * env * (0.7 + 0.3 * Math.sin(2 * Math.PI * 18 * t));
    } else {
      const env = Math.exp(-10 * p);
      value = Math.sin(2 * Math.PI * (120 - 45 * p) * t) * env + noise() * env * 0.16;
    }
    samples[i] = value * 0.85;
  }
  return samples;
}

function createBuiltinEntrySfxOptions(): EntrySfxOption[] {
  const presets = [
    { id: "pop", label: "Pop", durationSec: 0.35 },
    { id: "whoosh", label: "Whoosh", durationSec: 0.65 },
    { id: "click", label: "Click", durationSec: 0.18 },
    { id: "sparkle", label: "Sparkle", durationSec: 0.75 },
    { id: "thud", label: "Thud", durationSec: 0.45 },
  ];
  return presets.map((preset) => {
    const blob = wavBlobFromSamples(makeEntrySfxSamples(preset.id, preset.durationSec), 44100);
    return { ...preset, blobUrl: URL.createObjectURL(blob) };
  });
}

function trackHasRequestFrame(track: MediaStreamTrack | undefined): boolean {
  return typeof (track as (MediaStreamTrack & { requestFrame?: () => void }) | undefined)?.requestFrame === "function";
}

function cropMediaStyle(clip: Pick<Clip, "cropZoom" | "cropX" | "cropY">): React.CSSProperties {
  return {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    pointerEvents: "none",
    transformOrigin: "center center",
    transform: `translate(${-clipCropX(clip) * 0.35}%, ${-clipCropY(clip) * 0.35}%) scale(${clipCropZoom(clip)})`,
  };
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
  const [snapGuideSec, setSnapGuideSec] = useState<number | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [clipboardReady, setClipboardReady] = useState(false);
  const [cropDraft, setCropDraft] = useState<CropDraft>(null);
  const [layerCount, setLayerCount] = useState(INITIAL_LAYER_COUNT);
  const [mutedLayers, setMutedLayers] = useState<Record<number, boolean>>({});
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [outputFormat, setOutputFormat] = useState<'16:9' | '9:16'>('16:9');
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportDurationSec, setExportDurationSec] = useState(0);
  const [signInPrompt, setSignInPrompt] = useState<string | null>(null);
  const [entrySfxOptions, setEntrySfxOptions] = useState<EntrySfxOption[]>([]);

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
  // Saved videos library panel
  const [savedVideosOpen, setSavedVideosOpen] = useState(false);
  const [savedVideos, setSavedVideos] = useState<LibraryVideo[]>([]);
  const [savedVideosLoading, setSavedVideosLoading] = useState(false);
  const [savedVideosError, setSavedVideosError] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Countdown modal
  const [countdownModalOpen, setCountdownModalOpen] = useState(false);
  const [countdownEditClipId, setCountdownEditClipId] = useState<string | null>(null);
  const [countdownDraftTitle, setCountdownDraftTitle] = useState("Top 5");
  const [countdownDraftCount, setCountdownDraftCount] = useState(5);
  const [countdownDraftLabels, setCountdownDraftLabels] = useState<string[]>(Array(5).fill(""));
  const ytRangeRef = useRef({ start: 0, end: 30 });

  const playheadDraggingRef = useRef(false);
  const dragRef = useRef<DragInfo | null>(null);
  const selectedClipIdRef = useRef<string | null>(null);
  useEffect(() => { selectedClipIdRef.current = selectedClipId; }, [selectedClipId]);
  const clipboardClipRef = useRef<Clip | null>(null);
  const clipsRef = useRef<Clip[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recSecondsRef = useRef(0);
  const mediaUploadRef = useRef<HTMLInputElement | null>(null);
  const sfxUploadRef = useRef<HTMLInputElement | null>(null);
  const pendingSfxClipIdRef = useRef<string | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const previewDragRef = useRef<PreviewDragState>(null);
  const cropDraftRef = useRef<CropDraft>(null);
  const cropDragRef = useRef<CropDragState>(null);
  const curveDragRef = useRef<CurveDragState>(null);
  const revealDragRef = useRef<RevealDragState>(null);
  const pxPerSecRef = useRef(DEFAULT_PX_PER_SEC);
  const pendingScrollLeftRef = useRef<number | null>(null);
  const exportCancelRef = useRef(false);
  const exportRafRef = useRef<number | null>(null);
  const isExportingRef = useRef(false);
  const undoStackRef = useRef<EditorSnapshot[]>([]);
  const layerCountRef = useRef(INITIAL_LAYER_COUNT);
  const mutedLayersRef = useRef<Record<number, boolean>>({});
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
  const activeSfxRef = useRef<Map<string, ActiveSfxEntry>>(new Map());
  const loadingSfxRef = useRef<Set<string>>(new Set());
  const entrySfxOptionsRef = useRef<EntrySfxOption[]>([]);

  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { entrySfxOptionsRef.current = entrySfxOptions; }, [entrySfxOptions]);
  useEffect(() => { cropDraftRef.current = cropDraft; }, [cropDraft]);
  useEffect(() => { playheadSecRef.current = playheadSec; }, [playheadSec]);
  useEffect(() => { recSecondsRef.current = recSeconds; }, [recSeconds]);
  useEffect(() => { layerCountRef.current = layerCount; }, [layerCount]);
  useEffect(() => { mutedLayersRef.current = mutedLayers; }, [mutedLayers]);
  useEffect(() => { pxPerSecRef.current = pxPerSec; }, [pxPerSec]);

  // Apply pending scroll after zoom re-render so cursor-anchored zoom works
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
    fetch("/api/usage/check").then((r) => r.json()).then((d) => setIsSubscribed(!!d.isSubscribed)).catch(() => {});
  }, [session?.user?.email]);

  useEffect(() => {
    const builtins = createBuiltinEntrySfxOptions();
    entrySfxOptionsRef.current = builtins;
    const timer = window.setTimeout(() => setEntrySfxOptions(builtins), 0);
    return () => {
      window.clearTimeout(timer);
      entrySfxOptionsRef.current.forEach((option) => URL.revokeObjectURL(option.blobUrl));
      entrySfxOptionsRef.current = [];
    };
  }, []);

  // Spacebar + Delete
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const modifier = e.metaKey || e.ctrlKey;
      if (modifier && e.key.toLowerCase() === "c") {
        const selId = selectedClipIdRef.current;
        const clip = clipsRef.current.find((c) => c.id === selId);
        if (clip) {
          e.preventDefault();
          copyClip(clip);
        }
        return;
      }
      if (modifier && e.key.toLowerCase() === "v") {
        if (clipboardClipRef.current) {
          e.preventDefault();
          pasteClip();
        }
        return;
      }
      if (modifier && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undoLastEdit();
        return;
      }
      if (modifier && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        const next = clamp(pxPerSecRef.current * 1.25, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
        pxPerSecRef.current = next;
        setPxPerSec(next);
        return;
      }
      if (modifier && e.key === "-") {
        e.preventDefault();
        const next = clamp(pxPerSecRef.current / 1.25, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
        pxPerSecRef.current = next;
        setPxPerSec(next);
        return;
      }
      if (modifier && e.key === "0") {
        e.preventDefault();
        pxPerSecRef.current = DEFAULT_PX_PER_SEC;
        setPxPerSec(DEFAULT_PX_PER_SEC);
        return;
      }
      if (e.key === "Enter" && cropDraftRef.current) {
        e.preventDefault();
        finishCropMode();
        return;
      }
      if (e.key === "Escape" && cropDraftRef.current) {
        e.preventDefault();
        cancelCropMode();
        return;
      }
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
          pushUndoSnapshot();
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
      const newScrollLeft = cursorTimeSec * newPxPerSec - (e.clientX - rect.left);
      pendingScrollLeftRef.current = Math.max(0, newScrollLeft);
      pxPerSecRef.current = newPxPerSec;
      setPxPerSec(newPxPerSec);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalDuration = clips.length > 0
    ? Math.max(
      ...clips.map((c) => c.startTime + c.durationSec),
      ...clips
        .filter((c) => c.type === "image" && c.entrySfxId)
        .map((c) => {
          const option = entrySfxOptions.find((item) => item.id === c.entrySfxId);
          return c.startTime + (option?.durationSec ?? 0);
        })
    )
    : 10;
  const timelineW = totalDuration * pxPerSec + 200;
  const isDraggingClip = ghost !== null;

  function ensureLayerCount(nextLayer: number) {
    if (nextLayer <= layerCountRef.current) return;
    layerCountRef.current = nextLayer;
    setLayerCount(nextLayer);
  }

  function isLayerMuted(layer: number): boolean {
    return !!mutedLayersRef.current[layer];
  }

  function cloneClipForHistory(clip: Clip): Clip {
    return {
      ...clip,
      transform: { ...clip.transform },
      volumeCurve: clip.volumeCurve.map((pt) => ({ ...pt })),
      waveform: clip.waveform ? [...clip.waveform] : undefined,
      countdownItems: clip.countdownItems ? clip.countdownItems.map((it) => ({ ...it })) : undefined,
      revealOffsets: clip.revealOffsets ? [...clip.revealOffsets] : undefined,
    };
  }

  function pushUndoSnapshot() {
    undoStackRef.current.push({
      clips: clipsRef.current.map(cloneClipForHistory),
      selectedClipId: selectedClipIdRef.current,
      layerCount: layerCountRef.current,
      mutedLayers: { ...mutedLayersRef.current },
    });
    if (undoStackRef.current.length > 80) undoStackRef.current.shift();
  }

  function undoLastEdit() {
    const snapshot = undoStackRef.current.pop();
    if (!snapshot) return;
    if (isPlayingRef.current) pausePlayback();
    setGhost(null);
    dragRef.current = null;
    curveDragRef.current = null;
    previewDragRef.current = null;
    cropDragRef.current = null;
    cropDraftRef.current = null;
    const restored = snapshot.clips.map(cloneClipForHistory);
    clipsRef.current = restored;
    selectedClipIdRef.current = snapshot.selectedClipId;
    layerCountRef.current = snapshot.layerCount;
    mutedLayersRef.current = { ...snapshot.mutedLayers };
    setClips(restored);
    setSelectedClipId(snapshot.selectedClipId);
    setCropDraft(null);
    setLayerCount(snapshot.layerCount);
    setMutedLayers({ ...snapshot.mutedLayers });
  }

  function addLayer() {
    pushUndoSnapshot();
    const next = layerCountRef.current + 1;
    layerCountRef.current = next;
    setLayerCount(next);
  }

  function toggleLayerMute(layer: number) {
    pushUndoSnapshot();
    const next = { ...mutedLayersRef.current, [layer]: !mutedLayersRef.current[layer] };
    mutedLayersRef.current = next;
    setMutedLayers(next);
    if (isPlayingRef.current) startAudioAt(playheadSecRef.current, clipsRef.current);
  }

  function copyClip(clip: Clip) {
    clipboardClipRef.current = cloneClipForHistory(clip);
    setClipboardReady(true);
  }

  function pasteClip() {
    const source = clipboardClipRef.current;
    if (!source || isExportingRef.current) return;
    const pastedId = crypto.randomUUID();
    pushUndoSnapshot();
    setClips((prev) => {
      let startTime = Math.max(0, playheadSecRef.current);
      let layer = findFreeLayerOrNull(prev, startTime, source.durationSec, layerCountRef.current);
      if (!layer) {
        for (let offset = SNAP; offset <= 60; offset += SNAP) {
          const candidateStart = snapTo(startTime + offset);
          const candidateLayer = findFreeLayerOrNull(prev, candidateStart, source.durationSec, layerCountRef.current);
          if (candidateLayer) {
            startTime = candidateStart;
            layer = candidateLayer;
            break;
          }
        }
      }
      layer = layer ?? layerCountRef.current + 1;
      ensureLayerCount(layer);
      const pasted: Clip = {
        ...source,
        id: pastedId,
        name: `${source.name} copy`,
        startTime,
        layer,
        transform: { ...source.transform },
        volumeCurve: source.volumeCurve.map((pt) => ({ ...pt })),
        waveform: source.waveform ? [...source.waveform] : undefined,
      };
      return [...prev, pasted];
    });
    setSelectedClipId(pastedId);
  }

  function addTextClip() {
    const clipId = crypto.randomUUID();
    pushUndoSnapshot();
    setClips((prev) => {
      const startTime = playheadSecRef.current;
      const layer = findFreeLayer(prev, startTime, TEXT_DEFAULT_DURATION, layerCountRef.current);
      ensureLayerCount(layer);
      const clip: Clip = {
        id: clipId,
        type: "text",
        name: "Text",
        blobUrl: "",
        sourceDuration: TEXT_SOURCE_DURATION,
        durationSec: TEXT_DEFAULT_DURATION,
        startTime,
        layer,
        trimStart: 0,
        playbackRate: 1,
        transform: DEFAULT_TEXT_TRANSFORM,
        muted: false,
        volumeCurve: [...DEFAULT_CURVE],
        text: DEFAULT_TEXT,
        textFontFamily: DEFAULT_TEXT_FONT,
        textFontSize: DEFAULT_TEXT_SIZE,
        textColor: DEFAULT_TEXT_COLOR,
      };
      return [...prev, clip];
    });
    setSelectedClipId(clipId);
  }

  function openCountdownCreateModal() {
    setCountdownDraftTitle("Top 5");
    setCountdownDraftCount(5);
    setCountdownDraftLabels(Array(5).fill(""));
    setCountdownEditClipId(null);
    setCountdownModalOpen(true);
  }

  function openCountdownEditModal(clip: Clip) {
    const n = clip.countdownItems?.length ?? 5;
    const labels = Array.from({ length: n }, (_, i) => {
      const item = clip.countdownItems?.find((it) => it.rank === i + 1);
      return item?.label ?? "";
    });
    setCountdownDraftTitle(clip.countdownTitle ?? "Top 5");
    setCountdownDraftCount(n);
    setCountdownDraftLabels(labels);
    setCountdownEditClipId(clip.id);
    setCountdownModalOpen(true);
  }

  function confirmCountdownModal() {
    const title = countdownDraftTitle.trim();
    if (!title) return;
    const n = countdownDraftCount;
    const items: Array<{ rank: number; label: string }> = Array.from({ length: n }, (_, i) => ({
      rank: i + 1,
      label: countdownDraftLabels[i] ?? "",
    }));
    // revealOffsets: evenly spaced, rank N first (index 0), rank 1 last (index n-1)
    const dur = COUNTDOWN_DEFAULT_DURATION;
    const defaultOffsets = Array.from({ length: n }, (_, i) => parseFloat(((i + 1) * (dur / n)).toFixed(1)));

    if (countdownEditClipId) {
      // Edit existing
      pushUndoSnapshot();
      setClips((prev) => prev.map((c) => {
        if (c.id !== countdownEditClipId) return c;
        const existingOffsets = c.revealOffsets;
        // Keep existing offsets if count matches, otherwise generate defaults scaled to current duration
        let newOffsets: number[];
        if (existingOffsets && existingOffsets.length === n) {
          newOffsets = existingOffsets;
        } else {
          const d = c.durationSec;
          newOffsets = Array.from({ length: n }, (_, i) => parseFloat(((i + 1) * (d / n)).toFixed(1)));
        }
        return { ...c, countdownTitle: title, countdownItems: items, revealOffsets: newOffsets };
      }));
    } else {
      // Create new
      const clipId = crypto.randomUUID();
      pushUndoSnapshot();
      setClips((prev) => {
        const startTime = playheadSecRef.current;
        const layer = findFreeLayer(prev, startTime, COUNTDOWN_DEFAULT_DURATION, layerCountRef.current);
        ensureLayerCount(layer);
        const clip: Clip = {
          id: clipId,
          type: "countdown",
          name: title,
          blobUrl: "",
          sourceDuration: TEXT_SOURCE_DURATION,
          durationSec: COUNTDOWN_DEFAULT_DURATION,
          startTime,
          layer,
          trimStart: 0,
          playbackRate: 1,
          transform: DEFAULT_COUNTDOWN_TRANSFORM,
          muted: false,
          volumeCurve: [...DEFAULT_CURVE],
          countdownTitle: title,
          countdownItems: items,
          revealOffsets: defaultOffsets,
        };
        return [...prev, clip];
      });
      setSelectedClipId(clipId);
    }
    setCountdownModalOpen(false);
  }

  function onRevealHandlePointerDown(e: React.PointerEvent<HTMLDivElement>, clip: Clip, handleIdx: number) {
    e.stopPropagation();
    setSelectedClipId(clip.id);
    selectedClipIdRef.current = clip.id;
    pushUndoSnapshot();
    revealDragRef.current = {
      clipId: clip.id,
      handleIdx,
      origOffsets: [...(clip.revealOffsets ?? [])],
      clipStartPx: clip.startTime * pxPerSecRef.current,
      clipDuration: clip.durationSec,
    };
    scrollerRef.current?.setPointerCapture(e.pointerId);
  }

  function updateRevealDrag(clientX: number) {
    const drag = revealDragRef.current;
    if (!drag) return;
    const scroller = scrollerRef.current!;
    const rect = scroller.getBoundingClientRect();
    const xInTimeline = clientX - rect.left + scroller.scrollLeft;
    const xInClip = xInTimeline - drag.clipStartPx;
    const rawOffset = clamp(xInClip / pxPerSecRef.current, 0, drag.clipDuration);
    const snapped = snapTo(rawOffset);

    const offsets = [...drag.origOffsets];
    offsets[drag.handleIdx] = snapped;

    const i = drag.handleIdx;
    if (i > 0 && offsets[i] < offsets[i - 1]) offsets[i] = offsets[i - 1]!;
    if (i < offsets.length - 1 && offsets[i] > offsets[i + 1]) offsets[i] = offsets[i + 1]!;

    setClips((prev) => prev.map((c) => c.id === drag.clipId ? { ...c, revealOffsets: offsets } : c));
  }

  function commitRevealDrag() {
    revealDragRef.current = null;
  }

  function fitToTimeline() {
    if (clips.length === 0) {
      pxPerSecRef.current = DEFAULT_PX_PER_SEC;
      setPxPerSec(DEFAULT_PX_PER_SEC);
      return;
    }
    const total = Math.max(...clips.map((c) => c.startTime + c.durationSec));
    if (total <= 0) return;
    const containerW = scrollerRef.current?.offsetWidth ?? 800;
    const next = clamp((containerW - 80) / total, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
    pxPerSecRef.current = next;
    setPxPerSec(next);
    pendingScrollLeftRef.current = 0;
  }

  // ─── Audio ──────────────────────────────────────────────────────────────────

  function getAudioCtx(): AudioContext {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  }

  function entrySfxOptionForClip(clip: Clip): EntrySfxOption | null {
    if (clip.type !== "image" || !clip.entrySfxId) return null;
    return entrySfxOptionsRef.current.find((option) => option.id === clip.entrySfxId) ?? null;
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
    activeSfxRef.current.forEach((entry) => {
      try { entry.bufNode.stop(); } catch {}
      try { entry.bufNode.disconnect(); } catch {}
      try { entry.gainNode.disconnect(); } catch {}
    });
    activeSfxRef.current.clear();
    loadingSfxRef.current.clear();
  }

  function spawnImageEntrySfx(clip: Clip, atSec: number, ctx: AudioContext, extraDest?: AudioNode) {
    const option = entrySfxOptionForClip(clip);
    if (!option) return;
    const sfxOffset = atSec - clip.startTime;
    if (sfxOffset < 0 || sfxOffset >= option.durationSec) return;
    const key = `${clip.id}:entry-sfx`;
    if (activeSfxRef.current.has(key) || loadingSfxRef.current.has(key)) return;
    loadingSfxRef.current.add(key);
    const gainNode = ctx.createGain();
    gainNode.gain.value = isRecordingNarrationRef.current ? 0 : 0.82;
    gainNode.connect(ctx.destination);
    if (extraDest) gainNode.connect(extraDest);
    fetch(option.blobUrl)
      .then((r) => r.arrayBuffer())
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buffer) => {
        loadingSfxRef.current.delete(key);
        if (!isPlayingRef.current && !isExportingRef.current) {
          try { gainNode.disconnect(); } catch {}
          return;
        }
        if (activeSfxRef.current.has(key)) {
          try { gainNode.disconnect(); } catch {}
          return;
        }
        const bufNode = ctx.createBufferSource();
        bufNode.buffer = buffer;
        bufNode.connect(gainNode);
        const safeOffset = Math.min(Math.max(0, sfxOffset), Math.max(0, buffer.duration - 0.01));
        bufNode.start(0, safeOffset);
        activeSfxRef.current.set(key, {
          bufNode,
          gainNode,
          clipId: clip.id,
          sfxId: option.id,
          startTime: clip.startTime,
          durationSec: option.durationSec,
        });
      })
      .catch(() => {
        loadingSfxRef.current.delete(key);
        try { gainNode.disconnect(); } catch {}
      });
  }

  function startAudioAt(atSec: number, currentClips: Clip[], extraDest?: AudioNode) {
    stopAllAudio();
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    currentClips.forEach((clip) => {
      if (!hasClipAudio(clip)) return;
      if (clip.muted) return;
      if (isLayerMuted(clip.layer)) return;
      if (atSec < clip.startTime || atSec >= clip.startTime + clip.durationSec) return;
      spawnClipAudio(clip, atSec - clip.startTime, ctx, extraDest);
    });
    currentClips.forEach((clip) => {
      if (clip.type !== "image" || clip.muted || isLayerMuted(clip.layer)) return;
      spawnImageEntrySfx(clip, atSec, ctx, extraDest);
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
    activeSfxRef.current.forEach((entry, key) => {
      const clip = currentClips.find((c) => c.id === entry.clipId);
      const option = clip ? entrySfxOptionForClip(clip) : null;
      if (!clip || !option || option.id !== entry.sfxId || clip.muted || isLayerMuted(clip.layer) ||
          atSec < entry.startTime || atSec >= entry.startTime + entry.durationSec) {
        try { entry.bufNode.stop(); } catch {}
        try { entry.bufNode.disconnect(); } catch {}
        try { entry.gainNode.disconnect(); } catch {}
        activeSfxRef.current.delete(key);
      } else {
        entry.gainNode.gain.value = isRecordingNarrationRef.current ? 0 : 0.82;
      }
    });
    currentClips.forEach((clip) => {
      if (!hasClipAudio(clip)) return;
      if (clip.muted) return;
      if (isLayerMuted(clip.layer)) return;
      if (activeAudioRef.current.has(clip.id)) return;
      if (atSec < clip.startTime || atSec >= clip.startTime + clip.durationSec) return;
      spawnClipAudio(clip, atSec - clip.startTime, ctx, extraDest);
    });
    currentClips.forEach((clip) => {
      if (clip.type !== "image" || clip.muted || isLayerMuted(clip.layer)) return;
      spawnImageEntrySfx(clip, atSec, ctx, extraDest);
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
    seekTo(x / pxPerSecRef.current);
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
    if (revealDragRef.current) { updateRevealDrag(e.clientX); return; }
    if (playheadDraggingRef.current) seekFromClientX(e.clientX);
  }

  function onScrollerPointerUp() {
    if (dragRef.current) { commitClipDrag(); return; }
    if (revealDragRef.current) { commitRevealDrag(); return; }
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
    const dtSec = dx / pxPerSecRef.current;
    const snapThreshold = MAGNETIC_SNAP_PX / pxPerSecRef.current;
    const yInLayers = clientY - rect.top + scroller.scrollTop - RULER_H;
    const hoverLayer = Math.min(layerCountRef.current, Math.max(1, Math.floor(yInLayers / LAYER_H) + 1));
    let newStart = drag.validStartTime;
    let newDur = drag.validDuration;
    let newLayer = drag.validLayer;
    const src = clipsRef.current.find((c) => c.id === drag.clipId)!;
    const rate = clipPlaybackRate(src);

    // Snap candidates: time 0, playhead, and all edges of every other clip on every layer
    const snapCandidates = [0, playheadSecRef.current, ...allOtherClipEdges(clipsRef.current, drag.clipId)];
    let activeSnapTarget: number | null = null;

    if (drag.kind === "move") {
      // Grid-snap the raw position first — this creates dead-zones (±5px per grid cell)
      // that stabilise the clip so snap doesn't disengage with every pixel of cursor movement.
      const baseStart = Math.max(0, snapTo(drag.origStartTime + dtSec));
      newLayer = hoverLayer;
      newDur = drag.origDuration;

      // Try LEFT edge first; fall back to RIGHT edge; fall back to grid-snapped base
      const { snapped: snappedLeft, target: leftTarget } = magneticSnap(baseStart, snapCandidates, snapThreshold);
      if (leftTarget !== null) {
        newStart = Math.max(0, snappedLeft);
        activeSnapTarget = leftTarget;
      } else {
        const { snapped: snappedRight, target: rightTarget } = magneticSnap(baseStart + newDur, snapCandidates, snapThreshold);
        if (rightTarget !== null) {
          newStart = Math.max(0, snappedRight - newDur);
          activeSnapTarget = rightTarget;
        } else {
          newStart = baseStart;
          activeSnapTarget = null;
        }
      }
    } else if (drag.kind === "resize-left") {
      const minStart = Math.max(0, drag.origStartTime - drag.origTrimStart / rate);
      const maxStart = drag.origStartTime + drag.origDuration - MIN_DURATION;
      const baseStart = snapTo(clamp(drag.origStartTime + dtSec, minStart, maxStart));

      const { snapped, target } = magneticSnap(baseStart, snapCandidates, snapThreshold);
      if (target !== null) {
        newStart = clamp(snapped, minStart, maxStart);
        activeSnapTarget = target;
      } else {
        newStart = clamp(baseStart, minStart, maxStart);
        activeSnapTarget = null;
      }

      const sourceDelta = (newStart - drag.origStartTime) * rate;
      drag.validTrimStart = clamp(drag.origTrimStart + sourceDelta, 0, src.sourceDuration);
      newDur = Math.max(MIN_DURATION, (drag.origTrimStart + drag.origDuration * rate - drag.validTrimStart) / rate);
      newLayer = drag.origLayer;
    } else {
      const maxTimelineDur = Math.max(MIN_DURATION, (src.sourceDuration - drag.origTrimStart) / rate);
      const baseDur = clamp(snapTo(drag.origDuration + dtSec), MIN_DURATION, maxTimelineDur);
      const baseEnd = drag.origStartTime + baseDur;
      newStart = drag.origStartTime;
      newLayer = drag.origLayer;

      const { snapped: snappedEnd, target } = magneticSnap(baseEnd, snapCandidates, snapThreshold);
      const snappedDur = snappedEnd - drag.origStartTime;
      if (target !== null && snappedDur >= MIN_DURATION) {
        newDur = clamp(snappedDur, MIN_DURATION, maxTimelineDur);
        activeSnapTarget = target;
      } else {
        newDur = baseDur;
        activeSnapTarget = null;
      }
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
    const changed =
      drag.validStartTime !== drag.origStartTime ||
      drag.validDuration !== drag.origDuration ||
      drag.validLayer !== drag.origLayer ||
      drag.validTrimStart !== drag.origTrimStart;
    if (!changed) return;
    pushUndoSnapshot();
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
      const layer = findFreeLayer(clipsRef.current, startSec, 9999, layerCountRef.current);
      ensureLayerCount(layer);
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
        const waveform = await generateWaveform(blobUrl).catch(() => undefined);
        const dur = durationSec || recSecondsRef.current;
        if (dur < 0.1) return;
        pushUndoSnapshot();
        setClips((prev) => {
          const startTime = recStartSecRef.current;
          return [...prev, { id: crypto.randomUUID(), type: "audio", name: "Narration", blobUrl, sourceDuration: dur, durationSec: dur, startTime, layer: recLayerRef.current, trimStart: 0, playbackRate: 1, transform: DEFAULT_TRANSFORM, muted: false, volumeCurve: [...DEFAULT_CURVE], waveform }];
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
      const newClips: Clip[] = [];
      for (const item of valid) {
        const dur = item.durationSec || (item.type === "image" ? IMAGE_DEFAULT_DURATION : 5);
        const layer = findFreeLayer([...prev, ...newClips], startTime, dur, layerCountRef.current);
        ensureLayerCount(layer);
        newClips.push({ id: crypto.randomUUID(), type: item.type, name: item.name, blobUrl: item.blobUrl, sourceDuration: dur, durationSec: dur, startTime, layer, trimStart: 0, playbackRate: 1, transform: DEFAULT_TRANSFORM, muted: false, volumeCurve: [...DEFAULT_CURVE], waveform: item.waveform });
      }
      return [...prev, ...newClips];
    });
    e.target.value = "";
  }

  function updateImageEntrySfx(clipId: string, sfxId: string | undefined) {
    pushUndoSnapshot();
    setClips((prev) => prev.map((clip) => clip.id === clipId ? { ...clip, entrySfxId: sfxId } : clip));
  }

  function playEntrySfxPreview(option: EntrySfxOption) {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    fetch(option.blobUrl)
      .then((r) => r.arrayBuffer())
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buffer) => {
        const gainNode = ctx.createGain();
        gainNode.gain.value = 0.7;
        gainNode.connect(ctx.destination);
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(gainNode);
        node.start();
        node.onended = () => {
          try { node.disconnect(); } catch {}
          try { gainNode.disconnect(); } catch {}
        };
      })
      .catch(() => {});
  }

  function handleEntrySfxSelect(clipId: string, value: string) {
    if (value === "__upload") {
      pendingSfxClipIdRef.current = clipId;
      sfxUploadRef.current?.click();
      return;
    }
    const next = value || undefined;
    updateImageEntrySfx(clipId, next);
    const option = next ? entrySfxOptionsRef.current.find((item) => item.id === next) : null;
    if (option) playEntrySfxPreview(option);
  }

  async function handleEntrySfxUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const clipId = pendingSfxClipIdRef.current;
    pendingSfxClipIdRef.current = null;
    e.target.value = "";
    if (!file || !clipId) return;
    if (!file.type.startsWith("audio/") && !/\.(mp3|m4a|wav|aac|ogg|opus|webm)$/i.test(file.name)) {
      showToast("Choose an audio file for image SFX");
      return;
    }
    const blobUrl = URL.createObjectURL(file);
    const durationSec = await getMediaDuration(blobUrl, "audio").catch(() => 1);
    const option: EntrySfxOption = {
      id: `custom-${crypto.randomUUID()}`,
      label: file.name.replace(/\.[^.]+$/, "").slice(0, 24) || "Custom SFX",
      blobUrl,
      durationSec: Math.max(0.1, Math.min(durationSec || 1, 10)),
      custom: true,
    };
    entrySfxOptionsRef.current = [...entrySfxOptionsRef.current, option];
    setEntrySfxOptions(entrySfxOptionsRef.current);
    updateImageEntrySfx(clipId, option.id);
    playEntrySfxPreview(option);
    showToast(`Added SFX: ${option.label}`);
  }

  // ─── YouTube ────────────────────────────────────────────────────────────────

  async function handleYtSearch(shortsOnlyOverride?: boolean) {
    if (!ytQuery.trim()) return;
    setYtLoading(true);
    setYtError("");
    setYtResults([]);
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

  async function handleYtConfirm() {
    if (!ytSelected) return;
    setYtLoading(true);
    setYtError("");
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
      const durationSec = await getMediaDuration(blobUrl, "video");
      const title = (ytSelected.title ?? "YouTube clip").slice(0, 40);
      pushUndoSnapshot();
      setClips((prev) => {
        const startTime = playheadSecRef.current;
        const dur = durationSec || (ytEnd - ytStart);
        const layer = findFreeLayer(prev, startTime, dur, layerCountRef.current);
        ensureLayerCount(layer);
        return [...prev, { id: crypto.randomUUID(), type: "video", name: title, blobUrl, sourceDuration: dur, durationSec: dur, startTime, layer, trimStart: 0, playbackRate: 1, transform: DEFAULT_TRANSFORM, muted: false, volumeCurve: [...DEFAULT_CURVE] }];
      });
      setYtModalOpen(false);
      // Best-effort: save video metadata to library
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

  // ─── Library ─────────────────────────────────────────────────────────────────

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }

  async function fetchLibrary() {
    setSavedVideosLoading(true);
    setSavedVideosError("");
    try {
      const res = await fetch("/api/library");
      if (!res.ok) throw new Error();
      setSavedVideos(await res.json());
    } catch {
      setSavedVideosError("Failed to load library");
    } finally {
      setSavedVideosLoading(false);
    }
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
    setYtStart(0);
    setYtStartInput("0:00");
    setYtEnd(initEnd);
    setYtEndInput(formatTimestamp(initEnd));
    ytRangeRef.current = { start: 0, end: initEnd };
    setYtView("trim");
    setYtError("");
    setYtModalOpen(true);
  }

  // ─── Preview ─────────────────────────────────────────────────────────────────

  const activeVisualClips = clips
    .filter(
      (c) => isVisualClip(c) &&
        playheadSec >= c.startTime && playheadSec < c.startTime + c.durationSec
    )
    .sort((a, b) => b.layer - a.layer);

  // ─── Split ───────────────────────────────────────────────────────────────────

  function splitAtPlayhead() {
    const t = playheadSecRef.current;
    const selectedId = selectedClipIdRef.current;
    const clip = selectedId ? clipsRef.current.find((c) => c.id === selectedId) : null;
    if (!clip || t <= clip.startTime + 0.05 || t >= clip.startTime + clip.durationSec - 0.05) return;
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
    pushUndoSnapshot();
    setClips((prev) => prev.filter((c) => c.id !== clip.id).concat([leftClip, rightClip]));
    setSelectedClipId(leftClip.id);
  }

  // ─── Preview transform drag ──────────────────────────────────────────────────

  function draftFromClipCrop(clip: Clip): Exclude<CropDraft, null> {
    const zoom = clipCropZoom(clip);
    const size = clamp(100 / zoom, 25, 100);
    const travel = (100 - size) / 2;
    const x = travel === 0 ? 0 : travel + (clipCropX(clip) / 100) * travel;
    const y = travel === 0 ? 0 : travel + (clipCropY(clip) / 100) * travel;
    return {
      clipId: clip.id,
      x: clamp(x, 0, 100 - size),
      y: clamp(y, 0, 100 - size),
      size,
    };
  }

  function startCropMode(clip: Clip) {
    if (!isCroppableClip(clip) || isExportingRef.current) return;
    if (isPlayingRef.current) pausePlayback();
    if (playheadSecRef.current < clip.startTime || playheadSecRef.current >= clip.startTime + clip.durationSec) {
      playheadSecRef.current = clip.startTime;
      setPlayheadSec(clip.startTime);
    }
    setSelectedClipId(clip.id);
    selectedClipIdRef.current = clip.id;
    const draft = draftFromClipCrop(clip);
    cropDraftRef.current = draft;
    setCropDraft(draft);
  }

  function cancelCropMode() {
    cropDragRef.current = null;
    cropDraftRef.current = null;
    setCropDraft(null);
  }

  function finishCropMode() {
    const draft = cropDraftRef.current;
    if (!draft) return;
    const size = clamp(draft.size, 25, 100);
    const travel = (100 - size) / 2;
    const cropX = travel === 0 ? DEFAULT_CROP_X : clamp(((draft.x - travel) / travel) * 100, -100, 100);
    const cropY = travel === 0 ? DEFAULT_CROP_Y : clamp(((draft.y - travel) / travel) * 100, -100, 100);
    const cropZoom = clamp(100 / size, 1, 4);
    pushUndoSnapshot();
    setClips((prev) =>
      prev.map((c) =>
        c.id === draft.clipId
          ? { ...c, cropZoom, cropX, cropY }
          : c
      )
    );
    cancelCropMode();
  }

  function onCropPointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    clip: Clip,
    kind: CropDragKind,
  ) {
    e.stopPropagation();
    const draft = cropDraftRef.current;
    const box = e.currentTarget.closest("[data-crop-surface='true']");
    if (!draft || draft.clipId !== clip.id || !(box instanceof HTMLElement)) return;
    const rect = box.getBoundingClientRect();
    cropDragRef.current = {
      kind,
      clipId: clip.id,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startX: draft.x,
      startY: draft.y,
      startSize: draft.size,
      boxW: Math.max(1, rect.width),
      boxH: Math.max(1, rect.height),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function updateCropDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = cropDragRef.current;
    const current = cropDraftRef.current;
    if (!drag || !current || current.clipId !== drag.clipId) return;

    const dxPct = ((e.clientX - drag.startMouseX) / drag.boxW) * 100;
    const dyPct = ((e.clientY - drag.startMouseY) / drag.boxH) * 100;
    let x = drag.startX;
    let y = drag.startY;
    let size = drag.startSize;

    if (drag.kind === "move") {
      x = drag.startX + dxPct;
      y = drag.startY + dyPct;
    } else if (drag.kind === "resize-se") {
      size = drag.startSize + Math.max(dxPct, dyPct);
    } else if (drag.kind === "resize-nw") {
      size = drag.startSize - Math.min(dxPct, dyPct);
      x = drag.startX + drag.startSize - size;
      y = drag.startY + drag.startSize - size;
    } else if (drag.kind === "resize-ne") {
      size = drag.startSize + Math.max(dxPct, -dyPct);
      y = drag.startY + drag.startSize - size;
    } else if (drag.kind === "resize-sw") {
      size = drag.startSize + Math.max(-dxPct, dyPct);
      x = drag.startX + drag.startSize - size;
    }

    size = clamp(size, 25, 100);
    x = clamp(x, 0, 100 - size);
    y = clamp(y, 0, 100 - size);
    const next = { clipId: drag.clipId, x, y, size };
    cropDraftRef.current = next;
    setCropDraft(next);
  }

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
    pushUndoSnapshot();
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
    if (cropDragRef.current) {
      updateCropDrag(e);
      return;
    }
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
    cropDragRef.current = null;
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
      const durationSec = Math.max(MIN_DURATION, sourceSpan / playbackRate);
      const others = prev.filter((c) => c.id !== clipId);
      let layer = target.layer;
      if (others.some((c) => c.layer === target.layer && clipsOverlap(target.startTime, durationSec, c.startTime, c.durationSec))) {
        const freeLayer = findFreeLayerOrNull(others, target.startTime, durationSec, layerCountRef.current);
        if (freeLayer) {
          layer = freeLayer;
        } else {
          layer = layerCountRef.current + 1;
          ensureLayerCount(layer);
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
    if (!session?.user?.email) {
      setSignInPrompt("Sign in with Google to export your video.");
      return;
    }
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

    const sourceTotalDur = Math.max(
      ...currentClips.map((c) => c.startTime + c.durationSec),
      ...currentClips
        .filter((c) => c.type === "image" && c.entrySfxId)
        .map((c) => c.startTime + (entrySfxOptionsRef.current.find((item) => item.id === c.entrySfxId)?.durationSec ?? 0))
    );
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

    // DIAGNOSTIC 3: videoTrack state at stream creation
    const _exportVideoTrack = canvasStream.getVideoTracks()[0];
    console.log('[export] videoTrack details at creation:', {
      readyState: _exportVideoTrack?.readyState,
      enabled: _exportVideoTrack?.enabled,
      muted: _exportVideoTrack?.muted,
      hasRequestFrame: trackHasRequestFrame(_exportVideoTrack),
    });

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
    let _exportFrameCount = 0;

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

      _exportFrameCount++;
      const _logThisFrame = _exportFrameCount % 30 === 1; // frames 1, 31, 61 ...

      // DIAGNOSTIC 1 TOP: confirm draw is actually being called each frame
      if (_logThisFrame) {
        const _activeVisCount = currentClips.filter(
          (c) => isVisualClip(c) && elapsed >= c.startTime && elapsed < c.startTime + c.durationSec
        ).length;
        console.log('[export] drawExportFrameAt CALLED for virtualTime:', elapsed, 'visualClips at this time:', _activeVisCount);
      }

      // Draw frame
      ctx2d.fillStyle = "#111";
      ctx2d.fillRect(0, 0, canvasW, canvasH);

      const visClips = currentClips
        .filter((c) => isVisualClip(c) &&
          elapsed >= c.startTime && elapsed < c.startTime + c.durationSec)
        .sort((a, b) => b.layer - a.layer); // layer 5 first (bg), layer 1 last (fg)

      for (const clip of visClips) {
        const tr = clip.transform;
        const x = (tr.x / 100) * canvasW;
        const y = (tr.y / 100) * canvasH;
        const w = tr.scaleX * canvasW;
        const h = tr.scaleY * canvasH;

        if (clip.type === "text") {
          drawTextClip(ctx2d, clip, x, y, w, h, canvasH);
          continue;
        }

        if (clip.type === "countdown") {
          drawCountdownClip(ctx2d, clip, x, y, w, h, canvasH, elapsed - clip.startTime);
          continue;
        }

        let el: HTMLVideoElement | HTMLImageElement | null = null;
        if (clip.type === "video") el = exportVideoEls.get(clip.id) ?? null;
        else if (clip.type === "image") el = exportImageEls.get(clip.id) ?? null;
        if (!el) continue;

        const mW = el instanceof HTMLVideoElement ? el.videoWidth : (el as HTMLImageElement).naturalWidth;
        const mH = el instanceof HTMLVideoElement ? el.videoHeight : (el as HTMLImageElement).naturalHeight;

        if (mW > 0 && mH > 0) {
          const rect = drawContainedRect(mW, mH, x, y, w, h);
          drawMaybeKeyedMedia(ctx2d, el, rect.x, rect.y, rect.w, rect.h, clip);
        } else {
          drawMaybeKeyedMedia(ctx2d, el, x, y, w, h, clip);
        }
      }

      // DIAGNOSTIC 1 BOTTOM: confirm draw reached the end (no early return inside)
      if (_logThisFrame) {
        console.log('[export] drawExportFrameAt FINISHED for virtualTime:', elapsed);
      }

      // DIAGNOSTIC 2: pixel sample at frames 1 and 90 to detect blank canvas
      if (_exportFrameCount === 1 || _exportFrameCount === 90) {
        const _px = ctx2d.getImageData(400, 300, 1, 1).data;
        console.log('[export] frame', _exportFrameCount, 'pixel sample at (400,300) RGBA:', _px[0], _px[1], _px[2], _px[3]);
      }

      // DIAGNOSTIC 3: videoTrack state at frame 90 (check for muted/ended mid-recording)
      if (_exportFrameCount === 90) {
        const _vt = canvasStream.getVideoTracks()[0];
        console.log('[export] videoTrack details at frame 90:', {
          readyState: _vt?.readyState,
          enabled: _vt?.enabled,
          muted: _vt?.muted,
          hasRequestFrame: trackHasRequestFrame(_vt),
        });
      }

      exportRafRef.current = requestAnimationFrame(exportFrame);
    }

    exportRafRef.current = requestAnimationFrame(exportFrame);
  }

  const playheadX = playheadSec * pxPerSec;
  const isShortFormat = outputFormat === '9:16';
  const renderPreviewPanel = (placement: "top" | "side") => {
    const side = placement === "side";
    return (
      <div style={{
        flex: side ? "0 0 auto" : 1,
        padding: side ? "16px 18px" : "16px 20px",
        display: "flex",
        flexDirection: "column",
        alignItems: side ? "center" : "flex-start",
        gap: 8,
        minWidth: 0,
      }}>
        <div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: side ? "center" : "flex-start", gap: 10 }}>
          <div style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", letterSpacing: 1, textTransform: "uppercase" }}>Preview</div>
          <div style={{ display: "flex", gap: 0 }}>
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
        </div>
        <div style={{
          width: side ? "min(100%, 340px)" : outputFormat === '16:9' ? 400 : 220,
          maxHeight: side ? "calc(100vh - 180px)" : undefined,
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
              const activeCropDraft = cropDraft?.clipId === clip.id ? cropDraft : null;
              const cropActive = !!activeCropDraft;
              return (
                <div
                  key={clip.id}
                  data-crop-surface="true"
                  style={{
                    position: "absolute",
                    left: `${t.x}%`,
                    top: `${t.y}%`,
                    width: `${t.scaleX * 100}%`,
                    height: `${t.scaleY * 100}%`,
                    zIndex: layerCount + 1 - clip.layer,
                    cursor: isSelected && !cropActive ? "move" : "default",
                  }}
                  onPointerDown={isSelected && !cropActive ? (e) => { e.stopPropagation(); onPreviewPointerDown(e, clip, "move"); } : undefined}
                >
                  {clip.type === "text" ? (
                    <div
                      style={{
                        width: "100%",
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        textAlign: "center",
                        whiteSpace: "pre-wrap",
                        overflow: "hidden",
                        color: clip.textColor || DEFAULT_TEXT_COLOR,
                        fontFamily: clip.textFontFamily || DEFAULT_TEXT_FONT,
                        fontSize: Math.max(8, (clip.textFontSize ?? DEFAULT_TEXT_SIZE) / 2),
                        fontWeight: 700,
                        lineHeight: 1.1,
                        textShadow: "0 2px 8px rgba(0,0,0,0.8)",
                        pointerEvents: "none",
                      }}
                    >
                      {clip.text || DEFAULT_TEXT}
                    </div>
                  ) : clip.type === "countdown" ? (() => {
                    const cdItems = clip.countdownItems ?? [];
                    const cdOffsets = clip.revealOffsets ?? [];
                    const cdN = cdItems.length;
                    const cdElapsed = playheadSec - clip.startTime;
                    const fontSize = Math.max(10, 20 - cdN);
                    const rankFontSize = Math.max(9, 17 - cdN);
                    return (
                      <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", display: "flex", flexDirection: "column", alignItems: "center", padding: "6% 8% 0", boxSizing: "border-box" }}>
                        <div style={{ fontSize, fontWeight: 700, fontFamily: "Arial, sans-serif", color: "#ffffff", textShadow: "0 2px 8px rgba(0,0,0,0.85)", marginBottom: "4%", textAlign: "center", lineHeight: 1.2 }}>
                          {clip.countdownTitle ?? "Top 5"}
                        </div>
                        {Array.from({ length: cdN }, (_, i) => {
                          const rankNum = cdN - i;
                          const item = cdItems.find((it) => it.rank === rankNum);
                          const offset = cdOffsets[i] ?? 0;
                          const revealed = cdElapsed >= offset;
                          return (
                            <div key={i} style={{ display: "flex", alignItems: "baseline", width: "100%", marginBottom: "2%", gap: "4%" }}>
                              <span style={{ fontSize: rankFontSize, fontWeight: 700, fontFamily: "Arial, sans-serif", color: "rgba(255,255,255,0.65)", textShadow: "0 1px 4px rgba(0,0,0,0.8)", flexShrink: 0, minWidth: "14%", textAlign: "right" }}>
                                {rankNum}.
                              </span>
                              <span style={{ fontSize: rankFontSize, fontWeight: 700, fontFamily: "Arial, sans-serif", color: "#ffffff", textShadow: "0 1px 6px rgba(0,0,0,0.85)", opacity: revealed ? 1 : 0, transition: "opacity 0.2s ease", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {item?.label ?? ""}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })() : (
                    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
                      {clip.type === "image" ? (
                        <img src={clip.blobUrl} alt="" style={cropActive ? { width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" } : cropMediaStyle(clip)} />
                      ) : clip.removeGreenScreen ? (
                        <KeyedPreviewVideo clip={clip} playheadSec={playheadSec} isPlaying={isPlaying} disableCrop={cropActive} />
                      ) : (
                        <PreviewVideo clip={clip} playheadSec={playheadSec} isPlaying={isPlaying} disableCrop={cropActive} />
                      )}
                    </div>
                  )}
                  {activeCropDraft && (
                    <div
                      onPointerDown={(e) => onCropPointerDown(e, clip, "move")}
                      style={{
                        position: "absolute",
                        left: `${activeCropDraft.x}%`,
                        top: `${activeCropDraft.y}%`,
                        width: `${activeCropDraft.size}%`,
                        height: `${activeCropDraft.size}%`,
                        border: "2px dotted #000",
                        boxShadow: "0 0 0 9999px rgba(0,0,0,0.16)",
                        zIndex: 5,
                        cursor: "move",
                        boxSizing: "border-box",
                      }}
                    >
                      {(["nw", "ne", "sw", "se"] as const).map((corner) => {
                        const kind = `resize-${corner}` as CropDragKind;
                        return (
                          <div
                            key={corner}
                            onPointerDown={(e) => onCropPointerDown(e, clip, kind)}
                            style={{
                              position: "absolute",
                              width: 10,
                              height: 10,
                              background: "#000",
                              border: "1px solid #fffdf5",
                              boxSizing: "border-box",
                              cursor: `${corner}-resize`,
                              ...(corner === "nw" ? { top: -6, left: -6 } :
                                  corner === "ne" ? { top: -6, right: -6 } :
                                  corner === "sw" ? { bottom: -6, left: -6 } :
                                                    { bottom: -6, right: -6 }),
                            }}
                          />
                        );
                      })}
                    </div>
                  )}
                  {isSelected && !cropActive && (
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
    );
  };

  return (
    <main style={pageStyle}>
      <style>{`@keyframes nbpulse { 0%,100%{opacity:1} 50%{opacity:0.3} } @keyframes nbslide-in { from { transform: translateX(100%); } to { transform: translateX(0); } } @keyframes nbtoast { 0%{opacity:0;transform:translate(-50%,8px)} 100%{opacity:1;transform:translate(-50%,0)} }`}</style>

      {/* Header */}
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: "#2a2a2a" }}>Neural Board</span>
          <span style={{ fontSize: 11, color: "#6a6a6a", letterSpacing: 1, fontFamily: "monospace" }}>/ EDITOR</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a href="/board" style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace", textDecoration: "none" }}>Board</a>
          <a href="/board2" style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace", textDecoration: "none" }}>Board 2.0</a>
          {session?.user ? (
            <span style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>{session.user.email}</span>
          ) : (
            <button onClick={() => signIn("google", { callbackUrl: "/editor" })} style={{ fontFamily: "monospace", background: "transparent", border: "1px solid #2a2a2a", padding: "3px 8px", cursor: "pointer", fontSize: 10 }}>sign in →</button>
          )}
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0, minHeight: 0 }}>

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
          <input ref={sfxUploadRef} type="file" accept="audio/*" style={{ display: "none" }} onChange={handleEntrySfxUpload} />
          <button onClick={addTextClip} style={sketchButton}>T Add text</button>
          <button onClick={openCountdownCreateModal} style={{ ...sketchButton, background: COUNTDOWN_COLOR }}>↓ Top List</button>
          <button
            onClick={() => { setYtModalOpen(true); setYtView("search"); setYtQuery(""); setYtResults([]); setYtError(""); }}
            style={sketchButton}
          >
            ▶ Add YouTube clip
          </button>
          {recError && <span style={{ fontSize: 10, color: "#ff5e3a", fontFamily: "monospace" }}>{recError}</span>}
        </div>

        {!isShortFormat && renderPreviewPanel("top")}
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
        <button
          onClick={addLayer}
          disabled={isExporting}
          style={{ ...sketchButton, height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, opacity: isExporting ? 0.4 : 1 }}
          title="Add a new timeline layer"
        >
          + Layer
        </button>
        <button
          onClick={fitToTimeline}
          disabled={isExporting}
          style={{ ...sketchButton, height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, opacity: isExporting ? 0.4 : 1 }}
          title="Fit timeline to window (Cmd/Ctrl+0 resets to 100px/s)"
        >
          Fit
        </button>
        {(() => {
          const selClip = selectedClipId ? clips.find((c) => c.id === selectedClipId) : null;
          if (!selClip) return null;
          return (
            <>
              <button
                onClick={() => copyClip(selClip)}
                disabled={isExporting}
                style={{ ...sketchButton, height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, opacity: isExporting ? 0.4 : 1 }}
                title="Copy selected clip"
              >
                Copy
              </button>
              <button
                onClick={pasteClip}
                disabled={isExporting || !clipboardReady}
                style={{ ...sketchButton, height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, opacity: isExporting || !clipboardReady ? 0.4 : 1 }}
                title="Paste copied clip at playhead"
              >
                Paste
              </button>
              {selClip.type === "text" && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, border: "1.5px solid #2a2a2a", background: "#fffdf5", padding: "4px 8px", boxShadow: "2px 2px 0 #2a2a2a", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a" }}>text</span>
                  <input
                    type="text"
                    value={selClip.text ?? DEFAULT_TEXT}
                    onFocus={pushUndoSnapshot}
                    onChange={(e) => setClips((prev) => prev.map((c) => c.id === selClip.id ? { ...c, text: e.target.value, name: e.target.value.trim() ? e.target.value.trim().slice(0, 24) : "Text" } : c))}
                    disabled={isExporting}
                    style={{ width: 170, fontFamily: "monospace", fontSize: 11, padding: "4px 6px", border: "1px solid #2a2a2a", background: "#fffdf5" }}
                  />
                  <select
                    value={selClip.textFontFamily ?? DEFAULT_TEXT_FONT}
                    onFocus={pushUndoSnapshot}
                    onChange={(e) => setClips((prev) => prev.map((c) => c.id === selClip.id ? { ...c, textFontFamily: e.target.value } : c))}
                    disabled={isExporting}
                    style={{ fontFamily: "monospace", fontSize: 10, padding: "4px 6px", border: "1px solid #2a2a2a", background: "#fffdf5" }}
                  >
                    {TEXT_FONTS.map((font) => <option key={font} value={font}>{font}</option>)}
                  </select>
                  <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a" }}>size</span>
                  <input
                    type="range"
                    min={16}
                    max={140}
                    step={1}
                    value={selClip.textFontSize ?? DEFAULT_TEXT_SIZE}
                    onPointerDown={pushUndoSnapshot}
                    onChange={(e) => setClips((prev) => prev.map((c) => c.id === selClip.id ? { ...c, textFontSize: Number(e.target.value) } : c))}
                    disabled={isExporting}
                    style={{ width: 100 }}
                  />
                  <span style={{ minWidth: 30, fontSize: 10, fontFamily: "monospace", color: "#2a2a2a", fontWeight: 700 }}>
                    {Math.round(selClip.textFontSize ?? DEFAULT_TEXT_SIZE)}
                  </span>
                  <input
                    type="color"
                    value={selClip.textColor ?? DEFAULT_TEXT_COLOR}
                    onPointerDown={pushUndoSnapshot}
                    onChange={(e) => setClips((prev) => prev.map((c) => c.id === selClip.id ? { ...c, textColor: e.target.value } : c))}
                    disabled={isExporting}
                    style={{ width: 30, height: 24, border: "1px solid #2a2a2a", padding: 0, background: "#fffdf5" }}
                    title="Text color"
                  />
                </div>
              )}
              {hasClipAudio(selClip) && (
                <button
                  onClick={() => {
                    pushUndoSnapshot();
                    setClips((prev) => prev.map((c) => c.id === selClip.id ? { ...c, muted: !c.muted } : c));
                  }}
                  disabled={isExporting}
                  style={{ ...sketchButton, height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, background: selClip.muted ? "#ff5e3a" : undefined, color: selClip.muted ? "#fff" : undefined, opacity: isExporting ? 0.4 : 1 }}
                  title="Toggle mute for selected clip"
                >
                  {selClip.muted ? "Unmute" : "Mute"}
                </button>
              )}
              {hasClipAudio(selClip) && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, border: "1.5px solid #2a2a2a", background: "#fffdf5", padding: "4px 8px", boxShadow: "2px 2px 0 #2a2a2a" }}>
                  <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a" }}>speed</span>
                  <input
                    type="range"
                    min={MIN_PLAYBACK_RATE}
                    max={MAX_PLAYBACK_RATE}
                    step={0.05}
                    value={clipPlaybackRate(selClip)}
                    onPointerDown={pushUndoSnapshot}
                    onChange={(e) => updateClipPlaybackRate(selClip.id, Number(e.target.value))}
                    disabled={isExporting}
                    style={{ width: 130 }}
                  />
                  <span style={{ minWidth: 42, fontSize: 10, fontFamily: "monospace", color: "#2a2a2a", fontWeight: 700 }}>
                    {clipPlaybackRate(selClip).toFixed(2)}x
                  </span>
                  <button
                    onClick={() => {
                      pushUndoSnapshot();
                      updateClipPlaybackRate(selClip.id, 1);
                    }}
                    disabled={isExporting}
                    style={{ ...miniButton, fontSize: 10, padding: "2px 7px", opacity: isExporting ? 0.4 : 1 }}
                    title="Reset speed"
                  >
                    Reset
                  </button>
                </div>
              )}
              {isCroppableClip(selClip) && (
                cropDraft?.clipId === selClip.id ? (
                  <>
                    <button
                      onClick={finishCropMode}
                      disabled={isExporting}
                      style={{ ...sketchButton, height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, background: "#c8f135", opacity: isExporting ? 0.4 : 1 }}
                      title="Apply crop to selected clip"
                    >
                      Finish crop
                    </button>
                    <button
                      onClick={cancelCropMode}
                      disabled={isExporting}
                      style={{ ...sketchButton, height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, opacity: isExporting ? 0.4 : 1 }}
                      title="Cancel crop"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => startCropMode(selClip)}
                    disabled={isExporting}
                    style={{ ...sketchButton, height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, opacity: isExporting ? 0.4 : 1 }}
                    title="Crop selected photo or video"
                  >
                    Crop
                  </button>
                )
              )}
              {selClip.type === "video" && (
                <>
                  <button
                    onClick={() => {
                      pushUndoSnapshot();
                      setClips((prev) => prev.map((c) => c.id === selClip.id ? { ...c, removeGreenScreen: !c.removeGreenScreen } : c));
                    }}
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
                        onPointerDown={pushUndoSnapshot}
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
                        onPointerDown={pushUndoSnapshot}
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
                        onPointerDown={pushUndoSnapshot}
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
        <span style={{ fontSize: 9, fontFamily: "monospace", color: "#bbb" }}>[space] play/pause · [cmd/ctrl+z] undo · [⌫] delete selected</span>
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
          <div style={{ position: "relative", height: RULER_H, borderBottom: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.9)" }}>
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
            const label = `Layer ${layerNum}`;
            const layerClips = clips.filter((c) => c.layer === layerNum);
            const layerGhost = ghost?.layer === layerNum ? ghost : null;
            const layerMuted = !!mutedLayers[layerNum];
            return (
              <div key={layerNum} style={{ position: "relative", height: LAYER_H, borderBottom: `1px solid rgba(42,42,42,${layerNum === layerCount ? 0.3 : 0.1})`, background: layerBg(layerNum) }}>
                <span style={{ position: "absolute", left: 6, top: 7, fontSize: 9, fontFamily: "monospace", color: "rgba(42,42,42,0.28)", letterSpacing: 0.5, textTransform: "uppercase", pointerEvents: "none", userSelect: "none", zIndex: 0 }}>
                  {label}
                </span>
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); toggleLayerMute(layerNum); }}
                  disabled={isExporting}
                  style={{ position: "absolute", left: 6, bottom: 6, zIndex: 7, fontSize: 8, fontFamily: "monospace", padding: "1px 5px", border: "1px solid rgba(42,42,42,0.45)", background: layerMuted ? "#ff5e3a" : "rgba(255,253,245,0.88)", color: layerMuted ? "#fff" : "#2a2a2a", boxShadow: "1px 1px 0 rgba(42,42,42,0.35)", cursor: isExporting ? "default" : "pointer", opacity: isExporting ? 0.4 : 1 }}
                  title={layerMuted ? "Unmute this layer" : "Mute this layer"}
                >
                  {layerMuted ? "MUTED" : "MUTE"}
                </button>
                {layerClips.map((clip) => {
                  const isBeingDragged = ghost?.clipId === clip.id;
                  const clipPx = Math.max(HANDLE_W * 2 + 4, clip.durationSec * pxPerSec - 2);
                  const showHandles = clipPx >= HANDLE_W * 3;
                  const sortedCurve = clip.volumeCurve.slice().sort((a, b) => a.time - b.time);
                  const waveformBarCount = clip.type === "audio" && clip.waveform?.length
                    ? Math.max(10, Math.min(160, Math.floor(clipPx / 3)))
                    : 0;
                  const waveformH = LAYER_H - CURVE_H - 18;
                  const waveformSourceSpan = clipSourceSpan(clip);
                  const linePoints = sortedCurve.map((pt) => {
                    const px = clipPx > 0 ? (pt.time / clip.durationSec) * clipPx : 0;
                    const py = CURVE_H - 2 - (pt.volume / 100) * (CURVE_H - 4);
                    return `${px},${py}`;
                  }).join(" ");
                  return (
                    <div
                      key={clip.id}
                      onPointerDown={(e) => onClipPointerDown(e, clip)}
                      onDoubleClick={clip.type === "countdown" ? (e) => { e.stopPropagation(); openCountdownEditModal(clip); } : undefined}
                      style={{ position: "absolute", left: clip.startTime * pxPerSec, top: 7, width: clipPx, height: LAYER_H - 14, background: CLIP_COLORS[clip.type], opacity: isBeingDragged ? 0.28 : 1, border: selectedClipId === clip.id ? "2px solid #ff5e3a" : "1.5px solid #2a2a2a", boxShadow: isBeingDragged ? "none" : selectedClipId === clip.id ? "0 0 0 2px #ff5e3a44, 2px 2px 0 #2a2a2a" : "2px 2px 0 #2a2a2a", cursor: isBeingDragged ? "grabbing" : "grab", display: "flex", alignItems: "center", overflow: "hidden", zIndex: 2 }}
                    >
                      {showHandles && <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.18)", cursor: "ew-resize" }} />}
                      {waveformBarCount > 0 && (
                        <svg
                          style={{ position: "absolute", left: showHandles ? HANDLE_W + 2 : 4, right: showHandles ? HANDLE_W + 2 : 4, top: 6, height: waveformH, opacity: 0.55, pointerEvents: "none", zIndex: 1 }}
                          viewBox={`0 0 ${Math.max(1, clipPx - (showHandles ? HANDLE_W * 2 + 4 : 8))} ${waveformH}`}
                          preserveAspectRatio="none"
                        >
                          {Array.from({ length: waveformBarCount }, (_, i) => {
                            const innerW = Math.max(1, clipPx - (showHandles ? HANDLE_W * 2 + 4 : 8));
                            const x = (i / waveformBarCount) * innerW;
                            const sourceSec = clip.trimStart + (waveformBarCount <= 1 ? 0 : (i / (waveformBarCount - 1)) * waveformSourceSpan);
                            const peak = waveformValueAtSourceSec(clip, sourceSec);
                            const h = Math.max(1, peak * waveformH);
                            const y = (waveformH - h) / 2;
                            return (
                              <rect
                                key={i}
                                x={x}
                                y={y}
                                width={Math.max(1, innerW / waveformBarCount - 1)}
                                height={h}
                                rx={0.5}
                                fill="rgba(42,42,42,0.58)"
                              />
                            );
                          })}
                        </svg>
                      )}
                      {clip.type === "image" && clipPx >= 54 && !isBeingDragged && (
                        <select
                          title="Image entry sound"
                          value={clip.entrySfxId ?? ""}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => handleEntrySfxSelect(clip.id, e.target.value)}
                          style={{
                            position: "absolute",
                            right: showHandles ? HANDLE_W + 2 : 2,
                            top: 2,
                            width: clipPx >= 84 ? 46 : 30,
                            height: 17,
                            zIndex: 8,
                            fontFamily: "monospace",
                            fontSize: 8,
                            lineHeight: "17px",
                            padding: "0 1px",
                            border: "1px solid #2a2a2a",
                            background: clip.entrySfxId ? "#c8f135" : "rgba(255,253,245,0.92)",
                            color: "#2a2a2a",
                            boxShadow: "1px 1px 0 #2a2a2a",
                            cursor: "pointer",
                          }}
                        >
                          <option value="">♪</option>
                          {entrySfxOptions.map((option) => (
                            <option key={option.id} value={option.id}>{option.custom ? "+ " : ""}{option.label}</option>
                          ))}
                          <option value="__upload">+ Add SFX...</option>
                        </select>
                      )}
                      <div style={{ position: "relative", zIndex: 2, paddingLeft: showHandles ? HANDLE_W + 4 : 5, paddingRight: showHandles ? HANDLE_W + 4 : 5, paddingBottom: CURVE_H, overflow: "hidden", flexGrow: 1, pointerEvents: "none" }}>
                        <div style={{ fontSize: 10, fontFamily: "'Courier New', monospace", fontWeight: 700, color: "#2a2a2a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{clip.name}</div>
                        <div style={{ fontSize: 9, fontFamily: "monospace", color: "#555", whiteSpace: "nowrap" }}>{formatDuration(clip.durationSec)}</div>
                      </div>
                      {showHandles && <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.18)", cursor: "ew-resize" }} />}
                      {/* Reveal offset handles — countdown clips only */}
                      {clip.type === "countdown" && (clip.revealOffsets ?? []).map((offset, hi) => {
                        const handlePx = clipPx > 0 ? clamp((offset / clip.durationSec) * clipPx, 0, clipPx) : 0;
                        return (
                          <div
                            key={hi}
                            onPointerDown={(e) => onRevealHandlePointerDown(e, clip, hi)}
                            style={{ position: "absolute", left: handlePx - 3, top: 0, bottom: 0, width: 6, zIndex: 5, cursor: "ew-resize", display: "flex", alignItems: "center", justifyContent: "center" }}
                          >
                            <div style={{ width: 2, height: "70%", background: "rgba(42,42,42,0.65)", borderRadius: 1, pointerEvents: "none" }} />
                          </div>
                        );
                      })}
                      {/* Volume curve SVG — audio and video clips only */}
                      {hasClipAudio(clip) && (
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
                            pushUndoSnapshot();
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
                                  pushUndoSnapshot();
                                  setClips((prev) => prev.map((c) => c.id !== clip.id ? c : {
                                    ...c,
                                    volumeCurve: c.volumeCurve.filter((_, i) => i !== ptIdx),
                                  }));
                                }}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  pushUndoSnapshot();
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
                  <div style={{ position: "absolute", left: layerGhost.startTime * pxPerSec, top: 5, width: Math.max(4, layerGhost.durationSec * pxPerSec - 2), height: LAYER_H - 10, background: CLIP_COLORS[layerGhost.type], opacity: 0.6, border: "2px dashed #2a2a2a", boxShadow: "3px 3px 10px rgba(42,42,42,0.22)", pointerEvents: "none", zIndex: 6, transform: "scale(1.03)", transformOrigin: "center center" }} />
                )}
                {recGrowingBar?.layer === layerNum && (
                  <div style={{ position: "absolute", left: recGrowingBar.startSec * pxPerSec, top: 7, width: Math.max(2, recGrowingBar.elapsedSec * pxPerSec), height: LAYER_H - 14, background: "rgba(255,94,58,0.22)", border: "2px solid #ff5e3a", pointerEvents: "none", zIndex: 5, display: "flex", alignItems: "center", paddingLeft: 5, overflow: "hidden" }}>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: "#ff5e3a", fontWeight: 700, whiteSpace: "nowrap" }}>REC</span>
                  </div>
                )}
              </div>
            );
          })}

          {/* Add Layer placeholder row */}
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

          {/* Magnetic snap guide */}
          {snapGuideSec !== null && (
            <div style={{ position: "absolute", left: snapGuideSec * pxPerSec, top: 0, bottom: 0, width: 1, background: "rgba(80,200,255,0.9)", zIndex: 9, pointerEvents: "none", boxShadow: "0 0 4px rgba(80,200,255,0.6)" }} />
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
        </div>

        {isShortFormat && (
          <aside style={{
            width: "min(38vw, 390px)",
            minWidth: 300,
            flexShrink: 0,
            borderLeft: "1.5px solid rgba(42,42,42,0.15)",
            background: "rgba(255,253,245,0.72)",
            display: "flex",
            justifyContent: "center",
            overflowY: "auto",
          }}>
            {renderPreviewPanel("side")}
          </aside>
        )}
      </div>

      {/* Countdown Modal */}
      {countdownModalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setCountdownModalOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 460, maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", fontFamily: "monospace", overflow: "hidden" }}>
            <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>
                {countdownEditClipId ? "✏ EDIT COUNTDOWN LIST" : "↓ NEW COUNTDOWN LIST"}
              </span>
              <button onClick={() => setCountdownModalOpen(false)} style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15 }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Title */}
              <div>
                <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 4 }}>Title</div>
                <input
                  autoFocus
                  type="text"
                  value={countdownDraftTitle}
                  onChange={(e) => setCountdownDraftTitle(e.target.value)}
                  placeholder="Top 5"
                  style={{ width: "100%", fontFamily: "monospace", fontSize: 13, padding: "7px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a", boxSizing: "border-box" }}
                />
              </div>
              {/* Count */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 10, color: "#6a6a6a" }}>Number of items</div>
                <input
                  type="number"
                  min={2}
                  max={10}
                  value={countdownDraftCount}
                  onChange={(e) => {
                    const n = clamp(Math.round(Number(e.target.value)), 2, 10);
                    setCountdownDraftCount(n);
                    setCountdownDraftLabels((prev) => {
                      const next = [...prev];
                      while (next.length < n) next.push("");
                      return next.slice(0, n);
                    });
                  }}
                  style={{ width: 60, fontFamily: "monospace", fontSize: 13, padding: "5px 8px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none" }}
                />
              </div>
              {/* Items — listed rank 1 at top for easy entry */}
              <div>
                <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 6 }}>Items (rank 1 = revealed last / #1 pick)</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {Array.from({ length: countdownDraftCount }, (_, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#2a2a2a", minWidth: 24, textAlign: "right" }}>{i + 1}.</span>
                      <input
                        type="text"
                        value={countdownDraftLabels[i] ?? ""}
                        onChange={(e) => setCountdownDraftLabels((prev) => {
                          const next = [...prev];
                          next[i] = e.target.value;
                          return next;
                        })}
                        placeholder={`Item ${i + 1}`}
                        style={{ flex: 1, fontFamily: "monospace", fontSize: 12, padding: "5px 8px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none" }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setCountdownModalOpen(false)} style={{ ...miniButton, padding: "7px 16px", fontSize: 12 }}>Cancel</button>
              <button
                onClick={confirmCountdownModal}
                disabled={!countdownDraftTitle.trim()}
                style={{ ...sketchButton, padding: "7px 20px", fontSize: 12, background: COUNTDOWN_COLOR, opacity: countdownDraftTitle.trim() ? 1 : 0.4 }}
              >
                {countdownEditClipId ? "Save" : "Add to timeline"}
              </button>
            </div>
          </div>
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

      {/* Saved Videos button */}
      {!savedVideosOpen && (
        <button
          onClick={() => { setSavedVideosOpen(true); fetchLibrary(); }}
          style={{ position: "fixed", bottom: 16, right: 16, zIndex: 900, fontFamily: "monospace", fontSize: 11, fontWeight: 700, background: "#4caf7d", color: "#fff", border: "1.5px solid #2a2a2a", padding: "7px 14px", cursor: "pointer", boxShadow: "2px 2px 0 #2a2a2a", letterSpacing: 0.5 }}
        >
          ▶ Saved Videos
        </button>
      )}

      {/* Saved Videos side panel */}
      {savedVideosOpen && (
        <>
          <div onClick={() => setSavedVideosOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 950 }} />
          <div style={{ position: "fixed", right: 0, top: 0, bottom: 0, width: 300, background: "#fffdf5", borderLeft: "2px solid #2a2a2a", zIndex: 960, display: "flex", flexDirection: "column", fontFamily: "monospace", boxShadow: "-4px 0 0 rgba(42,42,42,0.18)", animation: "nbslide-in 0.18s ease" }}>
            <div style={{ padding: "12px 14px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Saved Videos</span>
              <button onClick={() => setSavedVideosOpen(false)} style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15 }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
              {savedVideosLoading && (
                <div style={{ fontSize: 11, color: "#6a6a6a", textAlign: "center", paddingTop: 32 }}>Loading…</div>
              )}
              {savedVideosError && !savedVideosLoading && (
                <div style={{ fontSize: 11, color: "#ff3a3a", textAlign: "center", paddingTop: 32 }}>
                  {savedVideosError}
                  <button onClick={fetchLibrary} style={{ ...miniButton, display: "block", margin: "10px auto 0", fontSize: 11, padding: "4px 12px" }}>Retry</button>
                </div>
              )}
              {!savedVideosLoading && !savedVideosError && savedVideos.length === 0 && (
                <div style={{ fontSize: 11, color: "#6a6a6a", textAlign: "center", paddingTop: 40, lineHeight: 1.7 }}>
                  No saved videos yet.<br />Add a YouTube clip to start your library.
                </div>
              )}
              {!savedVideosLoading && !savedVideosError && savedVideos.map((v) => (
                <div
                  key={v.id}
                  onClick={() => openFromLibrary(v)}
                  style={{ display: "flex", gap: 8, padding: "9px 0", borderBottom: "1px solid rgba(42,42,42,0.1)", cursor: "pointer", alignItems: "flex-start" }}
                >
                  <div style={{ flexShrink: 0, width: 72, height: 40, background: "#000", overflow: "hidden", border: "1px solid rgba(42,42,42,0.2)" }}>
                    {v.thumbnail_url && <img src={v.thumbnail_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>
                      {v.title || "(no title)"}
                    </div>
                    {v.duration_seconds > 0 && (
                      <div style={{ fontSize: 9, color: "#6a6a6a", marginTop: 3 }}>{formatDuration(v.duration_seconds)}</div>
                    )}
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteLibraryEntry(v.id); }}
                    style={{ ...miniButton, flexShrink: 0, alignSelf: "center", padding: "2px 6px", fontSize: 14, lineHeight: 1 }}
                    title="Remove from library"
                  >×</button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 60, left: "50%", transform: "translateX(-50%)", background: "#2a2a2a", color: "#fffdf5", padding: "7px 18px", fontSize: 11, fontFamily: "monospace", zIndex: 9999, boxShadow: "2px 2px 0 rgba(0,0,0,0.3)", animation: "nbtoast 0.2s ease", whiteSpace: "nowrap" }}>
          {toast}
        </div>
      )}

      {signInPrompt && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(42,42,42,0.72)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", padding: "28px 28px", maxWidth: 340, width: "100%", textAlign: "center" }}>
            <h2 style={{ fontFamily: "'Caveat', cursive", fontSize: 30, color: "#2a2a2a", marginBottom: 6 }}>Sign in to continue</h2>
            <p style={{ fontFamily: "monospace", fontSize: 12, color: "#6a6a6a", marginBottom: 24 }}>{signInPrompt}</p>
            <button onClick={() => { setSignInPrompt(null); signIn("google", { callbackUrl: "/editor" }); }} style={primaryButtonStyle}>
              Sign in with Google
            </button>
            <button onClick={() => setSignInPrompt(null)} style={{ ...miniButton, marginTop: 12, display: "block", width: "100%", padding: "8px", fontSize: 11 }}>
              cancel
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function PreviewVideo({ clip, playheadSec, isPlaying, disableCrop = false }: { clip: Clip; playheadSec: number; isPlaying: boolean; disableCrop?: boolean }) {
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
      style={disableCrop ? { width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" } : cropMediaStyle(clip)}
    />
  );
}

function KeyedPreviewVideo({ clip, playheadSec, isPlaying, disableCrop = false }: { clip: Clip; playheadSec: number; isPlaying: boolean; disableCrop?: boolean }) {
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
      drawMaybeKeyedMedia(ctx, vid, drawRect.x, drawRect.y, drawRect.w, drawRect.h, disableCrop ? { ...clip, cropZoom: DEFAULT_CROP_ZOOM, cropX: DEFAULT_CROP_X, cropY: DEFAULT_CROP_Y } : clip);
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
  }, [clip.id, clip.blobUrl, clip.playbackRate, disableCrop]);

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
  }, [playheadSec, clip.chromaSimilarity, clip.chromaSmoothness, clip.chromaAmount, clip.cropZoom, clip.cropX, clip.cropY, disableCrop]);

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
  }, [isPlaying, clip.chromaSimilarity, clip.chromaSmoothness, clip.chromaAmount, clip.cropZoom, clip.cropX, clip.cropY, disableCrop]);

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
