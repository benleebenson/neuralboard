"use client";

import { useState, useRef, useEffect } from "react";

type Beat = {
  startTime: number;
  endTime: number;
  searchQuery: string;
  reasoning: string;
  images?: string[];
  selectedImageIdx?: number;
  pos?: { x: number; y: number };
  size?: number;
  customImageUrl?: string;
  customVideoUrl?: string;
};

type Background = "cork" | "beige" | "graph" | "custom";
type CardStyle = "card" | "bare";
type Stroke = { color: string; size: number; points: Array<{ x: number; y: number }> };


const RAILWAY_URL = process.env.NEXT_PUBLIC_RAILWAY_URL || "";
const CARD_W = 130;
const CARD_H = 170;

export default function BuilderPage() {
  const [authed, setAuthed] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");
  const [password, setPassword] = useState("");

  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [duration, setDuration] = useState(0);
  const [beats, setBeats] = useState<Beat[]>([]);
  const [error, setError] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderStatus, setRenderStatus] = useState("");
  const [mp4Url, setMp4Url] = useState("");

  const [activeBeatIdx, setActiveBeatIdx] = useState(0);
  const [editingBeatIdx, setEditingBeatIdx] = useState<number | null>(null);
  const [editEndVal, setEditEndVal] = useState('');
  const [background, setBackground] = useState<Background>("cork");
  const [customBgUrl, setCustomBgUrl] = useState<string>("");
  const [draggedBeatIdx, setDraggedBeatIdx] = useState<number | null>(null);
  const [cardStyle, setCardStyle] = useState<CardStyle>("card");
  const [drawMode, setDrawMode] = useState(false);
  const [drawColor, setDrawColor] = useState("#2a2a2a");
  const [drawSize, setDrawSize] = useState(3);
  const [strokes, setStrokes] = useState<Stroke[]>([]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioFileInputRef = useRef<HTMLInputElement | null>(null);
  const bgFileInputRef = useRef<HTMLInputElement | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ idx: number; ox: number; oy: number; startBeatX: number; startBeatY: number } | null>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const beatImageInputRef = useRef<HTMLInputElement | null>(null);
  const uploadBeatIdxRef = useRef<number>(-1);
  const resizeRef = useRef<{ idx: number; startX: number; startSize: number } | null>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem("nb_pw");
    if (saved) {
      setPassword(saved);
      setAuthed(true);
    }
  }, []);

  // Keep strokesRef in sync so ResizeObserver can read current strokes
  useEffect(() => { strokesRef.current = strokes; }, [strokes]);

  // Resize the draw canvas to match board, redraw strokes at new scale.
  // Depends on `authed` so it re-runs after the board mounts (lock screen hides it).
  useEffect(() => {
    if (!authed) return;
    const board = boardRef.current;
    const canvas = drawCanvasRef.current;
    if (!board || !canvas) return;
    const resize = () => {
      const r = board.getBoundingClientRect();
      canvas.width = Math.round(r.width);
      canvas.height = Math.round(r.height);
      redrawCanvas(canvas, strokesRef.current);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(board);
    resize();
    return () => observer.disconnect();
  }, [authed]);

  // Redraw whenever committed strokes change
  useEffect(() => {
    const canvas = drawCanvasRef.current;
    if (canvas) redrawCanvas(canvas, strokes);
  }, [strokes]);

  function handleUnlock() {
    if (!pwInput.trim()) {
      setPwError("Enter the password");
      return;
    }
    setPassword(pwInput.trim());
    sessionStorage.setItem("nb_pw", pwInput.trim());
    setAuthed(true);
    setPwError("");
  }

  async function startRecording() {
    setError("");
    setTranscript("");
    setBeats([]);
    setDuration(0);
    setAudioBlob(null);
    setMp4Url("");
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
        setAudioBlob(blob);
        await sendToTranscribe(blob);
      };
      recorder.start();
      setRecording(true);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Microphone access denied";
      setError(message);
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
      setRecording(false);
      setProcessing(true);
    }
  }

  function handleAudioFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setTranscript("");
    setBeats([]);
    setDuration(0);
    setMp4Url("");
    setAudioBlob(file);
    setProcessing(true);
    sendToTranscribe(file);
  }

  function handleBgFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setCustomBgUrl(url);
    setBackground("custom");
  }

  async function sendToTranscribe(blob: Blob) {
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: {
          "Content-Type": blob.type || "audio/webm",
          "x-neuralboard-password": password,
        },
        body: blob,
      });
      if (res.status === 401) {
        sessionStorage.removeItem("nb_pw");
        setAuthed(false);
        setPwError("Password expired or invalid");
        setProcessing(false);
        return;
      }
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Transcription failed");
      setTranscript(data.transcript);
      setDuration(data.duration);
      const newBeats: Beat[] = (data.beats || []).map((b: Beat, i: number) => ({
        ...b,
        selectedImageIdx: 0,
        pos: {
          x: 40 + (i % 3) * 160 + (i * 17) % 30,
          y: 40 + Math.floor(i / 3) * 210 + (i * 31) % 40,
        },
      }));
      setBeats(newBeats);
      setActiveBeatIdx(0);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
    } finally {
      setProcessing(false);
    }
  }

  function cycleImage(idx: number) {
    setBeats((prev) =>
      prev.map((b, i) => {
        if (i !== idx) return b;
        const total = b.images?.length || 0;
        if (total === 0) return b;
        return { ...b, selectedImageIdx: ((b.selectedImageIdx ?? 0) + 1) % total };
      })
    );
  }

  function handleDragStart(idx: number) { setDraggedBeatIdx(idx); }
  function handleDragOver(e: React.DragEvent) { e.preventDefault(); }
  function handleDrop(targetIdx: number) {
    if (draggedBeatIdx === null || draggedBeatIdx === targetIdx) {
      setDraggedBeatIdx(null);
      return;
    }
    setBeats((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(draggedBeatIdx, 1);
      copy.splice(targetIdx, 0, moved);
      const segLen = duration / copy.length;
      return copy.map((b, i) => ({
        ...b,
        startTime: i * segLen,
        endTime: (i + 1) * segLen,
      }));
    });
    setActiveBeatIdx(targetIdx);
    setDraggedBeatIdx(null);
  }

  function handleBoardPointerDown(e: React.PointerEvent, idx: number) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const beat = beats[idx];
    dragRef.current = {
      idx,
      ox: e.clientX,
      oy: e.clientY,
      startBeatX: beat.pos?.x ?? 0,
      startBeatY: beat.pos?.y ?? 0,
    };
    setActiveBeatIdx(idx);
    e.stopPropagation();
  }

  function handleBoardPointerMove(e: React.PointerEvent) {
    if (resizeRef.current) {
      const { idx, startX, startSize } = resizeRef.current;
      const newSize = Math.max(80, Math.min(400, startSize + (e.clientX - startX)));
      setBeats((prev) => prev.map((b, i) => i === idx ? { ...b, size: newSize } : b));
      return;
    }
    if (!dragRef.current) return;
    const { idx, ox, oy, startBeatX, startBeatY } = dragRef.current;
    const board = boardRef.current;
    if (!board) return;
    const boardRect = board.getBoundingClientRect();
    const cardW = beats[idx]?.size ?? CARD_W;
    const newX = Math.max(0, Math.min(boardRect.width - cardW, startBeatX + (e.clientX - ox)));
    const newY = Math.max(0, Math.min(boardRect.height - 60, startBeatY + (e.clientY - oy)));
    setBeats((prev) => prev.map((b, i) => i === idx ? { ...b, pos: { x: newX, y: newY } } : b));
  }

  function handleBoardPointerUp() {
    dragRef.current = null;
    resizeRef.current = null;
  }

  function handleBeatMediaUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const idx = uploadBeatIdxRef.current;
    if (!file || idx < 0) return;
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) {
      setBeats((prev) => prev.map((b, i) => i === idx ? { ...b, customVideoUrl: url, customImageUrl: undefined } : b));
    } else {
      setBeats((prev) => prev.map((b, i) => i === idx ? { ...b, customImageUrl: url, customVideoUrl: undefined } : b));
    }
    e.target.value = "";
  }

  function commitBeatEnd(idx: number, rawVal: string) {
    const newEnd = parseFloat(rawVal);
    if (isNaN(newEnd)) { setEditingBeatIdx(null); return; }
    setBeats(prev => {
      const next = [...prev];
      const beat = next[idx];
      const clampedEnd = Math.max(beat.startTime + 0.1, Math.min(duration, newEnd));
      next[idx] = { ...beat, endTime: clampedEnd };
      // adjust next beat's startTime (it shrinks/grows to compensate)
      if (idx + 1 < next.length) {
        const nb = next[idx + 1];
        next[idx + 1] = { ...nb, startTime: clampedEnd, endTime: Math.max(clampedEnd + 0.1, nb.endTime) };
      }
      return next;
    });
    setEditingBeatIdx(null);
  }

  function addCustomBeat() {
    setBeats(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const lastDur = last.endTime - last.startTime;
      if (lastDur < 0.2) return prev;
      const split = last.startTime + lastDur / 2;
      const newBeat: Beat = {
        startTime: split,
        endTime: last.endTime,
        searchQuery: 'custom beat',
        reasoning: 'user added',
        images: [],
        selectedImageIdx: 0,
        pos: {
          x: 40 + (prev.length % 3) * 160 + (prev.length * 17) % 30,
          y: 40 + Math.floor(prev.length / 3) * 210 + (prev.length * 31) % 40,
        },
      };
      return [...prev.slice(0, -1), { ...last, endTime: split }, newBeat];
    });
  }

  function selectBeatImage(beatIdx: number, imgIdx: number) {
    setBeats((prev) => prev.map((b, i) =>
      i === beatIdx ? { ...b, selectedImageIdx: imgIdx, customImageUrl: undefined, customVideoUrl: undefined } : b
    ));
  }

  function syncCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; w: number; h: number } | null {
    const canvas = drawCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w === 0 || h === 0) return null;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      redrawCanvas(canvas, strokesRef.current);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    return { canvas, ctx, w, h };
  }

  function boardPx(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = drawCanvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handleDrawStart(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const s = syncCanvas();
    if (!s) return;
    const { x, y } = boardPx(e);
    currentStrokeRef.current = { color: drawColor, size: drawSize, points: [{ x, y }] };
  }

  function handleDrawMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const stroke = currentStrokeRef.current;
    if (!stroke) return;
    const s = syncCanvas();
    if (!s) return;
    const { x, y } = boardPx(e);
    const prev = stroke.points[stroke.points.length - 1];
    stroke.points.push({ x, y });
    s.ctx.strokeStyle = stroke.color;
    s.ctx.lineWidth = stroke.size;
    s.ctx.lineCap = "round";
    s.ctx.lineJoin = "round";
    s.ctx.beginPath();
    s.ctx.moveTo(prev.x, prev.y);
    s.ctx.lineTo(x, y);
    s.ctx.stroke();
  }

  function handleDrawEnd() {
    const stroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    if (!stroke || stroke.points.length < 2) return;
    setStrokes((prev) => [...prev, stroke]);
  }

  function clearDrawing() {
    setStrokes([]);
    const canvas = drawCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  async function renderVideo() {
    if (!audioBlob || beats.length === 0) {
      setError("Need both audio and beats to render");
      return;
    }
    if (!RAILWAY_URL) return;
    setRendering(true);
    setError("");
    setRenderStatus("Loading images...");
    setMp4Url("");

    try {
      const images: (HTMLImageElement | null)[] = await Promise.all(
        beats.map((b) => {
          const list = b.images || [];
          if (list.length === 0) return null;
          const startIdx = b.selectedImageIdx ?? 0;
          const reordered = [...list.slice(startIdx), ...list.slice(0, startIdx)];
          return loadFirstWorking(reordered);
        })
      );

      const videoEls: (HTMLVideoElement | null)[] = await Promise.all(
        beats.map(b => {
          if (!b.customVideoUrl) return Promise.resolve(null);
          const vid = document.createElement('video');
          vid.src = b.customVideoUrl;
          vid.muted = true;
          vid.playsInline = true;
          vid.crossOrigin = 'anonymous';
          return new Promise<HTMLVideoElement | null>(resolve => {
            const timer = setTimeout(() => resolve(null), 8000);
            vid.oncanplay = () => { clearTimeout(timer); resolve(vid); };
            vid.onerror = () => { clearTimeout(timer); resolve(null); };
            vid.load();
          });
        })
      );

      let bgImg: HTMLImageElement | null = null;
      if (background === "custom" && customBgUrl) {
        try { bgImg = await loadImage(customBgUrl); } catch { bgImg = null; }
      }

      setRenderStatus("Setting up canvas...");
      const W = 1080;
      const H = 1920;
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("Canvas not ready");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas context not available");

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);

      const audioEl = new Audio(URL.createObjectURL(audioBlob));
      audioEl.preload = "auto";
      await new Promise<void>((res) => {
        audioEl.addEventListener("canplaythrough", () => res(), { once: true });
        audioEl.load();
      });
      const safeDuration = duration && duration > 0.5 ? duration : audioEl.duration;

      const canvasStream = canvas.captureStream(30);
      const audioCtx = new AudioContext();
      const audioSource = audioCtx.createMediaElementSource(audioEl);
      const audioDest = audioCtx.createMediaStreamDestination();
      audioSource.connect(audioDest);
      audioSource.connect(audioCtx.destination);

      const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioDest.stream.getAudioTracks(),
      ]);

      const recorderMime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
        ? "video/webm;codecs=vp8,opus"
        : "video/webm";

      const renderRecorder = new MediaRecorder(combinedStream, {
        mimeType: recorderMime,
        videoBitsPerSecond: 4_000_000,
      });
      const renderChunks: Blob[] = [];
      renderRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) renderChunks.push(e.data);
      };

      const recordingDone = new Promise<Blob>((resolve) => {
        renderRecorder.onstop = () => {
          resolve(new Blob(renderChunks, { type: "video/webm" }));
        };
      });

      renderRecorder.start();
      audioEl.currentTime = 0;
      await audioEl.play();
      const startMs = performance.now();

      setRenderStatus("Rendering frames...");

      const N = beats.length;
      // Derive camera positions from board layout — same scale used for strokes
      const boardEl = boardRef.current;
      const boardDisplayW = boardEl ? boardEl.getBoundingClientRect().width : 800;
      const boardDisplayH = boardEl ? boardEl.getBoundingClientRect().height : 600;
      const VIDEO_CARD_W = 720;
      const scale = VIDEO_CARD_W / CARD_W;
      const cardCenters = beats.map((b, i) => ({
        x: ((b.pos?.x ?? (40 + (i % 3) * 160)) + (b.size ?? CARD_W) / 2) * scale,
        y: ((b.pos?.y ?? (40 + Math.floor(i / 3) * 210)) + CARD_H / 2) * scale,
      }));
      const boardWidth = boardDisplayW * scale + W;
      const boardHeight = boardDisplayH * scale + H;

      let prevRenderBeatIdx = -1;
      function drawFrame() {
        const elapsedSec = (performance.now() - startMs) / 1000;
        if (elapsedSec >= safeDuration) {
          renderRecorder.stop();
          audioEl.pause();
          return;
        }
        const idx = beats.findIndex(
          (b) => elapsedSec >= b.startTime && elapsedSec < b.endTime
        );
        const currentIdx = idx >= 0 ? idx : beats.length - 1;

        if (currentIdx !== prevRenderBeatIdx) {
          if (prevRenderBeatIdx >= 0 && videoEls[prevRenderBeatIdx]) {
            videoEls[prevRenderBeatIdx]!.pause();
          }
          if (videoEls[currentIdx]) {
            videoEls[currentIdx]!.currentTime = 0;
            videoEls[currentIdx]!.play().catch(() => {});
          }
          prevRenderBeatIdx = currentIdx;
        }
        const currentBeat = beats[currentIdx];
        const beatProgress = currentBeat
          ? Math.min(1, Math.max(0, (elapsedSec - currentBeat.startTime) / (currentBeat.endTime - currentBeat.startTime)))
          : 0;
        const prevIdx = Math.max(0, currentIdx - 1);
        const fromCenter = cardCenters[prevIdx];
        const toCenter = cardCenters[currentIdx];
        const panProgress = Math.min(1, beatProgress / 0.4);
        const eased = 0.5 - 0.5 * Math.cos(panProgress * Math.PI);
        const isFirstBeat = currentIdx === 0;
        const camX = isFirstBeat ? toCenter.x : fromCenter.x + (toCenter.x - fromCenter.x) * eased;
        const camY = isFirstBeat ? toCenter.y : fromCenter.y + (toCenter.y - fromCenter.y) * eased;
        const settleProgress = Math.min(1, Math.max(0, (beatProgress - 0.4) / 0.6));
        const zoom = 1 + 0.04 * Math.sin(settleProgress * Math.PI);

        drawBackground(ctx!, W, H, background, bgImg, camX, camY, boardWidth, boardHeight);

        ctx!.save();
        ctx!.translate(W / 2, H / 2);
        ctx!.scale(zoom, zoom);
        ctx!.translate(-camX, -camY);

        for (let i = 0; i < beats.length; i++) {
          const center = cardCenters[i];
          const cardScreenX = (center.x - camX) * zoom + W / 2;
          if (cardScreenX < -W * 1.5 || cardScreenX > W * 2.5) continue;
          const mediaEl: CanvasImageSource | null = videoEls[i] ?? images[i];
          drawCardAt(ctx!, mediaEl, center.x, center.y, i, beats[i].searchQuery);
        }
        ctx!.restore();

        requestAnimationFrame(drawFrame);
      }
      requestAnimationFrame(drawFrame);

      const webmBlob = await recordingDone;
      audioCtx.close();
      setRenderStatus("Converting to MP4 on server...");

      const mp4Res = await fetch(RAILWAY_URL + "/render", {
        method: "POST",
        headers: { "Content-Type": "video/webm", "x-neuralboard-password": password },
        body: webmBlob,
      });
      if (!mp4Res.ok) {
        const errText = await mp4Res.text().catch(() => "");
        throw new Error("Server error " + mp4Res.status + ": " + errText);
      }
      const mp4Blob = await mp4Res.blob();
      const url = URL.createObjectURL(mp4Blob);
      setMp4Url(url);
      setRenderStatus("Done!");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Render failed";
      setError(message);
      setRenderStatus("");
    } finally {
      setRendering(false);
    }
  }

  if (!authed) {
    return (
      <main style={lockScreenStyle}>
        <div style={{ maxWidth: 360, width: "100%" }}>
          <h1 style={{ fontFamily: "'Caveat', cursive", fontSize: 38, color: "#2a2a2a", textAlign: "center", marginBottom: 4 }}>
            Neural Board
          </h1>
          <p style={{ fontSize: 12, color: "#6a6a6a", textAlign: "center", marginBottom: 24, fontFamily: "'Courier New', monospace" }}>
            private beta - enter password
          </p>
          <input type="password" value={pwInput} onChange={(e) => setPwInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleUnlock(); }}
            placeholder="password" autoFocus style={inputStyle} />
          <button onClick={handleUnlock} style={primaryButtonStyle}>UNLOCK</button>
          {pwError ? <p style={{ color: "#ff3a3a", fontSize: 11, textAlign: "center", marginTop: 8, fontFamily: "monospace" }}>{pwError}</p> : null}
        </div>
      </main>
    );
  }

  const activeBeat = beats[activeBeatIdx];
  const activeBeatImage = activeBeat?.images?.[activeBeat.selectedImageIdx ?? 0];

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: "#2a2a2a" }}>Neural Board</span>
          <span style={{ fontSize: 11, color: "#6a6a6a", letterSpacing: 1, fontFamily: "monospace" }}>/ BUILDER</span>
        </div>
        <span style={{ fontSize: 12, color: "#6a6a6a", fontFamily: "monospace" }}>untitled.notebook</span>
      </header>

      <div style={splitStyle}>
        <section style={leftPanelStyle}>
          <SectionLabel n="1" title="Audio" />
          <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
            <button onClick={recording ? stopRecording : startRecording} disabled={processing || rendering}
              style={{ ...sketchButton, flex: 1, background: recording ? "#ff5e3a" : "#fffdf5",
                color: recording ? "white" : "#2a2a2a",
                opacity: processing || rendering ? 0.5 : 1 }}>
              {recording ? "STOP" : "RECORD"}
            </button>
            <button onClick={() => audioFileInputRef.current?.click()}
              disabled={recording || processing || rendering}
              style={{ ...sketchButton, flex: 1, opacity: recording || processing || rendering ? 0.5 : 1 }}>
              UPLOAD
            </button>
            <input ref={audioFileInputRef} type="file" accept="audio/*" onChange={handleAudioFile} style={{ display: "none" }} />
          </div>
          <div style={{ fontSize: 10, color: "#6a6a6a", fontStyle: "italic", fontFamily: "monospace", marginBottom: 24 }}>
            {processing ? "transcribing & finding images..." : "+ accepts .mp3 .wav .m4a .webm"}
          </div>

          {transcript ? (
            <>
              <SectionLabel n="2" title="Transcript" right={duration.toFixed(1) + "s"} />
              <div style={transcriptStyle}>{transcript}</div>
            </>
          ) : null}

          {beats.length > 0 ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontFamily: "'Caveat', cursive", fontSize: 22, color: '#2a2a2a', fontWeight: 700 }}>3. Beats</span>
                <div style={{ flex: 1, height: 1, background: '#2a2a2a', opacity: 0.2 }} />
                <span style={{ fontSize: 11, color: '#6a6a6a', fontFamily: 'monospace' }}>{beats.length} found / drag to reorder</span>
                <button onClick={addCustomBeat} style={{ ...miniButton, fontWeight: 700, padding: '2px 8px', fontSize: 12 }} title="Add a custom beat">+</button>
              </div>
              {beats.map((b, i) => {
                const isActive = i === activeBeatIdx;
                const displayImg = b.customImageUrl ?? b.images?.[b.selectedImageIdx ?? 0];
                return (
                  <div key={i} draggable
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={handleDragOver}
                    onDrop={() => handleDrop(i)}
                    onClick={() => setActiveBeatIdx(i)}
                    style={{ ...beatCardStyle,
                      boxShadow: isActive ? "0 0 0 2px #c8f135" : "2px 2px 0 #2a2a2a",
                      opacity: draggedBeatIdx === i ? 0.4 : 1 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <div style={{ width: 56, height: 56, border: "1.5px solid #2a2a2a", flexShrink: 0, overflow: "hidden", background: "#d4d4d4" }}>
                        {b.customVideoUrl ? (
                          <video src={b.customVideoUrl} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : displayImg ? (
                          <img src={displayImg} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <div style={{ width: "100%", height: "100%", background: "#2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 9, padding: 4, textAlign: "center" }}>no image</div>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace", color: "#2a2a2a" }}>
                            BEAT {i + 1}{isActive ? " ◂" : ""}
                          </span>
                          {editingBeatIdx === i ? (
                            <input
                              autoFocus
                              type="number"
                              step="0.1"
                              min={(b.startTime + 0.1).toFixed(1)}
                              max={duration.toFixed(1)}
                              defaultValue={b.endTime.toFixed(1)}
                              onChange={e => setEditEndVal(e.target.value)}
                              onBlur={() => commitBeatEnd(i, editEndVal || b.endTime.toString())}
                              onKeyDown={e => { if (e.key === 'Enter') commitBeatEnd(i, editEndVal || b.endTime.toString()); if (e.key === 'Escape') setEditingBeatIdx(null); }}
                              onClick={e => e.stopPropagation()}
                              style={{ width: 60, fontSize: 10, fontFamily: 'monospace', border: '1px solid #2a2a2a', padding: '1px 3px', background: '#fffdf5' }}
                            />
                          ) : (
                            <span
                              onClick={e => { e.stopPropagation(); setEditEndVal(b.endTime.toFixed(1)); setEditingBeatIdx(i); }}
                              title="Click to edit end time"
                              style={{ fontSize: 10, color: "#6a6a6a", fontFamily: "monospace", cursor: 'pointer', borderBottom: '1px dashed #6a6a6a' }}>
                              {b.startTime.toFixed(1)}–{b.endTime.toFixed(1)}s
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: "#2a2a2a", marginBottom: 6, fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {b.searchQuery}
                        </div>
                        {/* Thumbnail strip + upload */}
                        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "center" }}>
                          {(b.images || []).map((imgUrl, imgI) => {
                            const selected = !b.customImageUrl && imgI === (b.selectedImageIdx ?? 0);
                            return (
                              <div key={imgI}
                                onClick={(e) => { e.stopPropagation(); selectBeatImage(i, imgI); }}
                                style={{ width: 22, height: 22, flexShrink: 0, overflow: "hidden", cursor: "pointer",
                                  border: selected ? "1.5px solid #c8f135" : "1px solid rgba(42,42,42,0.3)",
                                  outline: selected ? "1px solid #2a2a2a" : "none" }}>
                                <img src={imgUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                              </div>
                            );
                          })}
                          {b.customImageUrl && (
                            <div style={{ width: 22, height: 22, flexShrink: 0, overflow: "hidden",
                              border: "1.5px solid #c8f135", outline: "1px solid #2a2a2a" }}>
                              <img src={b.customImageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                            </div>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); uploadBeatIdxRef.current = i; beatImageInputRef.current?.click(); }}
                            style={{ ...miniButton, width: 22, height: 22, padding: 0, fontSize: 14, fontWeight: 700,
                              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            +
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          ) : null}

          {beats.length > 0 ? (
            <>
              <SectionLabel n="4" title="Background" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 24 }}>
                <BgTile name="cork" current={background} bgPreview={bgPreviews.cork} onClick={() => setBackground("cork")} />
                <BgTile name="beige" current={background} bgPreview={bgPreviews.beige} onClick={() => setBackground("beige")} />
                <BgTile name="graph" current={background} bgPreview={bgPreviews.graph} onClick={() => setBackground("graph")} />
                <div onClick={() => bgFileInputRef.current?.click()}
                  style={{ aspectRatio: "1", border: "1.5px dashed #2a2a2a",
                    background: customBgUrl ? "center/cover no-repeat url(" + customBgUrl + ")" : "rgba(255,253,245,0.5)",
                    cursor: "pointer", position: "relative",
                    boxShadow: background === "custom" ? "0 0 0 2px #c8f135" : "none",
                    display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {!customBgUrl ? <span style={{ fontSize: 18, color: "#2a2a2a", fontWeight: 700 }}>+</span> : null}
                  <div style={bgTileLabel}>upload</div>
                  <input ref={bgFileInputRef} type="file" accept="image/*" onChange={handleBgFile} style={{ display: "none" }} />
                </div>
              </div>
            </>
          ) : null}

          {beats.length > 0 ? (
            <>
              <SectionLabel n="5" title="Card Style" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 24 }}>
                {(["card", "bare"] as CardStyle[]).map((s) => (
                  <div key={s} onClick={() => setCardStyle(s)}
                    style={{ border: "1.5px solid #2a2a2a", padding: "10px 8px", cursor: "pointer", textAlign: "center",
                      boxShadow: cardStyle === s ? "0 0 0 2px #c8f135" : "2px 2px 0 #2a2a2a",
                      background: "rgba(255,253,245,0.85)", fontFamily: "monospace", fontSize: 11, fontWeight: 700 }}>
                    {s === "card" ? "CARD  (framed + tack)" : "BARE  (image only)"}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {beats.length > 0 && audioBlob && RAILWAY_URL ? (
            <button onClick={renderVideo} disabled={rendering} style={renderButtonStyle}>
              {rendering ? (renderStatus || "RENDERING...") : "RENDER VIDEO"}
            </button>
          ) : beats.length > 0 && audioBlob && !RAILWAY_URL ? (
            <div style={{ marginTop: 12, padding: "10px 12px", border: "1.5px dashed #2a2a2a", fontSize: 11, fontFamily: "monospace", color: "#6a6a6a" }}>
              mp4 export needs railway backend (not configured locally)
            </div>
          ) : null}

          {error ? <p style={{ color: "#ff3a3a", fontSize: 12, marginTop: 12, fontFamily: "monospace" }}>{error}</p> : null}

          {mp4Url ? (
            <a href={mp4Url} download="neuralboard.mp4" style={{ ...sketchButton, display: "block", marginTop: 12, background: "white", textAlign: "center", textDecoration: "none" }}>
              DOWNLOAD MP4
            </a>
          ) : null}
        </section>

        <section style={rightPanelStyle}>
          {/* Draw toolbar */}
          <div style={drawToolbarStyle}>
            <button
              onClick={() => setDrawMode((d) => !d)}
              style={{ ...miniButton, background: drawMode ? "#c8f135" : "transparent", fontWeight: 700, padding: "4px 10px" }}>
              {drawMode ? "✏ DRAWING" : "✏ DRAW"}
            </button>
            {drawMode && (
              <>
                {["#2a2a2a", "#ff3a3a", "#c8f135", "#3a7fff", "#ffffff"].map((c) => (
                  <div key={c} onClick={() => setDrawColor(c)}
                    style={{ width: 18, height: 18, borderRadius: "50%", background: c, cursor: "pointer",
                      border: drawColor === c ? "2px solid #c8f135" : "1.5px solid #2a2a2a",
                      boxShadow: drawColor === c ? "0 0 0 1px #2a2a2a" : "none" }} />
                ))}
                {[2, 5, 10].map((s) => (
                  <div key={s} onClick={() => setDrawSize(s)}
                    style={{ width: s + 10, height: s + 10, borderRadius: "50%", background: drawColor, cursor: "pointer",
                      border: drawSize === s ? "2px solid #c8f135" : "1px solid #2a2a2a", flexShrink: 0 }} />
                ))}
                <button onClick={clearDrawing} style={{ ...miniButton, marginLeft: "auto" }}>clear</button>
              </>
            )}
            {!drawMode && beats.length > 0 && (
              <span style={{ fontSize: 9, color: "rgba(0,0,0,0.3)", fontFamily: "monospace", marginLeft: "auto" }}>
                drag cards · click to select · + to upload image
              </span>
            )}
          </div>

          {/* Board */}
          <div
            ref={boardRef}
            onPointerMove={handleBoardPointerMove}
            onPointerUp={handleBoardPointerUp}
            onPointerLeave={handleBoardPointerUp}
            style={boardStyle(background, customBgUrl)}
          >
            {beats.length === 0 ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                <div style={{ color: "#6a6a6a", fontFamily: "monospace", fontSize: 13, textAlign: "center", background: "rgba(255,253,245,0.8)", padding: "16px 20px", border: "1.5px dashed #2a2a2a" }}>
                  record or upload audio<br/>cards appear here — drag them freely
                </div>
              </div>
            ) : null}

            {beats.map((b, i) => {
              const isActive = i === activeBeatIdx;
              const displayImg = b.customImageUrl ?? b.images?.[b.selectedImageIdx ?? 0];
              const rot = (((i * 137) % 60) - 30) / 10;
              const x = b.pos?.x ?? 40 + (i % 3) * 160;
              const y = b.pos?.y ?? 40 + Math.floor(i / 3) * 210;
              const cardW = b.size ?? CARD_W;
              const isBare = cardStyle === "bare";

              return (
                <div
                  key={i}
                  onPointerDown={(e) => { if (!drawMode) handleBoardPointerDown(e, i); }}
                  onClick={() => setActiveBeatIdx(i)}
                  style={{
                    position: "absolute",
                    left: x,
                    top: y,
                    width: cardW,
                    cursor: drawMode ? "crosshair" : "grab",
                    userSelect: "none",
                    transform: `rotate(${rot * 0.4}deg)`,
                    transformOrigin: "center top",
                    zIndex: isActive ? 10 : i,
                    filter: isActive
                      ? "drop-shadow(0 6px 12px rgba(0,0,0,0.4))"
                      : "drop-shadow(2px 3px 6px rgba(0,0,0,0.25))",
                  }}
                >
                  {isBare ? (
                    <div style={{ position: "relative", outline: isActive ? "2px solid #c8f135" : "none" }}>
                      {b.customVideoUrl ? (
                        <video autoPlay muted loop playsInline style={{ width: '100%', height: 'auto', display: 'block', pointerEvents: 'none' }} src={b.customVideoUrl} />
                      ) : displayImg ? (
                        <img src={displayImg} alt="" style={{ width: "100%", height: "auto", display: "block", pointerEvents: "none" }} />
                      ) : (
                        <div style={{ width: "100%", height: 80, background: "#2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", color: "#c8f135", fontSize: 9, fontFamily: "monospace", padding: 4, textAlign: "center" }}>
                          {b.searchQuery}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ background: "white", border: isActive ? "2px solid #c8f135" : "1.5px solid #2a2a2a", padding: 6, paddingBottom: 0, position: "relative" }}>
                      <div style={{ width: "100%", background: "#2a2a2a", marginBottom: 6 }}>
                        {b.customVideoUrl ? (
                          <video autoPlay muted loop playsInline style={{ width: '100%', height: 'auto', display: 'block', pointerEvents: 'none' }} src={b.customVideoUrl} />
                        ) : displayImg ? (
                          <img src={displayImg} alt="" style={{ width: "100%", height: "auto", display: "block", pointerEvents: "none" }} />
                        ) : (
                          <div style={{ width: "100%", height: 80, display: "flex", alignItems: "center", justifyContent: "center", color: "#c8f135", fontSize: 9, fontFamily: "monospace", padding: 4, textAlign: "center" }}>
                            {b.searchQuery}
                          </div>
                        )}
                      </div>
                      <div style={{ height: 22, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ fontSize: 9, fontFamily: "monospace", color: "#2a2a2a", fontWeight: 700, letterSpacing: 0.5 }}>
                          BEAT {i + 1}
                        </span>
                      </div>
                      <div style={{ position: "absolute", top: -6, left: "50%", transform: "translateX(-50%)", width: 11, height: 11, background: "#ff3a3a", border: "1px solid #2a2a2a", borderRadius: "50%", zIndex: 1 }} />
                    </div>
                  )}
                  {/* Resize handle — bottom-right corner */}
                  {!drawMode && (
                    <div
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        resizeRef.current = { idx: i, startX: e.clientX, startSize: cardW };
                      }}
                      style={{ position: "absolute", bottom: -6, right: -6, width: 12, height: 12,
                        background: isActive ? "#c8f135" : "white", border: "1.5px solid #2a2a2a",
                        cursor: "se-resize", zIndex: 20, borderRadius: 2 }}
                    />
                  )}
                </div>
              );
            })}

            {/* Drawing canvas overlay */}
            <canvas
              ref={drawCanvasRef}
              onPointerDown={handleDrawStart}
              onPointerMove={handleDrawMove}
              onPointerUp={handleDrawEnd}
              onPointerLeave={handleDrawEnd}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
                pointerEvents: drawMode ? "auto" : "none",
                cursor: drawMode ? "crosshair" : "default" }}
            />
          </div>
        </section>

        {/* Hidden file input for beat media upload */}
        <input ref={beatImageInputRef} type="file" accept="image/*,video/*" onChange={handleBeatMediaUpload} style={{ display: "none" }} />
      </div>

      <canvas ref={canvasRef} style={{ display: "none" }} />
    </main>
  );
}

function SectionLabel({ n, title, right }: { n: string; title: string; right?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
      <span style={{ fontFamily: "'Caveat', cursive", fontSize: 22, color: "#2a2a2a", fontWeight: 700 }}>{n}. {title}</span>
      <div style={{ flex: 1, height: 1, background: "#2a2a2a", opacity: 0.2 }} />
      {right ? <span style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>{right}</span> : null}
    </div>
  );
}

function BgTile({ name, current, bgPreview, onClick }: { name: Background; current: Background; bgPreview: string; onClick: () => void }) {
  const selected = current === name;
  return (
    <div onClick={onClick}
      style={{ aspectRatio: "1", border: "1.5px solid #2a2a2a", background: bgPreview, cursor: "pointer", position: "relative",
        boxShadow: selected ? "0 0 0 2px #c8f135" : "none" }}>
      <div style={bgTileLabel}>{name}</div>
    </div>
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed: " + url));
    img.src = url;
  });
}

async function loadFirstWorking(urls: string[]): Promise<HTMLImageElement | null> {
  for (const url of urls) {
    try { return await loadImage(url); } catch { continue; }
  }
  return null;
}

function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number, background: Background,
  bgImg: HTMLImageElement | null, camX: number, camY: number, boardWidth: number, boardHeight: number) {
  if (background === "custom" && bgImg) {
    const imgRatio = bgImg.width / bgImg.height;
    const slotRatio = W / H;
    let sx = 0, sy = 0, sw = bgImg.width, sh = bgImg.height;
    if (imgRatio > slotRatio) { sw = bgImg.height * slotRatio; sx = (bgImg.width - sw) / 2; }
    else { sh = bgImg.width / slotRatio; sy = (bgImg.height - sh) / 2; }
    ctx.drawImage(bgImg, sx, sy, sw, sh, 0, 0, W, H);
    return;
  }
  if (background === "cork") {
    ctx.fillStyle = "#b08964";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#8a6740";
    for (let i = 0; i < 600; i++) {
      const px = (i * 137.5) % boardWidth;
      const py = (i * 89.3) % boardHeight;
      const screenX = px - camX + W / 2;
      const screenY = py - camY + H / 2;
      if (screenX < -5 || screenX > W + 5 || screenY < -5 || screenY > H + 5) continue;
      const r = ((i * 7) % 3) + 0.5;
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      ctx.arc(screenX, screenY, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return;
  }
  if (background === "beige") {
    ctx.fillStyle = "#e8d9b8";
    ctx.fillRect(0, 0, W, H);
    return;
  }
  if (background === "graph") {
    ctx.fillStyle = "#f5f1e8";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(100,130,180,0.3)";
    ctx.lineWidth = 1;
    const grid = 40;
    const offsetX = -((camX % grid + grid) % grid);
    const offsetY = -((camY % grid + grid) % grid);
    for (let x = offsetX; x <= W; x += grid) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = offsetY; y <= H; y += grid) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    return;
  }
  ctx.fillStyle = "#f5f1e8";
  ctx.fillRect(0, 0, W, H);
}

function drawCardAt(ctx: CanvasRenderingContext2D, img: CanvasImageSource | null, worldX: number, worldY: number, beatIdx: number, fallbackText: string) {
  const cardW = 720;
  const cardH = 960;
  const borderW = 18;
  const rotation = (((beatIdx * 137) % 60) - 30) / 100;

  ctx.save();
  ctx.translate(worldX, worldY);
  ctx.rotate(rotation * 0.4);
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetX = 8;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(-cardW / 2, -cardH / 2, cardW, cardH);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  const imgW = cardW - borderW * 2;
  const imgH = cardH - borderW * 2 - 80;
  const imgX = -cardW / 2 + borderW;
  const imgY = -cardH / 2 + borderW;

  if (img) {
    const srcW = img instanceof HTMLVideoElement ? img.videoWidth : (img as HTMLImageElement).width;
    const srcH = img instanceof HTMLVideoElement ? img.videoHeight : (img as HTMLImageElement).height;
    const imgRatio = srcW / srcH;
    const slotRatio = imgW / imgH;
    let sx = 0, sy = 0, sw = srcW, sh = srcH;
    if (imgRatio > slotRatio) { sw = srcH * slotRatio; sx = (srcW - sw) / 2; }
    else { sh = srcW / slotRatio; sy = (srcH - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, imgX, imgY, imgW, imgH);
  } else {
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(imgX, imgY, imgW, imgH);
    ctx.fillStyle = "#c8f135";
    ctx.font = "bold 36px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const words = fallbackText.split(" ");
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if ((line + " " + word).length > 18) { lines.push(line); line = word; }
      else { line = line ? line + " " + word : word; }
    }
    if (line) lines.push(line);
    lines.forEach((ln, i) => {
      ctx.fillText(ln, imgX + imgW / 2, imgY + imgH / 2 + (i - lines.length / 2) * 44);
    });
  }
  ctx.restore();
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

const splitStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(420px, 38%) 1fr",
};

const leftPanelStyle: React.CSSProperties = {
  padding: "20px 24px",
  borderRight: "1.5px dashed #2a2a2a",
  minHeight: "calc(100vh - 60px)",
  overflowY: "auto",
};

const rightPanelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: "calc(100vh - 60px)",
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

const renderButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  marginTop: 12,
  fontSize: 16,
  padding: 16,
  letterSpacing: 1,
  boxShadow: "3px 3px 0 #2a2a2a",
  border: "2px solid #2a2a2a",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px",
  border: "1.5px solid #2a2a2a",
  background: "#fffdf5",
  fontSize: 14,
  fontFamily: "monospace",
  boxShadow: "2px 2px 0 #2a2a2a",
  marginBottom: 8,
};

const transcriptStyle: React.CSSProperties = {
  background: "rgba(255,253,245,0.85)",
  border: "1.5px solid #2a2a2a",
  padding: "10px 12px",
  fontSize: 13,
  lineHeight: 1.55,
  marginBottom: 24,
  boxShadow: "2px 2px 0 #2a2a2a",
};

const beatCardStyle: React.CSSProperties = {
  background: "rgba(255,253,245,0.85)",
  border: "1.5px solid #2a2a2a",
  padding: 10,
  marginBottom: 8,
  cursor: "pointer",
};

const miniButton: React.CSSProperties = {
  fontFamily: "monospace",
  background: "transparent",
  border: "1px solid #2a2a2a",
  padding: "2px 6px",
  cursor: "pointer",
  fontSize: 10,
};

const bgPreviews = {
  cork: "linear-gradient(135deg, #b08964 0%, #8a6740 100%)",
  beige: "#e8d9b8",
  graph: "#f5f1e8 linear-gradient(rgba(100,130,180,.4) 1px, transparent 1px) 0 0/8px 8px, linear-gradient(90deg, rgba(100,130,180,.4) 1px, transparent 1px) 0 0/8px 8px",
};

const bgTileLabel: React.CSSProperties = {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  background: "rgba(255,253,245,0.9)",
  fontSize: 9,
  padding: 2,
  textAlign: "center",
  fontFamily: "monospace",
  fontWeight: 700,
  color: "#2a2a2a",
};

const lockScreenStyle: React.CSSProperties = {
  ...pageStyle,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 32,
};

function redrawCanvas(canvas: HTMLCanvasElement, strokesToDraw: Stroke[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const stroke of strokesToDraw) {
    if (stroke.points.length < 2) continue;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const pt of stroke.points.slice(1)) {
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
  }
}

const drawToolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  borderBottom: "1px solid rgba(42,42,42,0.15)",
  background: "rgba(255,253,245,0.9)",
  minHeight: 38,
};


function boardStyle(background: Background, customBgUrl: string): React.CSSProperties {
  const isGraph = background === "graph";
  const isCustom = background === "custom" && !!customBgUrl;
  return {
    position: "relative",
    flex: 1,
    overflow: "hidden",
    backgroundColor:
      background === "cork" ? "#b08964" :
      background === "beige" ? "#e8d9b8" :
      "#f5f1e8",
    backgroundImage: isCustom
      ? `url(${customBgUrl})`
      : isGraph
        ? "linear-gradient(rgba(100,130,180,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(100,130,180,.35) 1px, transparent 1px)"
        : "none",
    backgroundSize: isCustom ? "cover" : isGraph ? "28px 28px" : undefined,
    backgroundPosition: isCustom ? "center" : undefined,
    touchAction: "none",
  };
}

