"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession, signIn } from "next-auth/react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Keyframe = {
  time: number;     // seconds relative to clip.startTime
  x: number;        // center X on output canvas
  y: number;        // center Y on output canvas
  scale: number;    // 1 = natural size
  opacity: number;  // 0–1
};

type Clip = {
  id: string;
  type: "image" | "video";
  name: string;
  sourceUrl: string;
  startTime: number;  // seconds on timeline
  duration: number;   // seconds
  keyframes: Keyframe[];
};

type MediaItem = {
  id: string;
  name: string;
  type: "image" | "video";
  url: string;
  duration?: number;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const CANVAS_W_LAND = 1920;
const CANVAS_H_LAND = 1080;
const DEFAULT_PX_PER_SEC = 100;
const RULER_H = 28;
const TRACK_H = 48;
const HANDLE_W = 6;
const CLIP_COLORS = ["#c8f135", "#5ec4ff", "#ff9f5e", "#d4a8ff", "#ff6b9d", "#7df5b0"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 0;
function generateId(): string {
  return `b2_${Date.now()}_${++_idCounter}`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Returns interpolated {x, y, scale, opacity} at `time` seconds (relative to clip start).
 * Clamps to first/last keyframe outside the range.
 */
function interpolateKeyframes(
  keyframes: Keyframe[],
  time: number
): { x: number; y: number; scale: number; opacity: number } {
  if (keyframes.length === 0) return { x: CANVAS_W_LAND / 2, y: CANVAS_H_LAND / 2, scale: 1, opacity: 1 };

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  if (time <= sorted[0].time) {
    const { x, y, scale, opacity } = sorted[0];
    return { x, y, scale, opacity };
  }
  if (time >= sorted[sorted.length - 1].time) {
    const { x, y, scale, opacity } = sorted[sorted.length - 1];
    return { x, y, scale, opacity };
  }

  let lo = 0;
  while (lo < sorted.length - 2 && sorted[lo + 1].time <= time) lo++;
  const a = sorted[lo];
  const b = sorted[lo + 1];
  const t = (time - a.time) / (b.time - a.time);

  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    scale: lerp(a.scale, b.scale, t),
    opacity: lerp(a.opacity, b.opacity, t),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function getVideoDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const vid = document.createElement("video");
    vid.src = url;
    vid.onloadedmetadata = () => resolve(isFinite(vid.duration) ? vid.duration : 5);
    vid.onerror = () => resolve(5);
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Board2Page() {
  const { data: session } = useSession();

  // ─ State ──────────────────────────────────────────────────────────────────
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

  // ─ Derived ────────────────────────────────────────────────────────────────
  const canvasW = canvasAspect === "16:9" ? CANVAS_W_LAND : CANVAS_H_LAND;
  const canvasH = canvasAspect === "16:9" ? CANVAS_H_LAND : CANVAS_W_LAND;
  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;
  const timelineDuration = Math.max(10, ...clips.map((c) => c.startTime + c.duration + 2));
  const timelineWidth = timelineDuration * pxPerSec;

  // ─ Refs (stale-closure safe mirrors) ──────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clipsRef = useRef<Clip[]>(clips);
  const playheadRef = useRef(0);
  const isPlayingRef = useRef(false);
  const canvasWRef = useRef(canvasW);
  const canvasHRef = useRef(canvasH);
  const lastRafTimeRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const mediaUploadRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const videoCacheRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const exportCancelRef = useRef(false);
  const exportRafRef = useRef<number | null>(null);
  const isExportingRef = useRef(false);

  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { playheadRef.current = playhead; }, [playhead]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { canvasWRef.current = canvasW; canvasHRef.current = canvasH; }, [canvasW, canvasH]);

  // ─ Canvas draw ────────────────────────────────────────────────────────────

  const renderToCtx = useCallback((
    ctx: CanvasRenderingContext2D,
    time: number,
    currentClips: Clip[],
    W: number,
    H: number
  ) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, W, H);

    const active = currentClips
      .filter((c) => time >= c.startTime && time < c.startTime + c.duration)
      .sort((a, b) => a.startTime - b.startTime);

    for (const clip of active) {
      const relTime = time - clip.startTime;
      const { x, y, scale, opacity } = interpolateKeyframes(clip.keyframes, relTime);
      ctx.globalAlpha = clamp(opacity, 0, 1);

      if (clip.type === "image") {
        const img = imgCacheRef.current.get(clip.sourceUrl);
        if (img?.complete && img.naturalWidth > 0) {
          const w = img.naturalWidth * scale;
          const h = img.naturalHeight * scale;
          ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
        }
      } else {
        const vid = videoCacheRef.current.get(clip.sourceUrl);
        if (vid && vid.readyState >= 2) {
          const w = (vid.videoWidth || 640) * scale;
          const h = (vid.videoHeight || 360) * scale;
          ctx.drawImage(vid, x - w / 2, y - h / 2, w, h);
        }
      }

      ctx.globalAlpha = 1;
    }
  }, []);

  const drawFrame = useCallback((time: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderToCtx(ctx, time, clipsRef.current, canvasWRef.current, canvasHRef.current);
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
        playheadRef.current = maxEnd;
        setPlayhead(maxEnd);
        setIsPlaying(false);
        isPlayingRef.current = false;
        drawFrame(maxEnd);
        return;
      }
      playheadRef.current = next;
      setPlayhead(next);
    }
    lastRafTimeRef.current = now;
    drawFrame(playheadRef.current);
    rafIdRef.current = requestAnimationFrame(rafLoop);
  }, [drawFrame]);

  useEffect(() => {
    if (isPlaying) {
      lastRafTimeRef.current = null;
      rafIdRef.current = requestAnimationFrame(rafLoop);
    } else {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    };
  }, [isPlaying, rafLoop]);

  // Redraw on scrub / clip change (not during playback — RAF handles that)
  useEffect(() => {
    if (!isPlaying) drawFrame(playhead);
  }, [playhead, clips, canvasAspect, isPlaying, drawFrame]);

  // ─ Seek video elements on scrub ───────────────────────────────────────────

  useEffect(() => {
    if (isPlaying) return;
    for (const clip of clipsRef.current) {
      if (clip.type !== "video") continue;
      const vid = videoCacheRef.current.get(clip.sourceUrl);
      if (!vid) continue;
      const relTime = playhead - clip.startTime;
      if (relTime >= 0 && relTime <= clip.duration) {
        vid.currentTime = relTime;
      }
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
        vid.muted = true;
        vid.preload = "auto";
        vid.src = url;
        videoCacheRef.current.set(url, vid);
      }
    }
  }

  // ─ Media upload ───────────────────────────────────────────────────────────

  async function handleMediaUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const type: "image" | "video" = file.type.startsWith("video") ? "video" : "image";
      const duration = type === "video" ? await getVideoDuration(url) : undefined;
      const item: MediaItem = { id: generateId(), name: file.name, type, url, duration };
      setMediaLibrary((prev) => [...prev, item]);
      loadMedia(url, type);
    }
    e.target.value = "";
  }

  // ─ Add clip ───────────────────────────────────────────────────────────────

  function makeClip(item: MediaItem, startTime: number): Clip {
    const duration = item.duration ?? (item.type === "video" ? 5 : 4);
    return {
      id: generateId(),
      type: item.type,
      name: item.name,
      sourceUrl: item.url,
      startTime,
      duration,
      keyframes: [{ time: 0, x: canvasWRef.current / 2, y: canvasHRef.current / 2, scale: 1, opacity: 1 }],
    };
  }

  function addClipToTimeline(item: MediaItem) {
    loadMedia(item.url, item.type);
    const clip = makeClip(item, playheadRef.current);
    setClips((prev) => [...prev, clip]);
    setSelectedClipId(clip.id);
  }

  // ─ Keyframe editing ───────────────────────────────────────────────────────

  function addKeyframe() {
    if (!selectedClip) return;
    const relTime = parseFloat(Math.max(0, playhead - selectedClip.startTime).toFixed(3));
    if (selectedClip.keyframes.some((kf) => Math.abs(kf.time - relTime) < 0.05)) return;
    const interp = interpolateKeyframes(selectedClip.keyframes, relTime);
    const newKf: Keyframe = { time: relTime, ...interp };
    setClips((prev) =>
      prev.map((c) =>
        c.id !== selectedClip.id
          ? c
          : { ...c, keyframes: [...c.keyframes, newKf].sort((a, b) => a.time - b.time) }
      )
    );
  }

  function updateKeyframe(kfIndex: number, field: keyof Keyframe, raw: string) {
    if (!selectedClip) return;
    const value = parseFloat(raw);
    if (isNaN(value)) return;
    setClips((prev) =>
      prev.map((c) => {
        if (c.id !== selectedClip.id) return c;
        const kfs = c.keyframes.map((kf, i) => (i === kfIndex ? { ...kf, [field]: value } : kf));
        return { ...c, keyframes: kfs.sort((a, b) => a.time - b.time) };
      })
    );
  }

  function deleteKeyframe(kfIndex: number) {
    if (!selectedClip || selectedClip.keyframes.length <= 1) return;
    setClips((prev) =>
      prev.map((c) =>
        c.id !== selectedClip.id
          ? c
          : { ...c, keyframes: c.keyframes.filter((_, i) => i !== kfIndex) }
      )
    );
  }

  // ─ Timeline clip dragging ─────────────────────────────────────────────────

  function handleClipPointerDown(
    e: React.PointerEvent,
    clip: Clip,
    kind: "move" | "resize-left" | "resize-right"
  ) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedClipId(clip.id);

    const origStart = clip.startTime;
    const origDuration = clip.duration;
    const startX = e.clientX;

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / pxPerSec;
      setClips((prev) =>
        prev.map((c) => {
          if (c.id !== clip.id) return c;
          if (kind === "move") {
            return { ...c, startTime: Math.max(0, origStart + dx) };
          }
          if (kind === "resize-right") {
            return { ...c, duration: Math.max(0.1, origDuration + dx) };
          }
          // resize-left
          const newStart = Math.max(0, origStart + dx);
          const delta = newStart - origStart;
          return { ...c, startTime: newStart, duration: Math.max(0.1, origDuration - delta) };
        })
      );
    };
    const onUp = () => {
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
      const x = clientX - rect.left + timelineScroll;
      setPlayhead(Math.max(0, x / pxPerSec));
    };
    scrub(e.clientX);
    const onMove = (ev: PointerEvent) => scrub(ev.clientX);
    const onUp = () => {
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
    const x = e.clientX - rect.left + timelineScroll;
    const startTime = Math.max(0, x / pxPerSec);
    loadMedia(item.url, item.type);
    const clip = makeClip(item, startTime);
    setClips((prev) => [...prev, clip]);
    setSelectedClipId(clip.id);
  }

  // ─ Play / pause ───────────────────────────────────────────────────────────

  function togglePlay() {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    const maxEnd = clips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    if (playhead >= maxEnd && maxEnd > 0) setPlayhead(0);
    setIsPlaying(true);
  }

  // ─ Ruler ticks ────────────────────────────────────────────────────────────

  function rulerTicks() {
    const step = pxPerSec >= 100 ? 1 : pxPerSec >= 50 ? 2 : 5;
    const ticks = [];
    for (let t = 0; t <= timelineDuration; t += step) {
      ticks.push(
        <div
          key={t}
          style={{ position: "absolute", left: t * pxPerSec, top: 0, bottom: 0, borderLeft: "1px solid rgba(42,42,42,0.2)", pointerEvents: "none" }}
        >
          <span style={{ position: "absolute", top: 3, left: 3, fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", userSelect: "none" }}>
            {t}s
          </span>
        </div>
      );
    }
    return ticks;
  }

  // ─ Export ─────────────────────────────────────────────────────────────────

  function cancelExport() {
    exportCancelRef.current = true;
  }

  async function startExport() {
    if (clips.length === 0) {
      alert("No clips to export");
      return;
    }
    if (isPlayingRef.current) setIsPlaying(false);

    setIsExporting(true);
    isExportingRef.current = true;
    exportCancelRef.current = false;
    setExportProgress(0);

    const currentClips = clipsRef.current;
    const totalDur = currentClips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const W = canvasWRef.current;
    const H = canvasHRef.current;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = W;
    exportCanvas.height = H;
    const exportCtx = exportCanvas.getContext("2d")!;

    // Seed video elements active at t=0
    for (const clip of currentClips) {
      if (clip.type !== "video") continue;
      const vid = videoCacheRef.current.get(clip.sourceUrl);
      if (!vid) continue;
      if (clip.startTime === 0) {
        vid.currentTime = 0;
        vid.play().catch(() => {});
      } else {
        vid.pause();
        vid.currentTime = 0;
      }
    }

    const canvasStream = exportCanvas.captureStream(30);
    const mimeType = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "video/webm";
    const recorder = new MediaRecorder(canvasStream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = mimeType === "video/mp4" ? "board2-export.mp4" : "board2-export.webm";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      for (const vid of videoCacheRef.current.values()) vid.pause();
      setIsExporting(false);
      isExportingRef.current = false;
      setExportProgress(0);
    };

    recorder.start(100);

    const exportWallStart = performance.now();

    function exportFrame() {
      if (exportCancelRef.current) {
        for (const vid of videoCacheRef.current.values()) vid.pause();
        recorder.stop();
        setIsExporting(false);
        isExportingRef.current = false;
        setExportProgress(0);
        return;
      }

      const elapsed = (performance.now() - exportWallStart) / 1000;

      if (elapsed >= totalDur) {
        for (const vid of videoCacheRef.current.values()) vid.pause();
        recorder.stop();
        return;
      }

      setExportProgress(elapsed / totalDur);

      // Manage video element lifecycle
      for (const clip of currentClips) {
        if (clip.type !== "video") continue;
        const vid = videoCacheRef.current.get(clip.sourceUrl);
        if (!vid) continue;
        const isActive = elapsed >= clip.startTime && elapsed < clip.startTime + clip.duration;
        if (isActive && vid.paused) {
          vid.currentTime = elapsed - clip.startTime;
          vid.play().catch(() => {});
        } else if (!isActive && !vid.paused) {
          vid.pause();
        }
      }

      renderToCtx(exportCtx, elapsed, currentClips, W, H);

      exportRafRef.current = requestAnimationFrame(exportFrame);
    }

    exportRafRef.current = requestAnimationFrame(exportFrame);
  }

  // ─ Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      if (e.code === "KeyK") { addKeyframe(); }
      if (e.code === "Delete" || e.code === "Backspace") {
        if (selectedClipId) {
          setClips((prev) => prev.filter((c) => c.id !== selectedClipId));
          setSelectedClipId(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={pageStyle}>
      <style>{`@keyframes nbpulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      {/* ── Header ── */}
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: "#2a2a2a" }}>Neural Board</span>
          <span style={{ fontSize: 11, color: "#6a6a6a", letterSpacing: 1, fontFamily: "monospace" }}>/ BOARD 2.0</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
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

        {/* Top row: media | canvas | properties */}
        <div style={{ display: "flex", flex: 1, minHeight: 0, borderBottom: "1.5px solid rgba(42,42,42,0.15)" }}>

          {/* ── Left: media library ── */}
          <div style={{ width: 210, flexShrink: 0, borderRight: "1.5px solid rgba(42,42,42,0.15)", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", background: "rgba(255,253,245,0.65)" }}>
            <div style={panelLabelStyle}>Media Library</div>
            <button onClick={() => mediaUploadRef.current?.click()} style={sketchButton}>↑ Upload media</button>
            <input
              ref={mediaUploadRef}
              type="file"
              accept="image/*,video/*"
              multiple
              style={{ display: "none" }}
              onChange={handleMediaUpload}
            />

            {mediaLibrary.length === 0 && (
              <p style={{ fontSize: 10, color: "#9a9a9a", fontFamily: "monospace", lineHeight: 1.6, margin: "4px 0 0" }}>
                Upload images or videos, then click to add to timeline.
              </p>
            )}

            {mediaLibrary.map((item) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("mediaItemId", item.id)}
                onClick={() => addClipToTimeline(item)}
                title="Click to add at playhead · Drag to timeline"
                style={mediaItemStyle}
              >
                <span style={{ fontSize: 13, flexShrink: 0 }}>{item.type === "video" ? "▶" : "□"}</span>
                <div style={{ overflow: "hidden", flex: 1 }}>
                  <div style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", fontSize: 10 }}>{item.name}</div>
                  {item.duration !== undefined && (
                    <div style={{ color: "#9a9a9a", fontSize: 9, marginTop: 1 }}>{item.duration.toFixed(1)}s</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* ── Center: preview canvas ── */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "14px 16px", background: "rgba(20,20,20,0.04)", position: "relative" }}>

            {/* Aspect toggle + Export button */}
            <div style={{ position: "absolute", top: 10, right: 10, display: "flex", alignItems: "center", gap: 6 }}>
              {isExporting && (
                <span style={{ fontSize: 10, fontFamily: "monospace", color: "#ff5e3a" }}>
                  {Math.round(exportProgress * 100)}%
                </span>
              )}
              <button
                onClick={isExporting ? cancelExport : startExport}
                style={{ ...sketchButton, padding: "4px 10px", fontSize: 11, background: isExporting ? "#ff5e3a" : "#c8f135", color: isExporting ? "#fff" : "#2a2a2a" }}
                title={isExporting ? "Cancel export" : "Export video"}
              >
                {isExporting ? `✕ Cancel` : "⬇ Export"}
              </button>
              <div style={{ display: "flex", gap: 4 }}>
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

            {/* Canvas */}
            <div style={{ flex: 1, minHeight: 0, width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <canvas
                ref={canvasRef}
                width={canvasW}
                height={canvasH}
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  border: "1.5px solid #2a2a2a",
                  boxShadow: "4px 4px 0 #2a2a2a",
                  background: "#111",
                  display: "block",
                }}
              />
            </div>

            {/* Playback controls */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexShrink: 0 }}>
              <button
                onClick={togglePlay}
                style={{ ...sketchButton, width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, background: isPlaying ? "#ff5e3a" : "#c8f135" }}
              >
                {isPlaying ? "■" : "▶"}
              </button>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "#6a6a6a", minWidth: 56 }}>{formatTime(playhead)}</span>
              <button onClick={() => { setPlayhead(0); setIsPlaying(false); }} style={miniButton}>↩ reset</button>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 9, fontFamily: "monospace", color: "#9a9a9a" }}>zoom</span>
                <button onClick={() => setPxPerSec((p) => clamp(p / 1.5, 10, 500))} style={miniButton}>−</button>
                <button onClick={() => setPxPerSec((p) => clamp(p * 1.5, 10, 500))} style={miniButton}>+</button>
              </div>
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#9a9a9a" }}>space=play · K=keyframe · Del=delete clip</span>
            </div>
          </div>

          {/* ── Right: properties panel ── */}
          <div style={{ width: 280, flexShrink: 0, borderLeft: "1.5px solid rgba(42,42,42,0.15)", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", background: "rgba(255,253,245,0.65)" }}>
            <div style={panelLabelStyle}>Properties</div>

            {!selectedClip && (
              <p style={{ fontSize: 10, color: "#9a9a9a", fontFamily: "monospace", lineHeight: 1.6, margin: 0 }}>
                Select a clip to edit its keyframes.
              </p>
            )}

            {selectedClip && (
              <>
                <div style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selectedClip.name}
                </div>
                <div style={{ fontSize: 10, fontFamily: "monospace", color: "#6a6a6a" }}>
                  {selectedClip.startTime.toFixed(2)}s → {(selectedClip.startTime + selectedClip.duration).toFixed(2)}s &nbsp;({selectedClip.duration.toFixed(2)}s)
                </div>

                <button
                  onClick={addKeyframe}
                  style={{ ...sketchButton, padding: "6px 10px", fontSize: 11, background: "#c8f135" }}
                >
                  + Add keyframe at {formatTime(Math.max(0, playhead - selectedClip.startTime))}
                </button>

                <div style={{ ...panelLabelStyle, marginTop: 4 }}>
                  Keyframes ({selectedClip.keyframes.length})
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {selectedClip.keyframes.map((kf, i) => (
                    <div key={i} style={kfCardStyle}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontFamily: "monospace", fontSize: 10, fontWeight: 700 }}>t = {kf.time.toFixed(2)}s</span>
                        {selectedClip.keyframes.length > 1 && (
                          <button
                            onClick={() => deleteKeyframe(i)}
                            style={{ ...miniButton, color: "#ff5e3a", borderColor: "#ff5e3a", fontSize: 9 }}
                          >
                            ✕
                          </button>
                        )}
                      </div>

                      {(["x", "y", "scale", "opacity"] as const).map((field) => (
                        <div key={field} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                          <span style={{ fontFamily: "monospace", fontSize: 9, color: "#6a6a6a", width: 44, flexShrink: 0 }}>{field}</span>
                          <input
                            type="number"
                            value={kf[field]}
                            step={field === "scale" || field === "opacity" ? 0.05 : 1}
                            min={field === "opacity" ? 0 : field === "scale" ? 0 : undefined}
                            max={field === "opacity" ? 1 : undefined}
                            onChange={(e) => updateKeyframe(i, field, e.target.value)}
                            style={{ flex: 1, fontFamily: "monospace", fontSize: 10, padding: "2px 4px", border: "1px solid rgba(42,42,42,0.4)", background: "#fff", minWidth: 0 }}
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => { setClips((prev) => prev.filter((c) => c.id !== selectedClip.id)); setSelectedClipId(null); }}
                  style={{ ...miniButton, color: "#ff5e3a", borderColor: "#ff5e3a", marginTop: "auto", alignSelf: "flex-start" }}
                >
                  ✕ Delete clip
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Bottom: timeline ── */}
        <div style={{ height: RULER_H + TRACK_H + 20, flexShrink: 0, background: "rgba(255,253,245,0.85)", display: "flex", flexDirection: "column" }}>

          {/* Ruler */}
          <div
            style={{ height: RULER_H, position: "relative", overflow: "hidden", borderBottom: "1px solid rgba(42,42,42,0.12)", background: "rgba(42,42,42,0.04)", cursor: "col-resize", flexShrink: 0 }}
            onPointerDown={handleRulerPointerDown}
          >
            <div style={{ position: "absolute", left: -timelineScroll, top: 0, width: timelineWidth, height: "100%", pointerEvents: "none" }}>
              {rulerTicks()}
            </div>
            {/* Playhead needle on ruler */}
            <div style={{ position: "absolute", left: playhead * pxPerSec - timelineScroll, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none" }} />
          </div>

          {/* Track */}
          <div
            ref={timelineRef}
            style={{ flex: 1, position: "relative", overflowX: "auto", overflowY: "hidden" }}
            onScroll={(e) => setTimelineScroll((e.target as HTMLDivElement).scrollLeft)}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement) === timelineRef.current) {
                setSelectedClipId(null);
                const rect = timelineRef.current!.getBoundingClientRect();
                const x = e.clientX - rect.left + timelineScroll;
                setPlayhead(Math.max(0, x / pxPerSec));
                setIsPlaying(false);
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleTimelineDrop}
          >
            <div style={{ position: "relative", width: timelineWidth, minHeight: TRACK_H, height: "100%" }}>
              {/* Lane stripe */}
              <div style={{ position: "absolute", inset: 0, background: "rgba(100,130,180,0.05)", borderTop: "1px solid rgba(42,42,42,0.08)" }} />

              {/* Clips */}
              {clips.map((clip, ci) => {
                const color = CLIP_COLORS[ci % CLIP_COLORS.length];
                const selected = clip.id === selectedClipId;
                return (
                  <div
                    key={clip.id}
                    style={{
                      position: "absolute",
                      left: clip.startTime * pxPerSec,
                      top: 4,
                      width: Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSec),
                      height: TRACK_H - 8,
                      background: color,
                      border: selected ? "2px solid #2a2a2a" : "1.5px solid rgba(42,42,42,0.35)",
                      boxShadow: selected ? "2px 2px 0 #2a2a2a" : "none",
                      cursor: "grab",
                      userSelect: "none",
                      overflow: "hidden",
                      display: "flex",
                      alignItems: "center",
                    }}
                    onClick={(e) => { e.stopPropagation(); setSelectedClipId(clip.id); }}
                    onPointerDown={(e) => handleClipPointerDown(e, clip, "move")}
                  >
                    {/* Left resize */}
                    <div
                      style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.18)", flexShrink: 0 }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-left")}
                    />

                    <span style={{ fontFamily: "monospace", fontSize: 9, paddingLeft: HANDLE_W + 4, paddingRight: HANDLE_W + 4, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", color: "#2a2a2a", pointerEvents: "none" }}>
                      {clip.name}
                    </span>

                    {/* Right resize */}
                    <div
                      style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.18)" }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-right")}
                    />

                    {/* Keyframe diamonds */}
                    {clip.keyframes.map((kf, ki) => (
                      <div
                        key={ki}
                        style={{
                          position: "absolute",
                          left: kf.time * pxPerSec - 4,
                          top: "50%",
                          width: 6,
                          height: 6,
                          transform: "translateY(-50%) rotate(45deg)",
                          background: "#2a2a2a",
                          opacity: 0.65,
                          pointerEvents: "none",
                          flexShrink: 0,
                        }}
                      />
                    ))}
                  </div>
                );
              })}

              {/* Playhead */}
              <div style={{ position: "absolute", left: playhead * pxPerSec, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none", zIndex: 10 }} />
            </div>
          </div>
        </div>
      </div>
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

const mediaItemStyle: React.CSSProperties = {
  padding: "6px 8px",
  background: "#fffdf5",
  border: "1.5px solid #2a2a2a",
  cursor: "pointer",
  fontSize: 10,
  fontFamily: "monospace",
  display: "flex",
  alignItems: "center",
  gap: 6,
  boxShadow: "1px 1px 0 #2a2a2a",
  userSelect: "none",
};

const kfCardStyle: React.CSSProperties = {
  border: "1px solid rgba(42,42,42,0.25)",
  padding: "8px 10px",
  background: "#fffdf5",
};
