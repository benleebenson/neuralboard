"use client";

import { useState, useRef, useEffect, Fragment } from "react";
import { useSession, signIn, signOut } from "next-auth/react";

type CameraMode = "default" | "closeup" | "pan-left" | "pan-right";

type Transition = {
  zoomOut: number;  // 0–1: how far to zoom out (1 = show whole board, 0.5 = halfway)
  duration: number; // seconds
};

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
  cameraMode?: CameraMode;
  transition?: Transition;
};

type Background = "cork" | "beige" | "graph" | "custom";
type CardStyle = "card" | "bare";
type Stroke = { color: string; size: number; points: Array<{ x: number; y: number }> };

type OverlayType = "text" | "arrow" | "circle";
type Overlay = {
  id: string;
  type: OverlayType;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  r?: number;
  text?: string;
  color: string;
  strokeWidth: number;
  fontSize?: number;
};


type YtSearchResult = { id: string; title: string; channel: string; duration: string | number; thumbnail: string };
type YtModalView = 'search' | 'trim';

// Railway config is loaded server-side via /api/config after login
const CARD_W = 130;
const CARD_H = 170;

export default function BuilderPage() {
  const { data: session, status } = useSession();
  const [config, setConfig] = useState<{ railwayUrl: string; railwayPassword: string } | null>(null);

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
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [aiArranging, setAiArranging] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [canGenerate, setCanGenerate] = useState(true);
  const [recSeconds, setRecSeconds] = useState(0);
  const [expandedBeatIdx, setExpandedBeatIdx] = useState<number | null>(null);
  const [introPanDuration, setIntroPanDuration] = useState<number | null>(null);

  const [ytModalOpen, setYtModalOpen] = useState(false);
  const [ytModalBeatIdx, setYtModalBeatIdx] = useState<number | null>(null);
  const [ytQuery, setYtQuery] = useState('');
  const [ytResults, setYtResults] = useState<YtSearchResult[]>([]);
  const [ytView, setYtView] = useState<YtModalView>('search');
  const [ytSelected, setYtSelected] = useState<YtSearchResult | null>(null);
  const [ytStart, setYtStart] = useState(0);
  const [ytEnd, setYtEnd] = useState(30);
  const [ytError, setYtError] = useState('');
  const [ytLoading, setYtLoading] = useState(false);

  const [playingBeatIdx, setPlayingBeatIdx] = useState<number | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewAudioUrlRef = useRef<string | null>(null);
  const previewRafRef = useRef<number | null>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioFileInputRef = useRef<HTMLInputElement | null>(null);
  const bgFileInputRef = useRef<HTMLInputElement | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ idx: number; ox: number; oy: number; startBeatX: number; startBeatY: number; currentX: number; currentY: number } | null>(null);
  const cardElemsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const beatImageInputRef = useRef<HTMLInputElement | null>(null);
  const uploadBeatIdxRef = useRef<number>(-1);
  const resizeRef = useRef<{ idx: number; startX: number; startSize: number; currentSize: number } | null>(null);
  const overlaySvgRef = useRef<SVGSVGElement | null>(null);
  const overlayDragRef = useRef<{
    id: string;
    mode: "body" | "arrow-start" | "arrow-end" | "circle-radius";
    startClientX: number; startClientY: number;
    origX: number; origY: number;
    origX2?: number; origY2?: number; origR?: number;
  } | null>(null);

  useEffect(() => {
    if (!session?.user?.email) return;
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => setConfig(d))
      .catch(() => {});
  }, [session?.user?.email]);

  useEffect(() => {
    if (!session?.user?.email) return;
    fetch("/api/usage/check")
      .then((r) => r.json())
      .then((d) => {
        setIsSubscribed(!!d.isSubscribed);
        setCanGenerate(!!d.canGenerate);
      })
      .catch(() => {});
  }, [session?.user?.email]);

  // Start/stop the recording second-counter
  useEffect(() => {
    if (!recording) { setRecSeconds(0); return; }
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  // Auto-stop free-tier recording at 59 s
  useEffect(() => {
    if (recording && !isSubscribed && recSeconds >= 59) stopRecording();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recSeconds]);

  // Keep strokesRef in sync so ResizeObserver can read current strokes
  useEffect(() => { strokesRef.current = strokes; }, [strokes]);

  // Resize the draw canvas to match board, redraw strokes at new scale.
  // Re-runs after sign-in so the board is mounted before we attach the ResizeObserver.
  useEffect(() => {
    if (status !== "authenticated") return;
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
  }, [status]);

  // Redraw whenever committed strokes change
  useEffect(() => {
    const canvas = drawCanvasRef.current;
    if (canvas) redrawCanvas(canvas, strokes);
  }, [strokes]);

  // Revoke cached preview URL when audioBlob changes so next play gets a fresh URL
  useEffect(() => {
    stopPreview();
    if (previewAudioUrlRef.current) {
      URL.revokeObjectURL(previewAudioUrlRef.current);
      previewAudioUrlRef.current = null;
    }
    if (previewAudioRef.current) {
      previewAudioRef.current.src = "";
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioBlob]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPreview();
      if (previewAudioUrlRef.current) {
        URL.revokeObjectURL(previewAudioUrlRef.current);
        previewAudioUrlRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    function proceed() {
      setError("");
      setTranscript("");
      setBeats([]);
      setDuration(0);
      setMp4Url("");
      setAudioBlob(file!);
      setProcessing(true);
      sendToTranscribe(file!);
    }

    if (isSubscribed) { proceed(); return; }

    // Check duration client-side before spending any API calls
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    audio.addEventListener("loadedmetadata", () => {
      URL.revokeObjectURL(url);
      if (audio.duration > 59) {
        setError("Free tier: 59s max. Upgrade for longer recordings.");
        e.target.value = "";
        return;
      }
      proceed();
    });
    audio.addEventListener("error", () => { URL.revokeObjectURL(url); proceed(); });
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
        },
        body: blob,
      });
      if (res.status === 401) {
        signIn("google");
        setProcessing(false);
        return;
      }
      if (res.status === 403) {
        setError("You’ve used your free video. Upgrade to generate more.");
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
      currentX: beat.pos?.x ?? 0,
      currentY: beat.pos?.y ?? 0,
    };
    setActiveBeatIdx(idx);
    e.stopPropagation();
  }

  function handleBoardPointerMove(e: React.PointerEvent) {
    if (resizeRef.current) {
      const { idx, startX, startSize } = resizeRef.current;
      const newSize = Math.max(80, Math.min(400, startSize + (e.clientX - startX)));
      resizeRef.current.currentSize = newSize;
      const el = cardElemsRef.current.get(idx);
      if (el) el.style.width = newSize + "px";
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
    dragRef.current.currentX = newX;
    dragRef.current.currentY = newY;
    const el = cardElemsRef.current.get(idx);
    if (el) { el.style.left = newX + "px"; el.style.top = newY + "px"; }
  }

  function handleBoardPointerUp() {
    if (dragRef.current) {
      const { idx, currentX, currentY } = dragRef.current;
      setBeats(prev => prev.map((b, i) => i === idx ? { ...b, pos: { x: currentX, y: currentY } } : b));
    }
    if (resizeRef.current) {
      const { idx, currentSize } = resizeRef.current;
      setBeats(prev => prev.map((b, i) => i === idx ? { ...b, size: currentSize } : b));
    }
    dragRef.current = null;
    resizeRef.current = null;
  }

  function handleOverlayBodyDown(e: React.PointerEvent, ov: Overlay) {
    e.stopPropagation();
    overlaySvgRef.current?.setPointerCapture(e.pointerId);
    setSelectedOverlayId(ov.id);
    overlayDragRef.current = {
      id: ov.id, mode: "body",
      startClientX: e.clientX, startClientY: e.clientY,
      origX: ov.x, origY: ov.y,
      origX2: ov.x2, origY2: ov.y2,
    };
  }

  function handleOverlayEndpointDown(e: React.PointerEvent, ov: Overlay, which: "start" | "end") {
    e.stopPropagation();
    overlaySvgRef.current?.setPointerCapture(e.pointerId);
    overlayDragRef.current = {
      id: ov.id, mode: which === "start" ? "arrow-start" : "arrow-end",
      startClientX: e.clientX, startClientY: e.clientY,
      origX: ov.x, origY: ov.y,
      origX2: ov.x2, origY2: ov.y2,
    };
  }

  function handleOverlayRadiusDown(e: React.PointerEvent, ov: Overlay) {
    e.stopPropagation();
    overlaySvgRef.current?.setPointerCapture(e.pointerId);
    overlayDragRef.current = {
      id: ov.id, mode: "circle-radius",
      startClientX: e.clientX, startClientY: e.clientY,
      origX: ov.x, origY: ov.y, origR: ov.r,
    };
  }

  function handleOverlayPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const drag = overlayDragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    setOverlays(prev => prev.map(ov => {
      if (ov.id !== drag.id) return ov;
      if (drag.mode === "body") {
        if (ov.type === "arrow" && drag.origX2 !== undefined && drag.origY2 !== undefined)
          return { ...ov, x: drag.origX + dx, y: drag.origY + dy, x2: drag.origX2 + dx, y2: drag.origY2 + dy };
        return { ...ov, x: drag.origX + dx, y: drag.origY + dy };
      }
      if (drag.mode === "arrow-start") return { ...ov, x: drag.origX + dx, y: drag.origY + dy };
      if (drag.mode === "arrow-end") return { ...ov, x2: (drag.origX2 ?? 0) + dx, y2: (drag.origY2 ?? 0) + dy };
      if (drag.mode === "circle-radius") return { ...ov, r: Math.max(20, (drag.origR ?? 50) + dx) };
      return ov;
    }));
  }

  function handleOverlayPointerUp() {
    overlayDragRef.current = null;
  }

  async function aiArrange() {
    if (beats.length === 0) return;
    setAiArranging(true);
    setError("");
    try {
      const board = boardRef.current;
      const boardW = board ? board.getBoundingClientRect().width : 800;
      const boardH = board ? board.getBoundingClientRect().height : 600;
      const res = await fetch("/api/arrange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beats: beats.map((b, i) => ({
            i,
            query: b.searchQuery,
            x: b.pos?.x ?? (40 + (i % 3) * 160),
            y: b.pos?.y ?? (40 + Math.floor(i / 3) * 210),
          })),
          boardW,
          boardH,
        }),
      });
      if (!res.ok) throw new Error("Arrange failed");
      const data = await res.json();
      if (data.positions) setBeats(prev => prev.map((b, i) => data.positions[i] ? { ...b, pos: data.positions[i] } : b));
      if (data.overlays) setOverlays(data.overlays);
    } catch {
      setError("AI arrange failed — try again");
    } finally {
      setAiArranging(false);
    }
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

  function deleteBeat(idx: number) {
    setBeats(prev => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) return next;
      const segLen = duration / next.length;
      return next.map((b, i) => ({ ...b, startTime: i * segLen, endTime: (i + 1) * segLen }));
    });
    setActiveBeatIdx(prev => Math.max(0, prev >= idx ? prev - 1 : prev));
  }

  function stopPreview() {
    const audio = previewAudioRef.current;
    if (audio) audio.pause();
    if (previewRafRef.current !== null) { cancelAnimationFrame(previewRafRef.current); previewRafRef.current = null; }
    if (previewTimeoutRef.current !== null) { clearTimeout(previewTimeoutRef.current); previewTimeoutRef.current = null; }
    setPlayingBeatIdx(null);
  }

  function playBeatPreview(beatIdx: number, b: Beat) {
    stopPreview();
    if (!audioBlob) return;

    if (!previewAudioUrlRef.current) {
      previewAudioUrlRef.current = URL.createObjectURL(audioBlob);
    }
    if (!previewAudioRef.current) {
      previewAudioRef.current = new Audio();
      previewAudioRef.current.addEventListener("ended", stopPreview);
      previewAudioRef.current.addEventListener("error", stopPreview);
    }
    const audio = previewAudioRef.current;
    if (audio.src !== previewAudioUrlRef.current) {
      audio.src = previewAudioUrlRef.current;
    }

    const startTime = b.startTime;
    const endTime = b.endTime;

    function beginPlayback() {
      audio.currentTime = startTime;
      // Wait for seek to land before playing — avoids blip from wrong position
      audio.addEventListener("seeked", function onSeeked() {
        audio.removeEventListener("seeked", onSeeked);
        // Arm rAF endTime guard
        function rafCheck() {
          if (audio.currentTime >= endTime) { stopPreview(); return; }
          previewRafRef.current = requestAnimationFrame(rafCheck);
        }
        previewRafRef.current = requestAnimationFrame(rafCheck);
        // Backstop timeout: slice duration + 150ms buffer for busy main thread
        previewTimeoutRef.current = setTimeout(stopPreview, (endTime - startTime) * 1000 + 150);
        setPlayingBeatIdx(beatIdx);
        audio.play().catch(stopPreview);
      }, { once: true });
    }

    // If audio isn't ready to seek, wait for loadeddata first
    if (audio.readyState >= 1) {
      beginPlayback();
    } else {
      audio.addEventListener("loadeddata", beginPlayback, { once: true });
      audio.load();
    }
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

  function addTransition(afterBeatIdx: number) {
    setBeats(prev => prev.map((b, i) =>
      i === afterBeatIdx + 1 ? { ...b, transition: { zoomOut: 1, duration: 1 } } : b
    ));
  }

  function removeTransition(beatIdx: number) {
    setBeats(prev => prev.map((b, i) =>
      i === beatIdx ? { ...b, transition: undefined } : b
    ));
  }

  function updateTransition(beatIdx: number, updates: Partial<Transition>) {
    setBeats(prev => prev.map((b, i) =>
      i === beatIdx && b.transition ? { ...b, transition: { ...b.transition, ...updates } } : b
    ));
  }

  async function handleYtSearch() {
    if (!config?.railwayUrl || !ytQuery.trim()) return;
    setYtLoading(true);
    setYtError('');
    setYtResults([]);
    try {
      const res = await fetch(`${config.railwayUrl}/video-search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-neuralboard-password': config.railwayPassword,
        },
        body: JSON.stringify({ query: ytQuery, limit: 12 }),
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      setYtResults(Array.isArray(data) ? data : []);
    } catch (e) {
      setYtError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setYtLoading(false);
    }
  }

  async function handleYtConfirm() {
    if (!config?.railwayUrl || !ytSelected || ytModalBeatIdx === null) return;
    setYtLoading(true);
    setYtError('');
    try {
      const url = `https://www.youtube.com/watch?v=${ytSelected.id}`;
      const dlRes = await fetch(`${config.railwayUrl}/ytdl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-neuralboard-password': config.railwayPassword },
        body: JSON.stringify({ url, start: ytStart, end: ytEnd }),
      });
      if (!dlRes.ok) {
        const err = await dlRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Download failed (${dlRes.status})`);
      }
      const { id } = await dlRes.json() as { id: string };
      const fileRes = await fetch(`${config.railwayUrl}/ytdl-file/${id}`, {
        headers: { 'x-neuralboard-password': config.railwayPassword },
      });
      if (!fileRes.ok) throw new Error(`File fetch failed (${fileRes.status})`);
      const blob = await fileRes.blob();
      const blobUrl = URL.createObjectURL(blob);
      const idx = ytModalBeatIdx;
      setBeats(prev => prev.map((b, i) => i === idx ? { ...b, customVideoUrl: blobUrl, customImageUrl: undefined } : b));
      setYtModalOpen(false);
      setYtView('search');
      setYtSelected(null);
      setYtResults([]);
      setYtQuery('');
    } catch (e) {
      setYtError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setYtLoading(false);
    }
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
    if (!config?.railwayUrl) return;

    // Usage + duration gate
    const usageRes = await fetch("/api/usage/check");
    if (!usageRes.ok) { setError("Please sign in to render."); return; }
    const usage = await usageRes.json();
    if (!usage.canGenerate) {
      setError("UPGRADE_REQUIRED");
      return;
    }
    if (!usage.isAdmin && !usage.isSubscribed && duration > 30) {
      setError("UPGRADE_REQUIRED_LENGTH");
      return;
    }

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
      if (audioCtx.state === "suspended") await audioCtx.resume();
      const audioSource = audioCtx.createMediaElementSource(audioEl);
      const audioDest = audioCtx.createMediaStreamDestination();
      audioSource.connect(audioDest);
      audioSource.connect(audioCtx.destination);

      // Connect custom video audio tracks to the recording stream
      for (const vid of videoEls) {
        if (vid) {
          try { audioCtx.createMediaElementSource(vid).connect(audioDest); } catch {}
        }
      }

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
      const startMs = performance.now();
      const INTRO_SEC = introPanDuration ?? 0;
      try { await audioEl.play(); } catch {}

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
      const boardCenterX = cardCenters.reduce((s, c) => s + c.x, 0) / (cardCenters.length || 1);
      const boardCenterY = cardCenters.reduce((s, c) => s + c.y, 0) / (cardCenters.length || 1);

      // Where the camera arrives at the start of the settle phase for a given beat
      function beatPanTarget(bidx: number): { x: number; y: number; zoom: number } {
        if (bidx < 0 || bidx >= beats.length) return { x: cardCenters[0]?.x ?? 0, y: cardCenters[0]?.y ?? 0, zoom: 1 };
        const b = beats[bidx]; const c = cardCenters[bidx];
        const bw = (b.size ?? CARD_W) * scale;
        const m = b.cameraMode ?? "default";
        if (m === "pan-right") return { x: c.x - bw * 0.3, y: c.y, zoom: 1.3 };
        if (m === "pan-left") return { x: c.x + bw * 0.3, y: c.y, zoom: 1.3 };
        return { x: c.x, y: c.y, zoom: 1 };
      }
      // Where the camera ends up at the end of the settle phase for a given beat
      function beatEndCam(bidx: number): { x: number; y: number; zoom: number } {
        if (bidx < 0 || bidx >= beats.length) return { x: cardCenters[0]?.x ?? 0, y: cardCenters[0]?.y ?? 0, zoom: 1 };
        const b = beats[bidx]; const c = cardCenters[bidx];
        const bw = (b.size ?? CARD_W) * scale;
        const m = b.cameraMode ?? "default";
        if (m === "pan-right") return { x: c.x + bw * 0.3, y: c.y, zoom: 1.3 };
        if (m === "pan-left") return { x: c.x - bw * 0.3, y: c.y, zoom: 1.3 };
        if (m === "closeup") return { x: c.x, y: c.y, zoom: 1.9 };
        return { x: c.x, y: c.y, zoom: 1 };
      }

      let prevRenderBeatIdx = -1;
      function drawFrame() {
        const elapsedSec = (performance.now() - startMs) / 1000;
        const audioSec = Math.max(0, elapsedSec - INTRO_SEC);

        if (elapsedSec >= INTRO_SEC + safeDuration) {
          renderRecorder.stop();
          audioEl.pause();
          return;
        }

        let camX: number, camY: number, zoom: number;

        if (elapsedSec < INTRO_SEC && cardCenters.length > 0) {
          // Pan across all cards, then sweep back to card 1
          const t = elapsedSec / INTRO_SEC;
          const panEnd = 0.75; // first 75% of intro pans through all cards
          if (t < panEnd) {
            const p = t / panEnd;
            const eased = 0.5 - 0.5 * Math.cos(p * Math.PI);
            const cardIdx = eased * (cardCenters.length - 1);
            const lo = Math.floor(cardIdx);
            const hi = Math.min(lo + 1, cardCenters.length - 1);
            const frac = cardIdx - lo;
            camX = cardCenters[lo].x + (cardCenters[hi].x - cardCenters[lo].x) * frac;
            camY = cardCenters[lo].y + (cardCenters[hi].y - cardCenters[lo].y) * frac;
            zoom = 0.75 + 0.25 * eased;
          } else {
            // Ease back to first card
            const p = (t - panEnd) / (1 - panEnd);
            const eased = 0.5 - 0.5 * Math.cos(p * Math.PI);
            const last = cardCenters[cardCenters.length - 1];
            const first = cardCenters[0];
            camX = last.x + (first.x - last.x) * eased;
            camY = last.y + (first.y - last.y) * eased;
            zoom = 1;
          }
        } else {
          // Normal beat playback
          const idx = beats.findIndex(
            (b) => audioSec >= b.startTime && audioSec < b.endTime
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
          const transition = currentIdx > 0 ? currentBeat?.transition : undefined;

          if (transition) {
            const beatDur = currentBeat.endTime - currentBeat.startTime;
            const transSec = Math.min(transition.duration, beatDur * 0.9);
            const transEnd = currentBeat.startTime + transSec;
            const prevEnd = beatEndCam(currentIdx - 1);
            const currTarget = beatPanTarget(currentIdx);
            const peakZoom = 1.0 - transition.zoomOut * 0.7;

            if (audioSec < transEnd) {
              const t = Math.min(1, (audioSec - currentBeat.startTime) / transSec);
              if (t < 0.5) {
                const eased = 0.5 - 0.5 * Math.cos(t * 2 * Math.PI);
                camX = prevEnd.x + (boardCenterX - prevEnd.x) * eased;
                camY = prevEnd.y + (boardCenterY - prevEnd.y) * eased;
                zoom = prevEnd.zoom + (peakZoom - prevEnd.zoom) * eased;
              } else {
                const eased = 0.5 - 0.5 * Math.cos((t - 0.5) * 2 * Math.PI);
                camX = boardCenterX + (currTarget.x - boardCenterX) * eased;
                camY = boardCenterY + (currTarget.y - boardCenterY) * eased;
                zoom = peakZoom + (currTarget.zoom - peakZoom) * eased;
              }
            } else {
              const remaining = currentBeat.endTime - transEnd;
              const settleP = remaining > 0 ? Math.min(1, (audioSec - transEnd) / remaining) : 1;
              const settleEased = 0.5 - 0.5 * Math.cos(settleP * Math.PI);
              const endCam = beatEndCam(currentIdx);
              camX = currTarget.x + (endCam.x - currTarget.x) * settleEased;
              camY = currTarget.y + (endCam.y - currTarget.y) * settleEased;
              zoom = currTarget.zoom + (endCam.zoom - currTarget.zoom) * settleEased;
            }
          } else {
            const beatProgress = currentBeat
              ? Math.min(1, Math.max(0, (audioSec - currentBeat.startTime) / (currentBeat.endTime - currentBeat.startTime)))
              : 0;
            const panProgress = Math.min(1, beatProgress / 0.4);
            const panEased = 0.5 - 0.5 * Math.cos(panProgress * Math.PI);
            const settleProgress = Math.min(1, Math.max(0, (beatProgress - 0.4) / 0.6));
            const settleEased = 0.5 - 0.5 * Math.cos(settleProgress * Math.PI);

            const panTarget = beatPanTarget(currentIdx);
            const endCam = beatEndCam(currentIdx);
            // For first beat, skip pan travel and start directly at pan target
            const fromCam = currentIdx > 0 ? beatEndCam(currentIdx - 1) : panTarget;
            const mode = currentBeat?.cameraMode ?? "default";
            // Subtle breathe for default mode
            const breathe = mode === "default" ? 0.04 * Math.sin(settleProgress * Math.PI) : 0;

            camX = fromCam.x + (panTarget.x - fromCam.x) * panEased + (endCam.x - panTarget.x) * settleEased;
            camY = fromCam.y + (panTarget.y - fromCam.y) * panEased + (endCam.y - panTarget.y) * settleEased;
            zoom = fromCam.zoom + (panTarget.zoom - fromCam.zoom) * panEased + (endCam.zoom - panTarget.zoom) * settleEased + breathe;
          }
        }

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
          const beatCardW = (beats[i].size ?? CARD_W) * scale;
          drawCardAt(ctx!, mediaEl, center.x, center.y, i, beats[i].searchQuery, beatCardW);
        }

        // Draw AI overlays
        for (const ov of overlays) {
          const sx = ov.x * scale;
          const sy = ov.y * scale;
          if (ov.type === "text" && ov.text) {
            ctx!.save();
            ctx!.font = `bold ${(ov.fontSize ?? 20) * scale}px Arial`;
            ctx!.fillStyle = ov.color;
            ctx!.fillText(ov.text, sx, sy);
            ctx!.restore();
          } else if (ov.type === "arrow" && ov.x2 !== undefined && ov.y2 !== undefined) {
            const ex = ov.x2 * scale;
            const ey = ov.y2 * scale;
            const angle = Math.atan2(ey - sy, ex - sx);
            const aLen = 18 * scale;
            ctx!.save();
            ctx!.strokeStyle = ov.color;
            ctx!.fillStyle = ov.color;
            ctx!.lineWidth = (ov.strokeWidth ?? 3) * scale;
            ctx!.lineCap = "round";
            ctx!.beginPath(); ctx!.moveTo(sx, sy); ctx!.lineTo(ex, ey); ctx!.stroke();
            ctx!.beginPath();
            ctx!.moveTo(ex, ey);
            ctx!.lineTo(ex - aLen * Math.cos(angle - Math.PI / 6), ey - aLen * Math.sin(angle - Math.PI / 6));
            ctx!.lineTo(ex - aLen * Math.cos(angle + Math.PI / 6), ey - aLen * Math.sin(angle + Math.PI / 6));
            ctx!.closePath(); ctx!.fill();
            ctx!.restore();
          } else if (ov.type === "circle" && ov.r !== undefined) {
            ctx!.save();
            ctx!.strokeStyle = ov.color;
            ctx!.lineWidth = (ov.strokeWidth ?? 3) * scale;
            ctx!.beginPath();
            ctx!.arc(sx, sy, ov.r * scale, 0, Math.PI * 2);
            ctx!.stroke();
            ctx!.restore();
          }
        }

        // Strokes rendered on top of cards and overlays
        for (const stroke of strokes) {
          if (stroke.points.length < 2) continue;
          ctx!.strokeStyle = stroke.color;
          ctx!.lineWidth = stroke.size * scale;
          ctx!.lineCap = "round";
          ctx!.lineJoin = "round";
          ctx!.beginPath();
          ctx!.moveTo(stroke.points[0].x * scale, stroke.points[0].y * scale);
          for (const pt of stroke.points.slice(1)) {
            ctx!.lineTo(pt.x * scale, pt.y * scale);
          }
          ctx!.stroke();
        }

        ctx!.restore();

        requestAnimationFrame(drawFrame);
      }
      requestAnimationFrame(drawFrame);

      const webmBlob = await recordingDone;
      audioCtx.close();
      if (webmBlob.size < 1000) {
        throw new Error("Recording produced no data — try a different browser (Chrome works best)");
      }
      setRenderStatus("Converting to MP4 on server...");

      const mp4Res = await fetch(config.railwayUrl + "/render", {
        method: "POST",
        headers: { "Content-Type": "video/webm", "x-neuralboard-password": config.railwayPassword },
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
      // Log the render — this marks the user's free credit as used
      fetch("/api/render/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationSeconds: duration }),
      }).catch(err => console.error("RENDER_COMPLETE_CLIENT_FAIL:", err));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Render failed";
      setError(message);
      setRenderStatus("");
    } finally {
      setRendering(false);
    }
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
            sign in to continue · 1 free video per account
          </p>
          <button onClick={() => signIn("google")} style={primaryButtonStyle}>
            Sign in with Google
          </button>
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
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>{session.user.email}</span>
          {!isSubscribed && (
            <a href="/upgrade" style={{ fontSize: 10, fontFamily: "monospace", color: "#2a2a2a", textDecoration: "none", border: "1px solid #2a2a2a", padding: "3px 8px", borderRadius: 3, letterSpacing: 0.5 }}>
              subscribe →
            </a>
          )}
          <button onClick={() => signOut()} style={{ ...miniButton, fontSize: 10, padding: "3px 8px" }}>sign out</button>
        </div>
      </header>

      <div style={splitStyle}>
        <section style={leftPanelStyle}>
          <SectionLabel n="1" title="Audio" />
          <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
            <button
              onClick={() => {
                if (!canGenerate) { window.location.href = "/upgrade"; return; }
                if (recording) stopRecording(); else startRecording();
              }}
              disabled={processing || rendering}
              style={{ ...sketchButton, flex: 1, background: recording ? "#ff5e3a" : "#fffdf5",
                color: recording ? "white" : "#2a2a2a",
                opacity: processing || rendering ? 0.5 : 1 }}>
              {recording
                ? `STOP  0:${String(recSeconds).padStart(2, "0")}${!isSubscribed ? " / 0:59" : ""}`
                : "RECORD"}
            </button>
            <button
              onClick={() => {
                if (!canGenerate) { window.location.href = "/upgrade"; return; }
                audioFileInputRef.current?.click();
              }}
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
                {introPanDuration === null && (
                  <button onClick={() => setIntroPanDuration(3)} style={{ ...miniButton, padding: '2px 8px', fontSize: 12 }} title="Add intro pan across all cards">↔ pan</button>
                )}
                <button onClick={addCustomBeat} style={{ ...miniButton, fontWeight: 700, padding: '2px 8px', fontSize: 12 }} title="Add a custom beat">+</button>
              </div>
              {introPanDuration !== null && (
                <div style={{ ...beatCardStyle, background: "rgba(200,241,53,0.08)", border: "1.5px solid #c8f135", boxShadow: "2px 2px 0 #b0d020", marginBottom: 8 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <div style={{ width: 56, height: 56, border: "1.5px solid #2a2a2a", flexShrink: 0, background: "#2a2a2a",
                      display: "flex", alignItems: "center", justifyContent: "center", color: "#c8f135", fontSize: 22, fontWeight: 700 }}>
                      ↔
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace", color: "#2a2a2a" }}>INTRO PAN</span>
                        <button
                          onClick={() => setIntroPanDuration(null)}
                          style={{ ...miniButton, padding: "0 4px", color: "#ff3a3a", borderColor: "#ff3a3a", lineHeight: "14px", fontSize: 13 }}>×</button>
                      </div>
                      <div style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace", marginBottom: 6 }}>
                        pans across all cards before beats
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 10, fontFamily: "monospace", color: "#2a2a2a" }}>duration</span>
                        <input
                          type="number" step="0.5" min="0.5" max="20"
                          value={introPanDuration}
                          onChange={e => setIntroPanDuration(Math.max(0.5, parseFloat(e.target.value) || 3))}
                          onClick={e => e.stopPropagation()}
                          style={{ width: 52, fontSize: 10, fontFamily: "monospace", border: "1px solid #2a2a2a", padding: "1px 3px", background: "#fffdf5" }}
                        />
                        <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6a6a6a" }}>s</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {beats.map((b, i) => {
                const isActive = i === activeBeatIdx;
                const displayImg = b.customImageUrl ?? b.images?.[b.selectedImageIdx ?? 0];
                const nextTransition = i < beats.length - 1 ? beats[i + 1]?.transition : undefined;
                return (
                  <Fragment key={i}>
                  <div draggable
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
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace", color: "#2a2a2a" }}>
                            BEAT {i + 1}{isActive ? " ◂" : ""}
                          </span>
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
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
                            {audioBlob && (
                              <button
                                onClick={e => { e.stopPropagation(); playingBeatIdx === i ? stopPreview() : playBeatPreview(i, b); }}
                                style={{ ...miniButton, padding: "0 4px", fontSize: 11, lineHeight: "14px" }}
                                title={playingBeatIdx === i ? "Stop preview" : "Preview narration"}>
                                {playingBeatIdx === i ? "⏸" : "▶"}
                              </button>
                            )}
                            <button
                              onClick={e => { e.stopPropagation(); deleteBeat(i); }}
                              style={{ ...miniButton, padding: "0 4px", color: "#ff3a3a", borderColor: "#ff3a3a", lineHeight: "14px", fontSize: 13 }}
                              title="Delete beat">×</button>
                          </div>
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
                          {config?.railwayUrl && isSubscribed && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setYtModalBeatIdx(i); setYtView('search'); setYtQuery(''); setYtResults([]); setYtError(''); setYtModalOpen(true); }}
                              style={{ ...miniButton, height: 22, padding: '0 5px', fontSize: 9, fontWeight: 700, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2 }}
                              title="Search YouTube">
                              ▶ yt
                            </button>
                          )}
                        </div>
                        {/* Camera options */}
                        <div style={{ marginTop: 6, borderTop: "1px dashed rgba(42,42,42,0.15)", paddingTop: 5 }}>
                          <button
                            onClick={e => { e.stopPropagation(); setExpandedBeatIdx(expandedBeatIdx === i ? null : i); }}
                            style={{ ...miniButton, fontSize: 9, padding: "2px 6px" }}>
                            {expandedBeatIdx === i ? "▴ cam" : "▾ cam"}{b.cameraMode && b.cameraMode !== "default" ? ` · ${b.cameraMode}` : ""}
                          </button>
                          {expandedBeatIdx === i && (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 5 }}>
                              {(["default", "closeup", "pan-left", "pan-right"] as CameraMode[]).map(mode => {
                                const active = (b.cameraMode ?? "default") === mode;
                                const labels: Record<CameraMode, string> = { default: "default", closeup: "close-up", "pan-left": "pan ←", "pan-right": "pan →" };
                                return (
                                  <button key={mode}
                                    onClick={e => { e.stopPropagation(); setBeats(prev => prev.map((b2, j) => j === i ? { ...b2, cameraMode: mode } : b2)); }}
                                    style={{ ...miniButton, fontSize: 9, padding: "2px 7px",
                                      background: active ? "#2a2a2a" : "transparent",
                                      color: active ? "white" : "#2a2a2a",
                                      fontWeight: active ? 700 : 400 }}>
                                    {labels[mode]}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  {i < beats.length - 1 && (
                    nextTransition ? (
                      <div style={{ marginLeft: 20, marginBottom: 6, padding: "7px 10px", border: "1px dashed #2a2a2a",
                        background: "rgba(200,241,53,0.06)", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, color: "#2a2a2a" }}>↕</span>
                        <span style={{ fontSize: 10, fontWeight: 700, fontFamily: "monospace", color: "#2a2a2a", letterSpacing: 0.5 }}>ZOOM</span>
                        <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6a6a6a" }}>out</span>
                        <input type="number" step="0.1" min="0.1" max="1"
                          value={beats[i + 1].transition!.zoomOut}
                          onChange={e => updateTransition(i + 1, { zoomOut: Math.max(0.1, Math.min(1, parseFloat(e.target.value) || 1)) })}
                          onClick={e => e.stopPropagation()}
                          style={{ width: 44, fontSize: 10, fontFamily: "monospace", border: "1px solid #2a2a2a", padding: "1px 3px", background: "#fffdf5" }} />
                        <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6a6a6a" }}>dur</span>
                        <input type="number" step="0.5" min="0.2" max="10"
                          value={beats[i + 1].transition!.duration}
                          onChange={e => updateTransition(i + 1, { duration: Math.max(0.2, parseFloat(e.target.value) || 1) })}
                          onClick={e => e.stopPropagation()}
                          style={{ width: 44, fontSize: 10, fontFamily: "monospace", border: "1px solid #2a2a2a", padding: "1px 3px", background: "#fffdf5" }} />
                        <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6a6a6a" }}>s</span>
                        <button onClick={e => { e.stopPropagation(); removeTransition(i + 1); }}
                          style={{ ...miniButton, marginLeft: "auto", padding: "0 4px", color: "#ff3a3a", borderColor: "#ff3a3a", lineHeight: "14px", fontSize: 13 }}>×</button>
                      </div>
                    ) : (
                      <div style={{ marginLeft: 20, marginBottom: 6 }}>
                        <button onClick={e => { e.stopPropagation(); addTransition(i); }}
                          style={{ ...miniButton, fontSize: 9, padding: "2px 8px", opacity: 0.6 }}>
                          ↕ zoom transition
                        </button>
                      </div>
                    )
                  )}
                  </Fragment>
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

          {beats.length > 0 && audioBlob && config?.railwayUrl ? (
            <button onClick={renderVideo} disabled={rendering} style={renderButtonStyle}>
              {rendering ? (renderStatus || "RENDERING...") : "RENDER VIDEO"}
            </button>
          ) : beats.length > 0 && audioBlob && !config?.railwayUrl ? (
            <div style={{ marginTop: 12, padding: "10px 12px", border: "1.5px dashed #2a2a2a", fontSize: 11, fontFamily: "monospace", color: "#6a6a6a" }}>
              {config === null ? "loading config..." : "mp4 export needs railway backend (not configured)"}
            </div>
          ) : null}

          {error === "UPGRADE_REQUIRED" || error === "UPGRADE_REQUIRED_LENGTH" ? (
            <div style={{ marginTop: 12, padding: "12px 14px", border: "1.5px solid #ff3a3a", background: "#fff5f5" }}>
              <p style={{ color: "#cc2200", fontSize: 12, fontFamily: "monospace", margin: "0 0 10px", fontWeight: 700 }}>
                {error === "UPGRADE_REQUIRED_LENGTH"
                  ? `Free tier: 30s max (your audio is ${duration.toFixed(1)}s)`
                  : "You've used your free video."}
              </p>
              <a href="/upgrade" style={{ display: "inline-block", padding: "8px 16px", background: "#2a2a2a", color: "white", fontSize: 11, fontFamily: "monospace", fontWeight: 700, textDecoration: "none", letterSpacing: 0.5 }}>
                Upgrade for $10/mo →
              </a>
            </div>
          ) : error ? (
            <p style={{ color: "#ff3a3a", fontSize: 12, marginTop: 12, fontFamily: "monospace" }}>{error}</p>
          ) : null}

          {mp4Url ? (
            <a
              href={mp4Url}
              download="neuralboard.mp4"
              onClick={() => {
                if (!isSubscribed) setCanGenerate(false);
                // Non-blocking analytics only — do NOT rely on this for paywall enforcement.
                // The gate uses renderCount from /api/render/complete (server-side, source of truth).
                fetch("/api/log", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ event: "download", durationSeconds: duration }),
                }).catch(() => {});
              }}
              style={{ ...sketchButton, display: "block", marginTop: 12, background: "white", textAlign: "center", textDecoration: "none" }}
            >
              DOWNLOAD MP4
            </a>
          ) : null}
        </section>

        <section style={{ ...rightPanelStyle, pointerEvents: rendering ? "none" : "auto", opacity: rendering ? 0.6 : 1 }}>
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
              <>
                <button onClick={aiArrange} disabled={aiArranging}
                  style={{ ...miniButton, padding: "4px 10px", fontWeight: 700, opacity: aiArranging ? 0.5 : 1 }}>
                  {aiArranging ? "arranging..." : "✦ AI ARRANGE"}
                </button>
                {overlays.length > 0 && (
                  <button onClick={() => { setOverlays([]); setSelectedOverlayId(null); }}
                    style={{ ...miniButton, padding: "4px 8px" }}>
                    clear overlays
                  </button>
                )}
                <span style={{ fontSize: 9, color: "rgba(0,0,0,0.3)", fontFamily: "monospace", marginLeft: "auto" }}>
                  drag cards · click overlay to select
                </span>
              </>
            )}
          </div>

          {/* Board */}
          <div
            ref={boardRef}
            onPointerDown={(e) => { if (e.target === e.currentTarget) setSelectedOverlayId(null); }}
            onPointerMove={handleBoardPointerMove}
            onPointerUp={handleBoardPointerUp}
            onPointerCancel={handleBoardPointerUp}
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
                  ref={(el) => { if (el) cardElemsRef.current.set(i, el as HTMLDivElement); else cardElemsRef.current.delete(i); }}
                  onPointerDown={(e) => { if (!drawMode) handleBoardPointerDown(e, i); }}
                  onClick={() => setActiveBeatIdx(i)}
                  onDragStart={(e) => e.preventDefault()}
                  style={{
                    position: "absolute",
                    left: x,
                    top: y,
                    width: cardW,
                    cursor: drawMode ? "crosshair" : "grab",
                    userSelect: "none",
                    transform: `rotate(${rot * 0.4}deg)`,
                    transformOrigin: "center top",
                    zIndex: isActive ? 9999 : 1,
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
                        resizeRef.current = { idx: i, startX: e.clientX, startSize: cardW, currentSize: cardW };
                      }}
                      style={{ position: "absolute", bottom: -6, right: -6, width: 12, height: 12,
                        background: isActive ? "#c8f135" : "white", border: "1.5px solid #2a2a2a",
                        cursor: "se-resize", zIndex: 20, borderRadius: 2 }}
                    />
                  )}
                  {isActive && !drawMode && (
                    <div
                      onPointerDown={(e) => { e.stopPropagation(); deleteBeat(i); }}
                      style={{ position: "absolute", top: -8, right: -8, width: 18, height: 18,
                        background: "#ff3a3a", border: "1.5px solid #2a2a2a", borderRadius: "50%",
                        cursor: "pointer", zIndex: 21, display: "flex", alignItems: "center",
                        justifyContent: "center", color: "white", fontSize: 12, fontWeight: 700,
                        userSelect: "none" }}>×</div>
                  )}
                </div>
              );
            })}

            {/* AI overlay objects (text, arrows, circles) */}
            <svg
              ref={overlaySvgRef}
              onPointerMove={handleOverlayPointerMove}
              onPointerUp={handleOverlayPointerUp}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
                overflow: "visible", zIndex: 15, pointerEvents: "none" }}
            >
              {overlays.map((ov) => {
                const sel = ov.id === selectedOverlayId;
                if (ov.type === "text") {
                  const fh = ov.fontSize ?? 20;
                  const approxW = (ov.text?.length ?? 0) * fh * 0.55 + 8;
                  return (
                    <g key={ov.id} style={{ pointerEvents: drawMode ? "none" : "auto" }} onPointerDown={(e) => handleOverlayBodyDown(e, ov)}>
                      <rect x={ov.x - 4} y={ov.y - fh} width={approxW} height={fh + 4} fill="transparent" style={{ cursor: "move" }} />
                      <text x={ov.x} y={ov.y} fill={ov.color} fontSize={fh}
                        fontFamily="'Caveat', cursive" fontWeight="bold"
                        style={{ cursor: "move", userSelect: "none" }}>
                        {ov.text}
                      </text>
                      {sel && <>
                        <rect x={ov.x - 4} y={ov.y - fh} width={approxW} height={fh + 4}
                          fill="none" stroke="#c8f135" strokeWidth={1.5} strokeDasharray="4 2"
                          style={{ pointerEvents: "none" }} />
                        <circle cx={ov.x + approxW - 4} cy={ov.y - fh} r={7}
                          fill="#ff3a3a" stroke="white" strokeWidth={1.5} style={{ cursor: "pointer" }}
                          onPointerDown={(e) => { e.stopPropagation(); setOverlays(p => p.filter(o => o.id !== ov.id)); setSelectedOverlayId(null); }} />
                        <text x={ov.x + approxW - 4} y={ov.y - fh + 4} textAnchor="middle"
                          fill="white" fontSize={10} fontWeight="bold" style={{ pointerEvents: "none" }}>×</text>
                      </>}
                    </g>
                  );
                }
                if (ov.type === "arrow" && ov.x2 !== undefined && ov.y2 !== undefined) {
                  const mid = { x: (ov.x + ov.x2) / 2, y: (ov.y + ov.y2) / 2 };
                  return (
                    <g key={ov.id} style={{ pointerEvents: drawMode ? "none" : "auto" }}>
                      <defs>
                        <marker id={`ah-${ov.id}`} markerWidth={10} markerHeight={7} refX={9} refY={3.5} orient="auto">
                          <polygon points="0 0, 10 3.5, 0 7" fill={ov.color} />
                        </marker>
                      </defs>
                      <line x1={ov.x} y1={ov.y} x2={ov.x2} y2={ov.y2}
                        stroke="transparent" strokeWidth={16} style={{ cursor: "move" }}
                        onPointerDown={(e) => handleOverlayBodyDown(e, ov)} />
                      <line x1={ov.x} y1={ov.y} x2={ov.x2} y2={ov.y2}
                        stroke={ov.color} strokeWidth={ov.strokeWidth ?? 3}
                        markerEnd={`url(#ah-${ov.id})`} style={{ pointerEvents: "none" }} />
                      {sel && <>
                        <circle cx={ov.x} cy={ov.y} r={6} fill="white" stroke="#c8f135" strokeWidth={2}
                          style={{ cursor: "crosshair" }}
                          onPointerDown={(e) => handleOverlayEndpointDown(e, ov, "start")} />
                        <circle cx={ov.x2} cy={ov.y2} r={6} fill="white" stroke="#c8f135" strokeWidth={2}
                          style={{ cursor: "crosshair" }}
                          onPointerDown={(e) => handleOverlayEndpointDown(e, ov, "end")} />
                        <circle cx={mid.x} cy={mid.y - 14} r={7}
                          fill="#ff3a3a" stroke="white" strokeWidth={1.5} style={{ cursor: "pointer" }}
                          onPointerDown={(e) => { e.stopPropagation(); setOverlays(p => p.filter(o => o.id !== ov.id)); setSelectedOverlayId(null); }} />
                        <text x={mid.x} y={mid.y - 10} textAnchor="middle"
                          fill="white" fontSize={10} fontWeight="bold" style={{ pointerEvents: "none" }}>×</text>
                      </>}
                    </g>
                  );
                }
                if (ov.type === "circle" && ov.r !== undefined) {
                  return (
                    <g key={ov.id} style={{ pointerEvents: drawMode ? "none" : "auto" }}>
                      <circle cx={ov.x} cy={ov.y} r={ov.r} fill="none" stroke="transparent" strokeWidth={16}
                        style={{ cursor: "move" }} onPointerDown={(e) => handleOverlayBodyDown(e, ov)} />
                      <circle cx={ov.x} cy={ov.y} r={ov.r} fill="none"
                        stroke={ov.color} strokeWidth={ov.strokeWidth ?? 3} style={{ pointerEvents: "none" }} />
                      {sel && <>
                        <circle cx={ov.x + ov.r} cy={ov.y} r={6} fill="white" stroke="#c8f135" strokeWidth={2}
                          style={{ cursor: "ew-resize" }}
                          onPointerDown={(e) => handleOverlayRadiusDown(e, ov)} />
                        <circle cx={ov.x} cy={ov.y - ov.r - 14} r={7}
                          fill="#ff3a3a" stroke="white" strokeWidth={1.5} style={{ cursor: "pointer" }}
                          onPointerDown={(e) => { e.stopPropagation(); setOverlays(p => p.filter(o => o.id !== ov.id)); setSelectedOverlayId(null); }} />
                        <text x={ov.x} y={ov.y - ov.r - 10} textAnchor="middle"
                          fill="white" fontSize={10} fontWeight="bold" style={{ pointerEvents: "none" }}>×</text>
                      </>}
                    </g>
                  );
                }
                return null;
              })}
            </svg>

            {/* Drawing canvas overlay */}
            <canvas
              ref={drawCanvasRef}
              onPointerDown={handleDrawStart}
              onPointerMove={handleDrawMove}
              onPointerUp={handleDrawEnd}
              onPointerLeave={handleDrawEnd}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
                pointerEvents: drawMode ? "auto" : "none",
                cursor: drawMode ? "crosshair" : "default",
                zIndex: 30 }}
            />
          </div>
        </section>

        {/* Hidden file input for beat media upload */}
        <input ref={beatImageInputRef} type="file" accept="image/*,video/*" onChange={handleBeatMediaUpload} style={{ display: "none" }} />
      </div>

      <canvas ref={canvasRef} style={{ display: "none" }} />

      {ytModalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setYtModalOpen(false); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fffdf5', border: '2px solid #2a2a2a', boxShadow: '4px 4px 0 #2a2a2a',
            width: 640, maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column',
            fontFamily: 'monospace', overflow: 'hidden' }}>

            {/* Header */}
            <div style={{ padding: '10px 16px', borderBottom: '1.5px solid #2a2a2a', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>
                {ytView === 'search' ? '▶ YOUTUBE SEARCH' : `▶ TRIM  —  ${(ytSelected?.title ?? '').slice(0, 45)}${(ytSelected?.title?.length ?? 0) > 45 ? '…' : ''}`}
              </span>
              <button onClick={() => setYtModalOpen(false)} style={{ ...miniButton, marginLeft: 'auto', padding: '1px 7px', fontSize: 15 }}>×</button>
            </div>

            {/* Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              {ytView === 'search' ? (
                <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    <input
                      autoFocus
                      type="text"
                      value={ytQuery}
                      onChange={e => setYtQuery(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleYtSearch(); }}
                      placeholder="search youtube..."
                      style={{ flex: 1, fontFamily: 'monospace', fontSize: 13, padding: '8px 10px',
                        border: '1.5px solid #2a2a2a', background: '#fffdf5', outline: 'none', boxShadow: '2px 2px 0 #2a2a2a' }}
                    />
                    <button onClick={handleYtSearch} disabled={ytLoading}
                      style={{ ...miniButton, padding: '8px 16px', fontSize: 12, fontWeight: 700, opacity: ytLoading ? 0.5 : 1 }}>
                      {ytLoading ? '...' : 'search'}
                    </button>
                  </div>
                  {ytError && <p style={{ color: '#ff3a3a', fontSize: 11, marginBottom: 8, fontFamily: 'monospace' }}>{ytError}</p>}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                    {ytResults.map(r => (
                      <div key={r.id}
                        onClick={() => {
                          setYtSelected(r);
                          const maxSec = parseDurationSec(r.duration);
                          setYtStart(0);
                          setYtEnd(Math.min(30, maxSec));
                          setYtView('trim');
                        }}
                        style={{ border: '1.5px solid #2a2a2a', cursor: 'pointer', background: 'rgba(255,253,245,0.9)',
                          boxShadow: '2px 2px 0 #2a2a2a', overflow: 'hidden' }}>
                        {r.thumbnail && <img src={r.thumbnail} alt="" style={{ width: '100%', display: 'block', aspectRatio: '16/9', objectFit: 'cover' }} />}
                        <div style={{ padding: '5px 7px' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, lineHeight: 1.3, marginBottom: 2,
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>
                            {r.title ?? '(no title)'}
                          </div>
                          <div style={{ fontSize: 9, color: '#6a6a6a' }}>{r.channel ?? ''}{r.channel && r.duration != null ? ' · ' : ''}{r.duration != null ? (typeof r.duration === 'number' ? `${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')}` : r.duration) : ''}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {ytSelected && (
                    <div style={{ marginBottom: 14, background: '#000', lineHeight: 0 }}>
                      <iframe
                        src={`https://www.youtube.com/embed/${ytSelected.id}?start=${Math.floor(ytStart)}&end=${Math.ceil(ytEnd)}&autoplay=0`}
                        style={{ width: '100%', aspectRatio: '16/9', border: 'none' }}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                  )}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 11, width: 36 }}>start</span>
                      <input type="range" min={0} max={Math.max(0, ytEnd - 1)} step={1} value={ytStart}
                        onChange={e => setYtStart(Math.min(Number(e.target.value), ytEnd - 1))}
                        style={{ flex: 1 }} />
                      <input type="number" min={0} max={ytEnd - 1} step={1} value={ytStart}
                        onChange={e => setYtStart(Math.max(0, Math.min(Number(e.target.value), ytEnd - 1)))}
                        style={{ width: 50, fontFamily: 'monospace', fontSize: 11, border: '1px solid #2a2a2a', padding: '2px 4px', background: '#fffdf5' }} />
                      <span style={{ fontSize: 10, color: '#6a6a6a' }}>s</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, width: 36 }}>end</span>
                      <input type="range" min={ytStart + 1} max={30} step={1} value={ytEnd}
                        onChange={e => setYtEnd(Math.max(ytStart + 1, Math.min(30, Number(e.target.value))))}
                        style={{ flex: 1 }} />
                      <input type="number" min={ytStart + 1} max={30} step={1} value={ytEnd}
                        onChange={e => setYtEnd(Math.max(ytStart + 1, Math.min(30, Number(e.target.value))))}
                        style={{ width: 50, fontFamily: 'monospace', fontSize: 11, border: '1px solid #2a2a2a', padding: '2px 4px', background: '#fffdf5' }} />
                      <span style={{ fontSize: 10, color: '#6a6a6a' }}>s (max 30)</span>
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: '#6a6a6a', marginBottom: 10 }}>
                    clip: {ytEnd - ytStart}s · hard cap 30s enforced
                  </div>
                  {ytError && <p style={{ color: '#ff3a3a', fontSize: 11, fontFamily: 'monospace' }}>{ytError}</p>}
                </>
              )}
            </div>

            {/* Footer (trim view only) */}
            {ytView === 'trim' && (
              <div style={{ padding: '10px 16px', borderTop: '1.5px solid #2a2a2a', display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={() => { setYtView('search'); setYtSelected(null); setYtError(''); }}
                  style={{ ...miniButton, padding: '6px 12px', fontSize: 11 }}>
                  ← back
                </button>
                <button onClick={handleYtConfirm} disabled={ytLoading}
                  style={{ ...miniButton, marginLeft: 'auto', padding: '6px 18px', fontSize: 12, fontWeight: 700,
                    background: '#c8f135', borderColor: '#2a2a2a', opacity: ytLoading ? 0.5 : 1 }}>
                  {ytLoading ? 'downloading…' : 'confirm'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
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
    const offsetX = 0;
    const offsetY = 0;
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

function drawCardAt(ctx: CanvasRenderingContext2D, img: CanvasImageSource | null, worldX: number, worldY: number, beatIdx: number, fallbackText: string, cardWidth = 720) {
  const cardW = cardWidth;
  const cardH = Math.round(cardW * (960 / 720));
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

function parseDurationSec(dur: string | number | undefined): number {
  if (typeof dur === 'number') return dur > 0 ? dur : 30;
  if (!dur) return 30;
  const parts = dur.split(':').map(Number);
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  const asNum = Number(dur);
  return Number.isFinite(asNum) && asNum > 0 ? asNum : 30;
}

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

