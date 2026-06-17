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
const LAYER_LABELS = ["Layer 1", "Layer 2", "Layer 3", "Layer 4", "Layer 5"];
const LAYER_BG = [
  "rgba(255,253,245,0.55)",
  "rgba(228,238,255,0.40)",
  "rgba(255,253,245,0.55)",
  "rgba(228,238,255,0.40)",
  "rgba(255,253,245,0.55)",
];

type ClipType = "audio" | "video" | "image";

type Clip = {
  id: string;
  type: ClipType;
  name: string;
  blobUrl: string;
  durationSec: number;
  startTime: number;
  layer: number;
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
  startMouseX: number;
  startMouseY: number;
  validStartTime: number;
  validDuration: number;
  validLayer: number;
};

const snapTo = (t: number) => Math.round(t / SNAP) * SNAP;

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

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec % 1) * 100);
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
    const el =
      type === "video" ? document.createElement("video") : document.createElement("audio");
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

export default function EditorPage() {
  const { data: session, status } = useSession();
  const [clips, setClips] = useState<Clip[]>([]);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [recError, setRecError] = useState("");
  const [ghost, setGhost] = useState<Ghost>(null);

  const playheadDraggingRef = useRef(false);
  const dragRef = useRef<DragInfo | null>(null);
  const clipsRef = useRef<Clip[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recSecondsRef = useRef(0);
  const mediaUploadRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { recSecondsRef.current = recSeconds; }, [recSeconds]);
  useEffect(() => {
    if (!recording) { setRecSeconds(0); return; }
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const totalDuration =
    clips.length > 0 ? Math.max(...clips.map((c) => c.startTime + c.durationSec)) : 10;
  const timelineW = totalDuration * PX_PER_SEC + 200;
  const isDraggingClip = ghost !== null;

  function seekFromClientX(clientX: number) {
    const el = scrollerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    setPlayheadSec(Math.max(0, Math.min(totalDuration, x / PX_PER_SEC)));
  }

  function onScrollerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current) return;
    playheadDraggingRef.current = true;
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
      startMouseX: e.clientX, startMouseY: e.clientY,
      validStartTime: clip.startTime, validDuration: clip.durationSec, validLayer: clip.layer,
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

    if (drag.kind === "move") {
      newStart = snapTo(Math.max(0, drag.origStartTime + dtSec));
      newLayer = hoverLayer;
    } else if (drag.kind === "resize-left") {
      const clampedDelta = Math.min(dtSec, drag.origDuration - MIN_DURATION);
      newStart = snapTo(Math.max(0, drag.origStartTime + clampedDelta));
      newDur = Math.max(MIN_DURATION, snapTo(drag.origStartTime + drag.origDuration - newStart));
      newLayer = drag.origLayer;
    } else {
      newDur = Math.max(MIN_DURATION, snapTo(drag.origDuration + dtSec));
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

    const src = clipsRef.current.find((c) => c.id === drag.clipId)!;
    setGhost({
      clipId: drag.clipId,
      startTime: drag.validStartTime,
      durationSec: drag.validDuration,
      layer: drag.validLayer,
      type: src.type,
    });
  }

  function commitClipDrag() {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setGhost(null);
    setClips((prev) =>
      prev.map((c) =>
        c.id === drag.clipId
          ? { ...c, startTime: drag.validStartTime, durationSec: drag.validDuration, layer: drag.validLayer }
          : c
      )
    );
  }

  async function startRecording() {
    setRecError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const blobUrl = URL.createObjectURL(blob);
        const durationSec = await getMediaDuration(blobUrl, "audio");
        setClips((prev) => {
          const startTime = prev.length > 0 ? Math.max(...prev.map((c) => c.startTime + c.durationSec)) : 0;
          const dur = durationSec || recSecondsRef.current;
          return [...prev, {
            id: crypto.randomUUID(), type: "audio", name: "Narration",
            blobUrl, durationSec: dur, startTime, layer: findFreeLayer(prev, startTime, dur),
          }];
        });
      };
      recorder.start();
      setRecording(true);
    } catch (e: unknown) {
      setRecError(e instanceof Error ? e.message : "Microphone access denied");
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
      setRecording(false);
    }
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
      let cursor = prev.length > 0 ? Math.max(...prev.map((c) => c.startTime + c.durationSec)) : 0;
      const newClips: Clip[] = valid.map((item) => {
        const startTime = cursor;
        const dur = item.durationSec || (item.type === "image" ? IMAGE_DEFAULT_DURATION : 5);
        cursor += dur;
        return {
          id: crypto.randomUUID(), type: item.type, name: item.name,
          blobUrl: item.blobUrl, durationSec: dur, startTime,
          layer: findFreeLayer(prev, startTime, dur),
        };
      });
      return [...prev, ...newClips];
    });
    e.target.value = "";
  }

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
          <h1 style={{ fontFamily: "'Caveat', cursive", fontSize: 38, color: "#2a2a2a", textAlign: "center", marginBottom: 4 }}>
            Neural Board
          </h1>
          <p style={{ fontSize: 12, color: "#6a6a6a", textAlign: "center", marginBottom: 24, fontFamily: "'Courier New', monospace" }}>
            sign in to continue
          </p>
          <button onClick={() => signIn("google")} style={primaryButtonStyle}>Sign in with Google</button>
        </div>
      </main>
    );
  }

  const playheadX = playheadSec * PX_PER_SEC;

  return (
    <main style={pageStyle}>
      <style>{`@keyframes nbpulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: "#2a2a2a" }}>
            Neural Board
          </span>
          <span style={{ fontSize: 11, color: "#6a6a6a", letterSpacing: 1, fontFamily: "monospace" }}>/ EDITOR</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a href="/builder" style={navLinkStyle}>Builder</a>
          <span style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>{session.user.email}</span>
        </div>
      </header>

      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 22px", borderBottom: "1px solid rgba(42,42,42,0.15)", background: "rgba(255,253,245,0.6)", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "'Caveat', cursive", fontSize: 26, fontWeight: 700, color: "#2a2a2a", marginRight: 4 }}>Editor</span>
        <span style={{ fontFamily: "'Courier New', monospace", fontSize: 16, color: "#2a2a2a", letterSpacing: 2, border: "1.5px solid #2a2a2a", padding: "3px 12px", background: "#fffdf5", boxShadow: "2px 2px 0 #2a2a2a", marginRight: 8 }}>
          {formatTime(playheadSec)}
        </span>
        {recording ? (
          <button onClick={stopRecording} style={{ ...sketchButton, background: "#ff5e3a", color: "#fff", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#fff", animation: "nbpulse 1s infinite" }} />
            Stop recording ({recSeconds}s)
          </button>
        ) : (
          <button onClick={startRecording} style={sketchButton}>● Record narration</button>
        )}
        <button onClick={() => mediaUploadRef.current?.click()} style={sketchButton}>↑ Upload media</button>
        <input ref={mediaUploadRef} type="file" accept="audio/*,video/*,image/*" multiple style={{ display: "none" }} onChange={handleMediaUpload} />
        {recError && <span style={{ fontSize: 11, color: "#ff5e3a", fontFamily: "monospace" }}>{recError}</span>}
      </div>

      {/* Timeline scroller */}
      <div
        ref={scrollerRef}
        onPointerDown={onScrollerPointerDown}
        onPointerMove={onScrollerPointerMove}
        onPointerUp={onScrollerPointerUp}
        onPointerCancel={onScrollerPointerUp}
        style={{
          overflowX: "auto",
          overflowY: "hidden",
          cursor: isDraggingClip ? "grabbing" : "crosshair",
          userSelect: "none",
          position: "relative",
          flex: 1,
        }}
      >
        <div style={{ position: "relative", width: timelineW, minHeight: RULER_H + NUM_LAYERS * LAYER_H }}>

          {/* Ruler */}
          <div style={{ position: "relative", height: RULER_H, borderBottom: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.9)" }}>
            {Array.from({ length: Math.ceil(totalDuration) + 1 }, (_, i) => {
              const showLabel = i % 5 === 0;
              return (
                <div key={i} style={{ position: "absolute", left: i * PX_PER_SEC, top: 0, height: "100%", display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                  <div style={{ width: 1, background: "#2a2a2a", height: showLabel ? 14 : 7, marginTop: showLabel ? 4 : 12 }} />
                  {showLabel && (
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", marginLeft: 3, lineHeight: 1 }}>{i}s</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Layer rows */}
          {LAYER_LABELS.map((label, idx) => {
            const layerNum = idx + 1;
            const layerClips = clips.filter((c) => c.layer === layerNum);
            const layerGhost = ghost?.layer === layerNum ? ghost : null;

            return (
              <div
                key={layerNum}
                style={{
                  position: "relative",
                  height: LAYER_H,
                  borderBottom: `1px solid rgba(42,42,42,${layerNum === NUM_LAYERS ? 0.3 : 0.1})`,
                  background: LAYER_BG[idx],
                }}
              >
                <span style={{
                  position: "absolute", left: 6, top: "50%", transform: "translateY(-50%)",
                  fontSize: 9, fontFamily: "monospace", color: "rgba(42,42,42,0.22)",
                  letterSpacing: 0.5, textTransform: "uppercase",
                  pointerEvents: "none", userSelect: "none", zIndex: 0,
                }}>
                  {label}
                </span>

                {layerClips.map((clip) => {
                  const isBeingDragged = ghost?.clipId === clip.id;
                  const clipPx = Math.max(HANDLE_W * 2 + 4, clip.durationSec * PX_PER_SEC - 2);
                  const showHandles = clipPx >= HANDLE_W * 3;

                  return (
                    <div
                      key={clip.id}
                      onPointerDown={(e) => onClipPointerDown(e, clip)}
                      style={{
                        position: "absolute",
                        left: clip.startTime * PX_PER_SEC,
                        top: 7,
                        width: clipPx,
                        height: LAYER_H - 14,
                        background: CLIP_COLORS[clip.type],
                        opacity: isBeingDragged ? 0.28 : 1,
                        border: "1.5px solid #2a2a2a",
                        boxShadow: isBeingDragged ? "none" : "2px 2px 0 #2a2a2a",
                        cursor: isBeingDragged ? "grabbing" : "grab",
                        display: "flex",
                        alignItems: "center",
                        overflow: "hidden",
                        zIndex: 2,
                      }}
                    >
                      {showHandles && (
                        <div style={{
                          position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W,
                          background: "rgba(42,42,42,0.18)", cursor: "ew-resize",
                        }} />
                      )}
                      <div style={{ paddingLeft: showHandles ? HANDLE_W + 4 : 5, paddingRight: showHandles ? HANDLE_W + 4 : 5, overflow: "hidden", flexGrow: 1, pointerEvents: "none" }}>
                        <div style={{ fontSize: 10, fontFamily: "'Courier New', monospace", fontWeight: 700, color: "#2a2a2a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {clip.name}
                        </div>
                        <div style={{ fontSize: 9, fontFamily: "monospace", color: "#555", whiteSpace: "nowrap" }}>
                          {formatDuration(clip.durationSec)}
                        </div>
                      </div>
                      {showHandles && (
                        <div style={{
                          position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W,
                          background: "rgba(42,42,42,0.18)", cursor: "ew-resize",
                        }} />
                      )}
                    </div>
                  );
                })}

                {layerGhost && (
                  <div style={{
                    position: "absolute",
                    left: layerGhost.startTime * PX_PER_SEC,
                    top: 5,
                    width: Math.max(4, layerGhost.durationSec * PX_PER_SEC - 2),
                    height: LAYER_H - 10,
                    background: CLIP_COLORS[layerGhost.type],
                    opacity: 0.6,
                    border: "2px dashed #2a2a2a",
                    boxShadow: "3px 3px 10px rgba(42,42,42,0.22)",
                    pointerEvents: "none",
                    zIndex: 6,
                    transform: "scale(1.03)",
                    transformOrigin: "center center",
                  }} />
                )}
              </div>
            );
          })}

          {clips.length === 0 && (
            <div style={{
              position: "absolute",
              left: "50%",
              top: RULER_H + (NUM_LAYERS * LAYER_H) / 2,
              transform: "translate(-50%, -50%)",
              fontSize: 11,
              fontFamily: "monospace",
              color: "#ccc",
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}>
              Record or upload to add clips
            </div>
          )}

          {/* Playhead */}
          <div style={{ position: "absolute", left: playheadX, top: 0, bottom: 0, width: 2, background: "#ff5e3a", zIndex: 10, pointerEvents: "none" }}>
            <div style={{ position: "absolute", top: 0, left: -5, width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "10px solid #ff5e3a" }} />
          </div>

        </div>
      </div>
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Courier New', Courier, monospace",
  backgroundColor: "#f5f1e8",
  backgroundImage:
    "linear-gradient(rgba(100,130,180,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(100,130,180,.18) 1px, transparent 1px)",
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

const navLinkStyle: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "monospace",
  color: "#2a2a2a",
  textDecoration: "none",
  border: "1px solid #2a2a2a",
  padding: "3px 8px",
  borderRadius: 3,
  letterSpacing: 0.5,
};
