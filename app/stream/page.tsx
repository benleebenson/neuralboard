"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { STREAM_OWNER_NAME, STREAM_OWNER_USER_ID } from "@/app/board2/config";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import {
  StreamAnnotation,
  StreamCamera,
  StreamCharacterFrame,
  StreamFrameMessage,
  StreamSnapshotMessage,
  streamChannelName,
} from "@/lib/stream";

const BOARD_W = 4000;
const BOARD_H = 3000;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  ann: StreamAnnotation,
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number
) {
  const sx = (x: number) => (x - cam.cameraX) * sf + W / 2;
  const sy = (y: number) => (y - cam.cameraY) * sf + H / 2;
  ctx.save();
  ctx.strokeStyle = ann.color;
  ctx.fillStyle = ann.color;
  ctx.lineWidth = Math.max(1, (ann.strokeWidth ?? 3) * sf);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (ann.type === "text" && ann.text) {
    ctx.font = `${ann.fontWeight ?? "normal"} ${Math.max(9, (ann.fontSize ?? 70) * sf)}px '${ann.fontFamily ?? "Caveat"}', cursive`;
    ctx.textBaseline = "top";
    ctx.fillText(ann.text, sx(ann.boardX), sy(ann.boardY));
  } else if (ann.type === "arrow" && ann.arrowStartX !== undefined) {
    const x1 = sx(ann.arrowStartX), y1 = sy(ann.arrowStartY ?? ann.boardY);
    const x2 = sx(ann.arrowEndX ?? ann.boardX), y2 = sy(ann.arrowEndY ?? ann.boardY);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const hl = Math.max(12, ctx.lineWidth * 5);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - hl * Math.cos(angle - Math.PI / 6), y2 - hl * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - hl * Math.cos(angle + Math.PI / 6), y2 - hl * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  } else if (ann.type === "circle") {
    ctx.beginPath();
    ctx.ellipse(sx(ann.boardX + ann.boardW / 2), sy(ann.boardY + ann.boardH / 2), ann.boardW * sf / 2, ann.boardH * sf / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (ann.type === "highlight") {
    ctx.globalAlpha = 0.28;
    ctx.fillRect(sx(ann.boardX), sy(ann.boardY), ann.boardW * sf, ann.boardH * sf);
  } else if (ann.type === "pen" && ann.points && ann.points.length > 1) {
    ctx.beginPath();
    ctx.moveTo(sx(ann.points[0].x), sy(ann.points[0].y));
    for (const p of ann.points.slice(1)) ctx.lineTo(sx(p.x), sy(p.y));
    ctx.stroke();
  } else if (ann.type === "emoji" && ann.emoji) {
    ctx.font = `${Math.max(16, (ann.fontSize ?? 120) * sf)}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ann.emoji, sx(ann.boardX + ann.boardW / 2), sy(ann.boardY + ann.boardH / 2));
  }
  ctx.restore();
}

function drawCharacter(
  ctx: CanvasRenderingContext2D,
  ch: StreamCharacterFrame,
  face: HTMLImageElement | null,
  faceAspect: number,
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number
) {
  if (!ch.enabled) return;
  const x = (ch.x - cam.cameraX) * sf + W / 2;
  const y = (ch.y - cam.cameraY) * sf + H / 2;
  const S = sf;
  const facing = ch.facing || 1;
  const walk = ch.actionType === "walkTo" ? Math.sin(ch.progress * Math.PI * 8) : 0;
  const dance = ch.actionType === "dance" ? Math.sin(ch.progress * Math.PI * 6) : 0;
  const jump = ["jumpTo", "flip", "grapple", "zipline"].includes(ch.actionType) ? Math.sin(ch.progress * Math.PI) * 45 * S : 0;
  const hipX = x + dance * 10 * S;
  const hipY = y - jump;
  const torsoH = 70 * S;
  const headR = (ch.physique === "jacked" ? 22 : 19) * S;
  const neckX = hipX + dance * -5 * S;
  const neckY = hipY - torsoH;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = ch.id === "c2" ? "#3a3a5a" : "#2a2a2a";
  ctx.fillStyle = "#fff6df";
  ctx.lineWidth = Math.max(2, (ch.physique === "jacked" ? 7 : 4) * S);
  ctx.beginPath();
  ctx.moveTo(hipX, hipY);
  ctx.lineTo(neckX, neckY);
  ctx.stroke();
  const shoulderY = neckY + 14 * S;
  const shoulderW = (ch.physique === "jacked" ? 35 : 24) * S;
  const armSwing = walk * 0.4 + dance * 0.55;
  for (const side of [-1, 1]) {
    const sx = neckX + side * shoulderW;
    const sy = shoulderY;
    const handX = sx + side * facing * (22 + armSwing * 18) * S;
    const handY = sy + (ch.actionType === "dance" ? 16 : 52) * S;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo((sx + handX) / 2, sy + 28 * S);
    ctx.lineTo(handX, handY);
    ctx.stroke();
  }
  ctx.lineWidth = Math.max(2, 4 * S);
  for (const side of [-1, 1]) {
    const footX = hipX + side * (18 + walk * 9) * S;
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(hipX + side * 12 * S, hipY + 38 * S);
    ctx.lineTo(footX, y + 6 * S);
    ctx.stroke();
  }
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(neckX, neckY - headR * 1.05, headR, headR * faceAspect, 0, 0, Math.PI * 2);
  if (face?.complete && face.naturalWidth > 0) {
    ctx.clip();
    ctx.drawImage(face, neckX - headR, neckY - headR * (1.05 + faceAspect), headR * 2, headR * faceAspect * 2);
  } else {
    ctx.fillStyle = "#fff6df";
    ctx.fill();
  }
  ctx.restore();
  ctx.beginPath();
  ctx.ellipse(neckX, neckY - headR * 1.05, headR, headR * faceAspect, 0, 0, Math.PI * 2);
  ctx.stroke();
  if (ch.emoji && (ch.emojiAlpha ?? 0) > 0) {
    ctx.globalAlpha = ch.emojiAlpha ?? 1;
    ctx.font = `${28 * S}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ch.emoji, neckX, neckY - headR * 3.2);
  }
  ctx.restore();
}

export default function StreamPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const faceCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const latestFrameRef = useRef<StreamFrameMessage | null>(null);
  const renderCameraRef = useRef<StreamCamera>({ cameraX: BOARD_W / 2, cameraY: BOARD_H / 2, boardZoom: 1 });
  const renderCharsRef = useRef<Map<string, StreamCharacterFrame>>(new Map());
  const [snapshot, setSnapshot] = useState<StreamSnapshotMessage | null>(null);
  const [live, setLive] = useState(false);
  const [watching, setWatching] = useState(false);
  const [status, setStatus] = useState("connecting");
  const [viewerCount, setViewerCount] = useState(1);

  const loadSnapshot = useCallback(async () => {
    const res = await fetch(`/api/stream/snapshot?streamId=${encodeURIComponent(STREAM_OWNER_USER_ID)}`, { cache: "no-store" });
    const data = await res.json();
    setLive(!!data.live);
    setSnapshot(data.snapshot ?? null);
    setStatus(data.live ? "live" : "offline");
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadSnapshot(), 0);
    const supabase = getBrowserSupabase();
    if (!supabase) {
      window.setTimeout(() => setStatus("realtime-not-configured"), 0);
      return () => window.clearTimeout(initialLoad);
    }
    const viewerKey = `viewer-${Math.random().toString(36).slice(2)}`;
    const channel = supabase.channel(streamChannelName(STREAM_OWNER_USER_ID), {
      config: { broadcast: { self: false }, presence: { key: viewerKey } },
    });
    channelRef.current = channel;
    channel
      .on("broadcast", { event: "snapshot" }, ({ payload }) => {
        setSnapshot(payload as StreamSnapshotMessage);
        setLive(true);
        setStatus("live");
      })
      .on("broadcast", { event: "frame" }, ({ payload }) => {
        latestFrameRef.current = payload as StreamFrameMessage;
        setLive(true);
        setStatus("live");
      })
      .on("broadcast", { event: "session-end" }, () => {
        setLive(false);
        setStatus("offline");
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        setViewerCount(Math.max(1, Object.keys(state).length));
      })
      .subscribe(async (nextStatus) => {
        if (nextStatus === "SUBSCRIBED") {
          await channel.track({ onlineAt: Date.now() });
          await loadSnapshot();
        } else if (nextStatus === "CHANNEL_ERROR" || nextStatus === "TIMED_OUT") {
          setStatus("reconnecting");
          void loadSnapshot();
        }
      });
    return () => {
      window.clearTimeout(initialLoad);
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [loadSnapshot]);

  useEffect(() => {
    if (!snapshot) return;
    for (const clip of snapshot.clips) {
      const url = clip.type === "video" ? (clip.thumbnailUrl || clip.sourceUrl) : clip.sourceUrl;
      if (!url || imageCacheRef.current.has(url)) continue;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      imageCacheRef.current.set(url, img);
    }
    for (const ch of snapshot.characters) {
      if (!ch.faceDataUrl || faceCacheRef.current.has(ch.id)) continue;
      const img = new Image();
      img.src = ch.faceDataUrl;
      faceCacheRef.current.set(ch.id, img);
    }
  }, [snapshot]);

  useEffect(() => {
    if (!watching) return;
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(window.innerWidth * dpr));
      const h = Math.max(1, Math.floor(window.innerHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = "100vw";
        canvas.style.height = "100vh";
      }
      const latest = latestFrameRef.current;
      if (latest) {
        const cam = renderCameraRef.current;
        renderCameraRef.current = {
          cameraX: lerp(cam.cameraX, latest.camera.cameraX, 0.22),
          cameraY: lerp(cam.cameraY, latest.camera.cameraY, 0.22),
          boardZoom: lerp(cam.boardZoom, latest.camera.boardZoom, 0.2),
        };
        for (const ch of latest.characters) {
          const prev = renderCharsRef.current.get(ch.id);
          renderCharsRef.current.set(ch.id, prev ? {
            ...ch,
            x: lerp(prev.x, ch.x, 0.35),
            y: lerp(prev.y, ch.y, 0.35),
          } : ch);
        }
      }
      const cam = renderCameraRef.current;
      const sf = cam.boardZoom * w / BOARD_W;
      ctx.fillStyle = snapshot?.board.backgroundColor ?? "#f5ecd8";
      ctx.fillRect(0, 0, w, h);
      if (snapshot) {
        const clips = [...snapshot.clips].sort((a, b) => (a.layer ?? 1) - (b.layer ?? 1));
        for (const clip of clips) {
          const cx = (clip.boardX + clip.boardW / 2 - cam.cameraX) * sf + w / 2;
          const cy = (clip.boardY + clip.boardH / 2 - cam.cameraY) * sf + h / 2;
          const sw = clip.boardW * sf;
          const sh = clip.boardH * sf;
          const url = clip.type === "video" ? (clip.thumbnailUrl || clip.sourceUrl) : clip.sourceUrl;
          const img = url ? imageCacheRef.current.get(url) : null;
          if (img?.complete && img.naturalWidth > 0) ctx.drawImage(img, cx - sw / 2, cy - sh / 2, sw, sh);
          else {
            ctx.fillStyle = clip.type === "video" ? "#111" : "#e5dcc7";
            ctx.fillRect(cx - sw / 2, cy - sh / 2, sw, sh);
          }
          if (clip.type === "video") {
            ctx.fillStyle = "rgba(0,0,0,0.64)";
            ctx.fillRect(cx - sw / 2 + 10, cy - sh / 2 + 10, 74, 24);
            ctx.fillStyle = "#fff";
            ctx.font = "14px monospace";
            ctx.fillText("VIDEO", cx - sw / 2 + 22, cy - sh / 2 + 27);
          }
        }
        for (const ann of snapshot.annotations) drawAnnotation(ctx, ann, cam, sf, w, h);
        const faceById = new Map(snapshot.characters.map((c) => [c.id, c]));
        for (const ch of Array.from(renderCharsRef.current.values()).sort((a, b) => a.id.localeCompare(b.id))) {
          const faceInfo = faceById.get(ch.id);
          drawCharacter(ctx, ch, faceCacheRef.current.get(ch.id) ?? null, faceInfo?.faceAspect ?? 1, cam, sf, w, h);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [snapshot, watching]);

  if (!watching) {
    return (
      <main style={{ minHeight: "100vh", background: "#f5ecd8", color: "#2a2a2a", fontFamily: "monospace", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <section style={{ width: 380, maxWidth: "100%", border: "2px solid #2a2a2a", background: "#fffdf5", boxShadow: "4px 4px 0 #2a2a2a", padding: 18 }}>
          <div style={{ fontSize: 11, letterSpacing: 0, color: live ? "#228b22" : "#8a6a00", fontWeight: 700 }}>{live ? "LIVE" : status === "realtime-not-configured" ? "REALTIME NOT CONFIGURED" : "OFFLINE"}</div>
          <h1 style={{ fontSize: 24, margin: "8px 0 8px" }}>{STREAM_OWNER_NAME}</h1>
          <p style={{ fontSize: 12, lineHeight: 1.6, color: "#6a6a6a", margin: "0 0 16px" }}>
            {live ? "Stream is live." : "No active stream right now."}
          </p>
          <button
            disabled={!live || !snapshot}
            onClick={() => setWatching(true)}
            style={{ width: "100%", padding: "10px 12px", border: "2px solid #2a2a2a", background: live && snapshot ? "#c8f135" : "#e8e0c9", color: "#2a2a2a", fontFamily: "monospace", fontWeight: 700, cursor: live && snapshot ? "pointer" : "not-allowed" }}
          >
            Watch
          </button>
        </section>
      </main>
    );
  }

  return (
    <main style={{ position: "fixed", inset: 0, background: "#f5ecd8", overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ display: "block", width: "100vw", height: "100vh" }} />
      <header style={{ position: "fixed", top: 12, left: 12, right: 12, display: "flex", alignItems: "center", gap: 10, pointerEvents: "none", fontFamily: "monospace", color: "#2a2a2a" }}>
        <div style={{ background: "rgba(255,253,245,0.92)", border: "1.5px solid #2a2a2a", boxShadow: "2px 2px 0 #2a2a2a", padding: "6px 9px", fontSize: 11, fontWeight: 700 }}>
          <span style={{ color: live ? "#cc2200" : "#8a6a00" }}>{live ? "LIVE" : "RECONNECTING"}</span>
          <span style={{ marginLeft: 8 }}>{STREAM_OWNER_NAME}</span>
        </div>
        <div style={{ background: "rgba(255,253,245,0.82)", border: "1px solid rgba(42,42,42,0.35)", padding: "5px 8px", fontSize: 10 }}>
          {viewerCount} viewer{viewerCount === 1 ? "" : "s"}
        </div>
      </header>
    </main>
  );
}
