"use client";

import { useState, useRef } from "react";
import { useSession, signIn } from "next-auth/react";

const PX_PER_SEC = 100;

type Beat = { id: number; label: string; startTime: number; endTime: number };

const MOCK_BEATS: Beat[] = [
  { id: 1, label: "Beat 1", startTime: 0, endTime: 3 },
  { id: 2, label: "Beat 2", startTime: 3, endTime: 7 },
  { id: 3, label: "Beat 3", startTime: 7, endTime: 12 },
];

const TOTAL_DURATION = Math.max(...MOCK_BEATS.map((b) => b.endTime));
const TIMELINE_W = TOTAL_DURATION * PX_PER_SEC + 200;
const TRACK_ROWS = ["Narration", "Video audio"];

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export default function EditorPage() {
  const { data: session, status } = useSession();
  const [playheadSec, setPlayheadSec] = useState(0);
  const draggingRef = useRef(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  function seekFromClientX(clientX: number) {
    const el = scrollerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    setPlayheadSec(Math.max(0, Math.min(TOTAL_DURATION, x / PX_PER_SEC)));
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
      {/* Header */}
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: "#2a2a2a" }}>Neural Board</span>
          <span style={{ fontSize: 11, color: "#6a6a6a", letterSpacing: 1, fontFamily: "monospace" }}>/ EDITOR</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a href="/builder" style={navLinkStyle}>Builder</a>
          <span style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>{session.user.email}</span>
        </div>
      </header>

      {/* Title + time readout */}
      <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "14px 22px", borderBottom: "1px solid rgba(42,42,42,0.15)", background: "rgba(255,253,245,0.6)" }}>
        <span style={{ fontFamily: "'Caveat', cursive", fontSize: 26, fontWeight: 700, color: "#2a2a2a" }}>Editor</span>
        <span style={{ fontFamily: "'Courier New', monospace", fontSize: 18, color: "#2a2a2a", letterSpacing: 2, border: "1.5px solid #2a2a2a", padding: "4px 14px", background: "#fffdf5", boxShadow: "2px 2px 0 #2a2a2a" }}>
          {formatTime(playheadSec)}
        </span>
      </div>

      {/* Timeline scroller */}
      <div
        ref={scrollerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ overflowX: "auto", overflowY: "hidden", cursor: "crosshair", userSelect: "none", position: "relative" }}
      >
        <div style={{ position: "relative", width: TIMELINE_W }}>

          {/* Ruler */}
          <div style={{ position: "relative", height: 30, borderBottom: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.9)" }}>
            {Array.from({ length: Math.ceil(TOTAL_DURATION) + 1 }, (_, i) => {
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

          {/* Beats row */}
          <div style={{ position: "relative", height: 56, borderBottom: "1.5px solid rgba(42,42,42,0.2)", background: "rgba(255,253,245,0.5)" }}>
            <span style={{ position: "absolute", left: 6, top: 4, fontSize: 9, fontFamily: "monospace", color: "#aaa", letterSpacing: 0.5, textTransform: "uppercase" }}>Beats</span>
            {MOCK_BEATS.map((beat) => (
              <div
                key={beat.id}
                style={{
                  position: "absolute",
                  left: beat.startTime * PX_PER_SEC,
                  top: 14,
                  width: (beat.endTime - beat.startTime) * PX_PER_SEC - 2,
                  height: 34,
                  background: "#c8f135",
                  border: "1.5px solid #2a2a2a",
                  boxShadow: "2px 2px 0 #2a2a2a",
                  display: "flex",
                  alignItems: "center",
                  paddingLeft: 8,
                  overflow: "hidden",
                }}
              >
                <span style={{ fontSize: 11, fontFamily: "'Courier New', monospace", fontWeight: 700, color: "#2a2a2a", whiteSpace: "nowrap" }}>
                  {beat.label}
                </span>
              </div>
            ))}
          </div>

          {/* Empty track rows */}
          {TRACK_ROWS.map((label) => (
            <div
              key={label}
              style={{ position: "relative", height: 48, borderBottom: "1.5px solid rgba(42,42,42,0.2)", background: "rgba(255,253,245,0.3)" }}
            >
              <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", fontSize: 9, fontFamily: "monospace", color: "#aaa", letterSpacing: 0.5, textTransform: "uppercase" }}>
                {label}
              </span>
            </div>
          ))}

          {/* Playhead */}
          <div
            style={{ position: "absolute", left: playheadX, top: 0, bottom: 0, width: 2, background: "#ff5e3a", zIndex: 10, pointerEvents: "none" }}
          >
            <div style={{ position: "absolute", top: 0, left: -5, width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "10px solid #ff5e3a" }} />
          </div>

        </div>
      </div>
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
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
  padding: "12px",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: "2px 2px 0 #2a2a2a",
  textAlign: "center",
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
