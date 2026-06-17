"use client";

import { useState, useRef, useEffect } from "react";
import { useSession, signIn } from "next-auth/react";

const PX_PER_SEC = 100;
const IMAGE_DEFAULT_DURATION = 3;

type ClipType = "audio" | "video" | "image";

type Clip = {
  id: string;
  type: ClipType;
  name: string;
  blobUrl: string;
  durationSec: number;
  startTime: number;
};

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
      type === "video"
        ? document.createElement("video")
        : document.createElement("audio");
    el.preload = "metadata";
    el.addEventListener(
      "loadedmetadata",
      () => {
        const d = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
        resolve(d);
      },
      { once: true }
    );
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

  const draggingRef = useRef(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recSecondsRef = useRef(0);
  const mediaUploadRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    recSecondsRef.current = recSeconds;
  }, [recSeconds]);

  useEffect(() => {
    if (!recording) { setRecSeconds(0); return; }
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const totalDuration =
    clips.length > 0
      ? Math.max(...clips.map((c) => c.startTime + c.durationSec))
      : 10;
  const timelineW = totalDuration * PX_PER_SEC + 200;

  function seekFromClientX(clientX: number) {
    const el = scrollerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    setPlayheadSec(Math.max(0, Math.min(totalDuration, x / PX_PER_SEC)));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (draggingRef.current) seekFromClientX(e.clientX);
  }

  function onPointerUp() {
    draggingRef.current = false;
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
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        const blobUrl = URL.createObjectURL(blob);
        const durationSec = await getMediaDuration(blobUrl, "audio");
        setClips((prev) => {
          const startTime =
            prev.length > 0
              ? Math.max(...prev.map((c) => c.startTime + c.durationSec))
              : 0;
          const clip: Clip = {
            id: crypto.randomUUID(),
            type: "audio",
            name: "Narration",
            blobUrl,
            durationSec: durationSec || recSecondsRef.current,
            startTime,
          };
          return [...prev, clip];
        });
      };
      recorder.start();
      setRecording(true);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Microphone access denied";
      setRecError(message);
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
        const durationSec = await getMediaDuration(blobUrl, type);
        return { type, name: file.name, blobUrl, durationSec };
      })
    );

    const valid = processed.filter(
      (x): x is NonNullable<typeof x> => x !== null
    );
    if (valid.length === 0) return;

    setClips((prev) => {
      let cursor =
        prev.length > 0
          ? Math.max(...prev.map((c) => c.startTime + c.durationSec))
          : 0;
      const newClips: Clip[] = valid.map((item) => {
        const startTime = cursor;
        const dur = item.durationSec || (item.type === "image" ? IMAGE_DEFAULT_DURATION : 5);
        cursor += dur;
        return {
          id: crypto.randomUUID(),
          type: item.type,
          name: item.name,
          blobUrl: item.blobUrl,
          durationSec: dur,
          startTime,
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
          <h1
            style={{
              fontFamily: "'Caveat', cursive",
              fontSize: 38,
              color: "#2a2a2a",
              textAlign: "center",
              marginBottom: 4,
            }}
          >
            Neural Board
          </h1>
          <p
            style={{
              fontSize: 12,
              color: "#6a6a6a",
              textAlign: "center",
              marginBottom: 24,
              fontFamily: "'Courier New', monospace",
            }}
          >
            sign in to continue
          </p>
          <button onClick={() => signIn("google")} style={primaryButtonStyle}>
            Sign in with Google
          </button>
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
          <span
            style={{
              fontFamily: "'Caveat', cursive",
              fontSize: 28,
              fontWeight: 700,
              color: "#2a2a2a",
            }}
          >
            Neural Board
          </span>
          <span
            style={{
              fontSize: 11,
              color: "#6a6a6a",
              letterSpacing: 1,
              fontFamily: "monospace",
            }}
          >
            / EDITOR
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a href="/builder" style={navLinkStyle}>
            Builder
          </a>
          <span
            style={{
              fontSize: 11,
              color: "#6a6a6a",
              fontFamily: "monospace",
            }}
          >
            {session.user.email}
          </span>
        </div>
      </header>

      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 22px",
          borderBottom: "1px solid rgba(42,42,42,0.15)",
          background: "rgba(255,253,245,0.6)",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontFamily: "'Caveat', cursive",
            fontSize: 26,
            fontWeight: 700,
            color: "#2a2a2a",
            marginRight: 4,
          }}
        >
          Editor
        </span>

        <span
          style={{
            fontFamily: "'Courier New', monospace",
            fontSize: 16,
            color: "#2a2a2a",
            letterSpacing: 2,
            border: "1.5px solid #2a2a2a",
            padding: "3px 12px",
            background: "#fffdf5",
            boxShadow: "2px 2px 0 #2a2a2a",
            marginRight: 8,
          }}
        >
          {formatTime(playheadSec)}
        </span>

        {recording ? (
          <button
            onClick={stopRecording}
            style={{
              ...sketchButton,
              background: "#ff5e3a",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#fff",
                animation: "nbpulse 1s infinite",
              }}
            />
            Stop recording ({recSeconds}s)
          </button>
        ) : (
          <button onClick={startRecording} style={sketchButton}>
            ● Record narration
          </button>
        )}

        <button onClick={() => mediaUploadRef.current?.click()} style={sketchButton}>
          ↑ Upload media
        </button>
        <input
          ref={mediaUploadRef}
          type="file"
          accept="audio/*,video/*,image/*"
          multiple
          style={{ display: "none" }}
          onChange={handleMediaUpload}
        />

        {recError && (
          <span
            style={{
              fontSize: 11,
              color: "#ff5e3a",
              fontFamily: "monospace",
            }}
          >
            {recError}
          </span>
        )}
      </div>

      {/* Timeline scroller */}
      <div
        ref={scrollerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          overflowX: "auto",
          overflowY: "hidden",
          cursor: "crosshair",
          userSelect: "none",
          position: "relative",
          flex: 1,
        }}
      >
        <div style={{ position: "relative", width: timelineW, minHeight: 120 }}>

          {/* Ruler */}
          <div
            style={{
              position: "relative",
              height: 30,
              borderBottom: "1.5px solid #2a2a2a",
              background: "rgba(255,253,245,0.9)",
            }}
          >
            {Array.from({ length: Math.ceil(totalDuration) + 1 }, (_, i) => {
              const showLabel = i % 5 === 0;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: i * PX_PER_SEC,
                    top: 0,
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                  }}
                >
                  <div
                    style={{
                      width: 1,
                      background: "#2a2a2a",
                      height: showLabel ? 14 : 7,
                      marginTop: showLabel ? 4 : 12,
                    }}
                  />
                  {showLabel && (
                    <span
                      style={{
                        fontSize: 9,
                        fontFamily: "monospace",
                        color: "#6a6a6a",
                        marginLeft: 3,
                        lineHeight: 1,
                      }}
                    >
                      {i}s
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Clips row */}
          <div
            style={{
              position: "relative",
              height: 64,
              borderBottom: "1.5px solid rgba(42,42,42,0.2)",
              background: "rgba(255,253,245,0.5)",
            }}
          >
            <span
              style={{
                position: "absolute",
                left: 6,
                top: 4,
                fontSize: 9,
                fontFamily: "monospace",
                color: "#aaa",
                letterSpacing: 0.5,
                textTransform: "uppercase",
                pointerEvents: "none",
              }}
            >
              Clips
            </span>

            {clips.length === 0 && (
              <span
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%,-50%)",
                  fontSize: 11,
                  fontFamily: "monospace",
                  color: "#ccc",
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                }}
              >
                Record or upload to add clips
              </span>
            )}

            {clips.map((clip) => (
              <div
                key={clip.id}
                style={{
                  position: "absolute",
                  left: clip.startTime * PX_PER_SEC,
                  top: 14,
                  width: Math.max(2, clip.durationSec * PX_PER_SEC - 2),
                  height: 42,
                  background: CLIP_COLORS[clip.type],
                  border: "1.5px solid #2a2a2a",
                  boxShadow: "2px 2px 0 #2a2a2a",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  paddingLeft: 6,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: "'Courier New', monospace",
                    fontWeight: 700,
                    color: "#2a2a2a",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {clip.name}
                </span>
                <span
                  style={{
                    fontSize: 9,
                    fontFamily: "monospace",
                    color: "#555",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatDuration(clip.durationSec)}
                </span>
              </div>
            ))}
          </div>

          {/* Playhead */}
          <div
            style={{
              position: "absolute",
              left: playheadX,
              top: 0,
              bottom: 0,
              width: 2,
              background: "#ff5e3a",
              zIndex: 10,
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: -5,
                width: 0,
                height: 0,
                borderLeft: "6px solid transparent",
                borderRight: "6px solid transparent",
                borderTop: "10px solid #ff5e3a",
              }}
            />
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
