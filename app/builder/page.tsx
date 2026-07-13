"use client";

import { useState, useRef, useEffect, Fragment } from "react";
import { useSession, signIn, signOut } from "next-auth/react";

type CameraMode = "default" | "closeup" | "pan-left" | "pan-right" | "pulse";

type Transition = {
  zoomOut: number;  // 0–1: how far to zoom out (1 = show whole board, 0.5 = halfway)
  duration: number; // seconds
};

type SubBeat = {
  id: string;
  imageUrl: string;
  appearTime: number;
  pos?: { x: number; y: number };
  compPos?: { x: number; y: number };
  size?: number;
  compSize?: number;
};

type CompRect = { x: number; y: number; w: number; h: number };

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
  subBeats?: SubBeat[];
  compMediaRect?: CompRect;
  compMediaAspect?: number;
};

type Background = "cork" | "beige" | "graph" | "custom";
type CardStyle = "card" | "bare";
type AppMode = "board" | "compilation";
type Stroke = { color: string; size: number; points: Array<{ x: number; y: number }> };

type ProposedBeat = Beat & {
  wantsVideo?: boolean;
  youtubeId?: string;
  youtubeTitle?: string;
  youtubeThumbnail?: string;
  youtubeDurationSecs?: number;
};

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

type RenderCardLayout = {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
};

type RenderBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};


type YtSearchResult = { id: string; title: string; channel: string; duration: string | number; thumbnail: string };
type YtModalView = 'search' | 'trim';

// Railway config is loaded server-side via /api/config after login
const CARD_W = 130;
const COMP_W = 1080;
const COMP_H = 1920;
// Height the "card" (Polaroid) wrapper adds around the media, in CSS px.
// border-top 1.5 + padding-top 6 + img-wrapper margin-bottom 6 + label 22 + border-bottom 1.5
// If you change the Polaroid card layout (~line 1661), update this constant too.
const CARD_STYLE_CHROME_H = 37;

function useWindowSize() {
  const [width, setWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 0
  );
  useEffect(() => {
    function update() { setWidth(window.innerWidth); }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return { isMobile: width > 0 && width < 640 };
}

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
  const [appMode, setAppMode] = useState<AppMode>("board");

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
  const [introPanStart, setIntroPanStart] = useState(0);

  const [ytModalOpen, setYtModalOpen] = useState(false);
  const [ytModalBeatIdx, setYtModalBeatIdx] = useState<number | null>(null);
  const [ytQuery, setYtQuery] = useState('');
  const [ytResults, setYtResults] = useState<YtSearchResult[]>([]);
  const [ytView, setYtView] = useState<YtModalView>('search');
  const [ytSelected, setYtSelected] = useState<YtSearchResult | null>(null);
  const [ytStart, setYtStart] = useState(0);
  const [ytStartInput, setYtStartInput] = useState("0:00");
  const [ytEnd, setYtEnd] = useState(30);
  const [ytError, setYtError] = useState('');
  const [ytLoading, setYtLoading] = useState(false);
  const [ytShortsOnly, setYtShortsOnly] = useState(true);

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
  const dragRef = useRef<{ idx: number; pointerId: number; ox: number; oy: number; startBeatX: number; startBeatY: number; currentX: number; currentY: number; pointerX: number; pointerY: number } | null>(null);
  const pendingDragRef = useRef<{ idx: number; pointerId: number; startClientX: number; startClientY: number; lastClientX: number; lastClientY: number; startBeatX: number; startBeatY: number } | null>(null);
  const cardElemsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const beatImageInputRef = useRef<HTMLInputElement | null>(null);
  const uploadBeatIdxRef = useRef<number>(-1);
  const subBeatImageInputRef = useRef<HTMLInputElement | null>(null);
  const uploadSubBeatBeatIdxRef = useRef<number>(-1);
  const subBeatDragRef = useRef<{ id: string; beatIdx: number; sbIdx: number; ox: number; oy: number; startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const compPreviewRef = useRef<HTMLDivElement | null>(null);
  const compSubBeatDragRef = useRef<{ id: string; beatIdx: number; sbIdx: number; ox: number; oy: number; startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const compSubBeatResizeRef = useRef<{ id: string; beatIdx: number; sbIdx: number; ox: number; startSize: number; currentSize: number } | null>(null);
  const compMediaDragRef = useRef<{ beatIdx: number; ox: number; oy: number; startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const compMediaResizeRef = useRef<{ beatIdx: number; ox: number; startRect: CompRect; aspect: number; currentRect: CompRect } | null>(null);
  const compPendingDragRef = useRef<{ type: 'media' | 'sub'; subIdx?: number; pointerId: number; startX: number; startY: number; lastX: number; lastY: number; startItemX: number; startItemY: number } | null>(null);
  const resizeRef = useRef<{ idx: number; startX: number; startSize: number; currentSize: number } | null>(null);

  const [directorNotes, setDirectorNotes] = useState("");
  const [directorLoading, setDirectorLoading] = useState(false);
  const [directorError, setDirectorError] = useState("");
  const [proposedBeats, setProposedBeats] = useState<ProposedBeat[] | null>(null);
  const [confirmingDirector, setConfirmingDirector] = useState(false);

  const { isMobile } = useWindowSize();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [compSelectedItem, setCompSelectedItem] = useState<'media' | number | null>(null);
  const mobileDefaultApplied = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [signInPrompt, setSignInPrompt] = useState<string | null>(null);
  const pendingSignInActionRef = useRef<"transcribe" | "director" | "render" | "arrange" | null>(null);

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
  useEffect(() => {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  useEffect(() => {
    if (isMobile && !mobileDefaultApplied.current) {
      setAppMode("compilation");
      mobileDefaultApplied.current = true;
    }
  }, [isMobile]);

  useEffect(() => {
    setCompSelectedItem(null);
    compPendingDragRef.current = null;
  }, [activeBeatIdx]);

  // Restore persisted builder state on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem("neuralboard_builder_state");
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.transcript) setTranscript(s.transcript);
      if (typeof s.duration === "number") setDuration(s.duration);
      if (Array.isArray(s.beats) && s.beats.length > 0) setBeats(s.beats);
      if (s.background) setBackground(s.background as Background);
      if (s.cardStyle) setCardStyle(s.cardStyle as CardStyle);
      if (Array.isArray(s.strokes)) setStrokes(s.strokes as Stroke[]);
      if (Array.isArray(s.overlays)) setOverlays(s.overlays as Overlay[]);
    } catch { /* corrupt/missing — start fresh */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced save — fires 500 ms after the last change to any watched state
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        // Strip blob: URLs — they don't survive page reloads
        const beatsToSave = beats.map((b) => ({
          ...b,
          customVideoUrl: b.customVideoUrl?.startsWith("blob:") ? undefined : b.customVideoUrl,
          customImageUrl: b.customImageUrl?.startsWith("blob:") ? undefined : b.customImageUrl,
        }));
        localStorage.setItem(
          "neuralboard_builder_state",
          JSON.stringify({ transcript, duration, beats: beatsToSave, background, cardStyle, strokes, overlays })
        );
      } catch { /* quota exceeded or private-browsing restriction — silently skip */ }
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [beats, transcript, duration, background, cardStyle, strokes, overlays]);

  // After a sign-in redirect, resume the action the user was trying to do
  useEffect(() => {
    if (status !== "authenticated") return;
    const pendingAction = sessionStorage.getItem("nb_pending_action");
    if (!pendingAction) return;
    sessionStorage.removeItem("nb_pending_action");
    if (pendingAction === "transcribe") {
      const audioType = sessionStorage.getItem("nb_pending_audio_type") || "audio/webm";
      const audioB64 = sessionStorage.getItem("nb_pending_audio_b64");
      sessionStorage.removeItem("nb_pending_audio_type");
      sessionStorage.removeItem("nb_pending_audio_b64");
      if (audioB64) {
        try {
          const binary = atob(audioB64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: audioType });
          setAudioBlob(blob);
          setProcessing(true);
          sendToTranscribe(blob);
        } catch { /* restore failed — user will need to re-upload */ }
      }
    } else if (pendingAction === "director") {
      const notes = sessionStorage.getItem("nb_pending_director_notes");
      sessionStorage.removeItem("nb_pending_director_notes");
      if (notes) setDirectorNotes(notes);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function handleSignInConfirm() {
    const action = pendingSignInActionRef.current;
    pendingSignInActionRef.current = null;
    setSignInPrompt(null);
    if (action === "transcribe" && audioBlob) {
      await new Promise<void>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const b64 = (reader.result as string).split(",")[1];
            if (b64) {
              sessionStorage.setItem("nb_pending_audio_type", audioBlob!.type || "audio/webm");
              sessionStorage.setItem("nb_pending_audio_b64", b64);
              sessionStorage.setItem("nb_pending_action", "transcribe");
            }
          } catch { /* sessionStorage full */ }
          resolve();
        };
        reader.onerror = () => resolve();
        reader.readAsDataURL(audioBlob!);
      });
    } else if (action === "director" && directorNotes) {
      try {
        sessionStorage.setItem("nb_pending_director_notes", directorNotes);
        sessionStorage.setItem("nb_pending_action", "director");
      } catch {}
    }
    signIn("google", { callbackUrl: "/builder" });
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
          "x-neuralboard-mode": appMode,
        },
        body: blob,
      });
      const data = await readJsonResponse<{ ok?: boolean; error?: string; transcript: string; duration: number; beats?: Beat[] }>(res);
      if (res.status === 401) {
        pendingSignInActionRef.current = "transcribe";
        setSignInPrompt("Sign in with Google to transcribe audio and generate beats.");
        setProcessing(false);
        return;
      }
      if (res.status === 403) {
        setError("You’ve used your free video. Upgrade to generate more.");
        setProcessing(false);
        return;
      }
      if (!res.ok) throw new Error(data.error || `Transcription failed (${res.status})`);
      if (!data.ok) throw new Error(data.error || "Transcription failed");
      setTranscript(data.transcript);
      setDuration(data.duration);
      setIntroPanDuration(null);
      setIntroPanStart(0);
      const sourceBeats = appMode === "compilation" ? (data.beats || []).slice(0, 5) : (data.beats || []);
      const newBeats: Beat[] = sourceBeats.map((b: Beat, i: number) => ({
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
      const panEnd = introPanDuration ?? 0;
      const segLen = (duration - panEnd) / copy.length;
      return copy.map((b, i) => clampSubBeats({
        ...b,
        startTime: panEnd + i * segLen,
        endTime: panEnd + (i + 1) * segLen,
      }));
    });
    setActiveBeatIdx(targetIdx);
    setDraggedBeatIdx(null);
  }

  function handleBoardPointerDown(e: React.PointerEvent, idx: number) {
    e.currentTarget.setPointerCapture(e.pointerId);
    e.stopPropagation();
    setActiveBeatIdx(idx);
    const beat = beats[idx];

    if (isMobile) {
      // Park in pending until the 8 px drag threshold is crossed
      pendingDragRef.current = {
        idx,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        lastClientX: e.clientX,
        lastClientY: e.clientY,
        startBeatX: beat.pos?.x ?? 0,
        startBeatY: beat.pos?.y ?? 0,
      };
    } else {
      // Desktop: start drag immediately (unchanged behaviour)
      dragRef.current = {
        idx,
        pointerId: e.pointerId,
        ox: e.clientX,
        oy: e.clientY,
        startBeatX: beat.pos?.x ?? 0,
        startBeatY: beat.pos?.y ?? 0,
        currentX: beat.pos?.x ?? 0,
        currentY: beat.pos?.y ?? 0,
        pointerX: e.clientX,
        pointerY: e.clientY,
      };
    }
  }

  function handleBoardPointerMove(e: React.PointerEvent) {
    // ── Pending tap-to-select: promote to drag once 8 px moved ──────
    // Only handle if this is the same pointer that started the pending tap.
    // If it's a different pointer (e.g. the resize handle), fall through.
    if (pendingDragRef.current && e.pointerId === pendingDragRef.current.pointerId) {
      const { idx, pointerId, startClientX, startClientY, startBeatX, startBeatY } = pendingDragRef.current;
      pendingDragRef.current.lastClientX = e.clientX;
      pendingDragRef.current.lastClientY = e.clientY;
      const dx = e.clientX - startClientX;
      const dy = e.clientY - startClientY;
      if (dx * dx + dy * dy > 64) {
        // Crossed threshold — activate drag from the original touch-down point
        const board = boardRef.current;
        const cardW = beats[idx]?.size ?? CARD_W;
        const boardRect = board?.getBoundingClientRect();
        const clampedX = boardRect ? Math.max(0, Math.min(boardRect.width - cardW, startBeatX + dx)) : startBeatX + dx;
        const clampedY = boardRect ? Math.max(0, Math.min(boardRect.height - 60, startBeatY + dy)) : startBeatY + dy;
        dragRef.current = { idx, pointerId, ox: startClientX, oy: startClientY, startBeatX, startBeatY, currentX: clampedX, currentY: clampedY, pointerX: e.clientX, pointerY: e.clientY };
        pendingDragRef.current = null;
        const el = cardElemsRef.current.get(idx);
        if (el) { el.style.left = clampedX + "px"; el.style.top = clampedY + "px"; }
      }
      return;
    }

    // ── Resize handle drag ───────────────────────────────────────────
    if (resizeRef.current) {
      const { idx, startX, startSize } = resizeRef.current;
      const newSize = Math.max(80, Math.min(400, startSize + (e.clientX - startX)));
      resizeRef.current.currentSize = newSize;
      const el = cardElemsRef.current.get(idx);
      if (el) el.style.width = newSize + "px";
      return;
    }

    // ── Active card drag ─────────────────────────────────────────────
    if (!dragRef.current) return;
    const { idx, ox, oy, startBeatX, startBeatY } = dragRef.current;
    dragRef.current.pointerX = e.clientX;
    dragRef.current.pointerY = e.clientY;
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
    // Pending tap never moved far enough — selection already set in pointerDown, just clear
    pendingDragRef.current = null;
    // Commit card drag position
    if (dragRef.current) {
      const { idx, currentX, currentY } = dragRef.current;
      setBeats(prev => prev.map((b, i) => i === idx ? { ...b, pos: { x: currentX, y: currentY } } : b));
    }
    // Commit resize
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
      if (res.status === 401) {
        pendingSignInActionRef.current = "arrange";
        setSignInPrompt("Sign in with Google to use AI Arrange.");
        return;
      }
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
      setBeats((prev) => prev.map((b, i) => i === idx ? { ...b, customVideoUrl: url, customImageUrl: undefined, compMediaRect: undefined, compMediaAspect: undefined } : b));
    } else {
      setBeats((prev) => prev.map((b, i) => i === idx ? { ...b, customImageUrl: url, customVideoUrl: undefined, compMediaRect: undefined, compMediaAspect: undefined } : b));
    }
    e.target.value = "";
  }

  async function handleSubBeatUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const beatIdx = uploadSubBeatBeatIdxRef.current;
    if (!file || beatIdx < 0) return;
    e.target.value = "";

    const url = URL.createObjectURL(file);
    let imgW = 80, imgH = 80;
    try {
      const img = await loadImage(url);
      imgW = img.naturalWidth;
      imgH = img.naturalHeight;
    } catch { /* use square fallback */ }

    const sbW = 80;
    const sbH = imgH > 0 ? Math.round(sbW * imgH / imgW) : sbW;

    setBeats(prev => {
      const beat = prev[beatIdx];
      if (!beat) return prev;

      // Compute parent card height from DOM element (exact same source of truth as Issue 4 fix)
      const parentEl = cardElemsRef.current.get(beatIdx);
      const parentW = beat.size ?? CARD_W;
      const parentH = parentEl?.offsetHeight ?? 100;
      const px = beat.pos?.x ?? (40 + (beatIdx % 3) * 160);
      const py = beat.pos?.y ?? (40 + Math.floor(beatIdx / 3) * 210);

      // Candidate slots around parent card, tried in priority order
      const slots: Array<{ x: number; y: number }> = [
        { x: px + parentW + 14, y: py + parentH / 2 - sbH / 2 },       // right
        { x: px + parentW / 2 - sbW / 2, y: py + parentH + 14 },        // below
        { x: px - sbW - 14, y: py + parentH / 2 - sbH / 2 },            // left
        { x: px + parentW / 2 - sbW / 2, y: py - sbH - 14 },            // above
        { x: px + parentW + 14, y: py + parentH + 14 },                  // below-right
        { x: px - sbW - 14, y: py + parentH + 14 },                     // below-left
      ];

      // Collect existing sub-beat rects to avoid overlap
      const occupied = (beat.subBeats ?? []).map(sb => ({
        x: sb.pos?.x ?? px + parentW + 14,
        y: sb.pos?.y ?? py,
        w: sb.size ?? 80,
        h: 80,
      }));
      // Also treat parent card as occupied
      occupied.push({ x: px, y: py, w: parentW, h: parentH });

      function overlaps(ax: number, ay: number, aw: number, ah: number) {
        return occupied.some(o =>
          ax < o.x + o.w + 8 && ax + aw + 8 > o.x &&
          ay < o.y + o.h + 8 && ay + ah + 8 > o.y
        );
      }

      const chosenSlot = slots.find(s => !overlaps(s.x, s.y, sbW, sbH)) ?? slots[0]!;

      // Re-space all sub-beat appear times evenly across the parent beat window
      const existing = beat.subBeats ?? [];
      const allSubBeats = [...existing, { id: crypto.randomUUID(), imageUrl: url, pos: chosenSlot, size: sbW, appearTime: 0 }];
      const N = allSubBeats.length;
      const dur = beat.endTime - beat.startTime;
      const respaced = allSubBeats.map((sb, k) => ({
        ...sb,
        compPos: sb.compPos ?? { x: COMP_W / 2 - 130, y: COMP_H * 0.16 },
        compSize: sb.compSize ?? 260,
        appearTime: beat.startTime + dur * (k + 1) / (N + 1),
      }));

      return prev.map((b, i) => i === beatIdx ? { ...b, subBeats: respaced } : b);
    });
  }

  function clampSubBeats(b: Beat): Beat {
    if (!b.subBeats?.length) return b;
    return {
      ...b,
      subBeats: b.subBeats.map(sb => ({
        ...sb,
        appearTime: Math.max(b.startTime, Math.min(b.endTime, sb.appearTime)),
      })),
    };
  }

  function deleteSubBeat(beatIdx: number, subBeatId: string) {
    setBeats(prev => prev.map((b, i) => {
      if (i !== beatIdx) return b;
      const remaining = (b.subBeats ?? []).filter(sb => sb.id !== subBeatId);
      return clampSubBeats({ ...b, subBeats: remaining });
    }));
  }

  function updateSubBeatAppearTime(beatIdx: number, subBeatId: string, rawVal: string) {
    const t = parseFloat(rawVal);
    if (isNaN(t)) return;
    setBeats(prev => prev.map((b, i) => {
      if (i !== beatIdx) return b;
      const clamped = Math.max(b.startTime, Math.min(b.endTime, t));
      return {
        ...b,
        subBeats: (b.subBeats ?? []).map(sb => sb.id === subBeatId ? { ...sb, appearTime: clamped } : sb),
      };
    }));
  }

  function retimeBeatsAfterPan(prev: Beat[], panDuration: number): Beat[] {
    if (prev.length === 0) return prev;
    const panEnd = Math.max(0, Math.min(duration, panDuration));
    const remaining = Math.max(0.1 * prev.length, duration - panEnd);
    const sourceStart = Math.min(...prev.map(b => b.startTime));
    const sourceEnd = Math.max(...prev.map(b => b.endTime));
    const sourceDur = Math.max(0.1, sourceEnd - sourceStart);
    let cursor = panEnd;
    return prev.map((b, i) => {
      const rawDur = Math.max(0.1, b.endTime - b.startTime);
      const scaledDur = rawDur / sourceDur * remaining;
      const isLast = i === prev.length - 1;
      const startTime = cursor;
      const endTime = isLast ? duration : Math.min(duration, cursor + scaledDur);
      cursor = endTime;
      return clampSubBeats({ ...b, startTime, endTime: Math.max(startTime + 0.1, endTime) });
    });
  }

  function setCameraPanDuration(nextDuration: number) {
    const panDuration = Math.max(0.5, Math.min(duration > 0 ? duration - 0.1 : 20, nextDuration));
    setIntroPanStart(0);
    setIntroPanDuration(panDuration);
    setBeats(prev => retimeBeatsAfterPan(prev, panDuration));
    setActiveBeatIdx(0);
  }

  function removeCameraPan() {
    setIntroPanDuration(null);
    setIntroPanStart(0);
    setBeats(prev => retimeBeatsAfterPan(prev, 0));
  }

  function commitBeatEnd(idx: number, rawVal: string) {
    const newEnd = parseFloat(rawVal);
    if (isNaN(newEnd)) { setEditingBeatIdx(null); return; }
    setBeats(prev => {
      const next = [...prev];
      const beat = next[idx];
      const clampedEnd = Math.max(beat.startTime + 0.1, Math.min(duration, newEnd));
      next[idx] = clampSubBeats({ ...beat, endTime: clampedEnd });
      // adjust next beat's startTime (it shrinks/grows to compensate)
      if (idx + 1 < next.length) {
        const nb = next[idx + 1];
        next[idx + 1] = clampSubBeats({ ...nb, startTime: clampedEnd, endTime: Math.max(clampedEnd + 0.1, nb.endTime) });
      }
      return next;
    });
    setEditingBeatIdx(null);
  }

  function deleteBeat(idx: number) {
    setBeats(prev => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) return next;
      return retimeBeatsAfterPan(next, introPanDuration ?? 0);
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
      return [...prev.slice(0, -1), clampSubBeats({ ...last, endTime: split }), newBeat];
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

  async function handleYtSearch(shortsOnlyOverride?: boolean) {
    if (!ytQuery.trim()) return;
    setYtLoading(true);
    setYtError('');
    setYtResults([]);
    try {
      const res = await fetch('/api/yt-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: ytQuery, limit: 12, shortsOnly: shortsOnlyOverride !== undefined ? shortsOnlyOverride : ytShortsOnly }),
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
    if (!ytSelected || ytModalBeatIdx === null) return;
    setYtLoading(true);
    setYtError('');
    try {
      const url = `https://www.youtube.com/watch?v=${ytSelected.id}`;
      const dlRes = await fetch('/api/ytdl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, start: ytStart, end: ytEnd }),
      });
      if (!dlRes.ok) {
        const err = await dlRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Download failed (${dlRes.status})`);
      }
      const blob = await dlRes.blob();
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
      i === beatIdx ? { ...b, selectedImageIdx: imgIdx, customImageUrl: undefined, customVideoUrl: undefined, compMediaRect: undefined, compMediaAspect: undefined } : b
    ));
  }

  function initializeCompMediaRect(beatIdx: number, srcW: number, srcH: number) {
    if (!srcW || !srcH) return;
    const naturalAspect = srcW / srcH;
    setBeats(prev => prev.map((b, i) => {
      if (i !== beatIdx) return b;
      if (!b.compMediaRect) {
        return { ...b, compMediaAspect: naturalAspect, compMediaRect: getContainRect(srcW, srcH, COMP_W, COMP_H) };
      }
      return { ...b, compMediaAspect: naturalAspect, compMediaRect: lockRectAspect(b.compMediaRect, naturalAspect) };
    }));
  }

  function updateCompMediaRect(beatIdx: number, rect: CompRect) {
    setBeats(prev => prev.map((b, i) => i === beatIdx ? { ...b, compMediaRect: lockRectAspect(rect, b.compMediaAspect) } : b));
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
    if (beats.length === 0) {
      setError("Record or upload audio first to generate beats");
      return;
    }
    if (!audioBlob) {
      setError("Audio not loaded — please re-upload your audio file to render");
      return;
    }
    if (!config?.railwayUrl) {
      pendingSignInActionRef.current = "render";
      setSignInPrompt("Sign in with Google to export your video.");
      return;
    }

    // Usage + duration gate
    const usageRes = await fetch("/api/usage/check");
    if (!usageRes.ok) {
      pendingSignInActionRef.current = "render";
      setSignInPrompt("Sign in with Google to export your video.");
      return;
    }
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
        beats.map(async (b) => {
          if (b.customImageUrl) {
            try { return await loadImage(b.customImageUrl); } catch { /* fall through */ }
          }
          const list = b.images || [];
          if (list.length === 0) return null;
          const startIdx = b.selectedImageIdx ?? 0;
          const reordered = [...list.slice(startIdx), ...list.slice(0, startIdx)];
          return loadFirstWorking(reordered);
        })
      );

      setRenderStatus("Loading custom videos...");
      const videoEls: (HTMLVideoElement | null)[] = await Promise.all(
        beats.map(b => {
          if (!b.customVideoUrl) return Promise.resolve(null);
          const vid = document.createElement('video');
          vid.src = b.customVideoUrl;
          vid.muted = true;
          vid.playsInline = true;
          return new Promise<HTMLVideoElement | null>(resolve => {
            const timer = setTimeout(() => resolve(null), 8000);
            vid.addEventListener('loadeddata', () => {
              vid.currentTime = 0;
              vid.addEventListener('seeked', () => { clearTimeout(timer); resolve(vid); }, { once: true });
            }, { once: true });
            vid.onerror = () => { clearTimeout(timer); resolve(null); };
            vid.load();
          });
        })
      );

      // Sub-beat images: Map<subBeatId, HTMLImageElement | null> per beat
      const subBeatImages: Map<string, HTMLImageElement | null>[] = await Promise.all(
        beats.map(async (b) => {
          const map = new Map<string, HTMLImageElement | null>();
          for (const sb of b.subBeats ?? []) {
            try { map.set(sb.id, await loadImage(sb.imageUrl)); }
            catch { map.set(sb.id, null); }
          }
          return map;
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

      setRenderStatus("Setting up audio...");
      const audioEl = new Audio(URL.createObjectURL(audioBlob));
      audioEl.preload = "auto";
      await new Promise<void>((res) => {
        audioEl.addEventListener("canplaythrough", () => res(), { once: true });
        audioEl.load();
      });
      const safeDuration = duration && duration > 0.5 ? duration : audioEl.duration;

      if (typeof (canvas as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream }).captureStream !== "function") {
        throw new Error("Video export requires canvas.captureStream, which is not available on this browser. Use desktop Chrome or Safari 17.2+.");
      }
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

      const recorderMime = (() => {
        const candidates = [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
          "video/mp4;codecs=avc1,mp4a.40.2", // iOS Safari
          "video/mp4",                         // iOS Safari fallback
        ];
        return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      })();

      const renderRecorder = new MediaRecorder(
        combinedStream,
        recorderMime
          ? { mimeType: recorderMime, videoBitsPerSecond: 4_000_000 }
          : { videoBitsPerSecond: 4_000_000 }
      );
      const actualMimeType = renderRecorder.mimeType || recorderMime || "video/webm";
      const renderChunks: Blob[] = [];
      renderRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) renderChunks.push(e.data);
      };

      const recordingDone = new Promise<Blob>((resolve) => {
        renderRecorder.onstop = () => {
          resolve(new Blob(renderChunks, { type: actualMimeType }));
        };
      });

      setRenderStatus(`Starting recorder [${actualMimeType || "browser default"}]...`);
      renderRecorder.start();
      audioEl.currentTime = 0;
      const startMs = performance.now();
      const cameraPanStart = Math.max(0, Math.min(safeDuration, introPanStart));
      const cameraPanEnd = Math.max(cameraPanStart, Math.min(safeDuration, cameraPanStart + (introPanDuration ?? 0)));
      try { await audioEl.play(); } catch {}

      setRenderStatus(`Recording 0s / ${safeDuration.toFixed(0)}s...`);
      let lastStatusSec = -1;

      if (appMode === "compilation") {
        let prevRenderBeatIdx = -1;
        function drawCompilationFrame() {
          const elapsedSec = (performance.now() - startMs) / 1000;
          const audioSec = Math.max(0, elapsedSec);

          const flooredSec = Math.floor(elapsedSec);
          if (flooredSec !== lastStatusSec) {
            lastStatusSec = flooredSec;
            setRenderStatus(`Recording ${flooredSec}s / ${safeDuration.toFixed(0)}s...`);
          }

          if (elapsedSec >= safeDuration) {
            renderRecorder.stop();
            audioEl.pause();
            for (const vid of videoEls) vid?.pause();
            return;
          }

          const idx = beats.findIndex((b) => audioSec >= b.startTime && audioSec < b.endTime);
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

          ctx!.fillStyle = "#000";
          ctx!.fillRect(0, 0, W, H);
          const rawVideoEl = videoEls[currentIdx];
          const mediaEl: CanvasImageSource | null = rawVideoEl
            ? (rawVideoEl.readyState >= 2 ? rawVideoEl : null)
            : images[currentIdx];
          const mediaRect = getCompMediaRect(beats[currentIdx], mediaEl, W, H);
          if (mediaEl) {
            ctx!.drawImage(mediaEl, mediaRect.x, mediaRect.y, mediaRect.w, mediaRect.h);
          } else {
            ctx!.fillStyle = "#000";
            ctx!.fillRect(0, 0, W, H);
          }

          for (const sb of beats[currentIdx]?.subBeats ?? []) {
            if (audioSec < sb.appearTime) continue;
            const sbImg = subBeatImages[currentIdx]?.get(sb.id) ?? null;
            if (!sbImg) continue;
            const elapsed = audioSec - sb.appearTime;
            const progress = Math.min(1, elapsed / 0.3);
            const size = sb.compSize ?? 260;
            const pos = sb.compPos ?? { x: W / 2 - size / 2, y: H * 0.16 };
            const h = sbImg.naturalWidth > 0 ? size * sbImg.naturalHeight / sbImg.naturalWidth : size;
            const cx = pos.x + size / 2;
            const cy = pos.y + h / 2;
            ctx!.save();
            ctx!.globalAlpha = progress;
            ctx!.translate(cx, cy);
            ctx!.scale(0.5 + 0.5 * progress, 0.5 + 0.5 * progress);
            ctx!.translate(-cx, -cy);
            ctx!.shadowColor = "rgba(0,0,0,0.45)";
            ctx!.shadowBlur = 18;
            ctx!.shadowOffsetX = 6;
            ctx!.shadowOffsetY = 8;
            ctx!.drawImage(sbImg, pos.x, pos.y, size, h);
            ctx!.restore();
          }

          requestAnimationFrame(drawCompilationFrame);
        }
        requestAnimationFrame(drawCompilationFrame);
      } else {
      // Derive camera positions from the live board layout. This keeps export camera
      // targets aligned with the board the user actually arranged.
      const boardEl = boardRef.current;
      const boardDisplayW = boardEl ? boardEl.getBoundingClientRect().width : 800;
      const boardDisplayH = boardEl ? boardEl.getBoundingClientRect().height : 600;
      const VIDEO_CARD_W = 720;
      const scale = VIDEO_CARD_W / CARD_W;
      const cardLayouts: RenderCardLayout[] = beats.map((b, i) => {
        const fallbackX = b.pos?.x ?? (40 + (i % 3) * 160);
        const fallbackY = b.pos?.y ?? (40 + Math.floor(i / 3) * 210);
        const fallbackW = b.size ?? CARD_W;
        const fallbackMedia = videoEls[i] ?? images[i];
        const fallbackMediaW = fallbackMedia instanceof HTMLVideoElement
          ? fallbackMedia.videoWidth
          : fallbackMedia instanceof HTMLImageElement
          ? fallbackMedia.naturalWidth
          : 0;
        const fallbackMediaH = fallbackMedia instanceof HTMLVideoElement
          ? fallbackMedia.videoHeight
          : fallbackMedia instanceof HTMLImageElement
          ? fallbackMedia.naturalHeight
          : 0;
        const fallbackH = fallbackMediaW > 0
          ? fallbackW * fallbackMediaH / fallbackMediaW + (cardStyle === "card" ? CARD_STYLE_CHROME_H : 0)
          : fallbackW;
        const el = cardElemsRef.current.get(i);
        const w = el?.offsetWidth || fallbackW;
        const h = el?.offsetHeight || fallbackH;
        const x = fallbackX * scale;
        const y = fallbackY * scale;
        const sw = w * scale;
        const sh = h * scale;
        return {
          x,
          y,
          w: sw,
          h: sh,
          cx: x + sw / 2,
          cy: y + sh / 2,
        };
      });
      const cardCenters = cardLayouts.map(({ cx, cy }) => ({ x: cx, y: cy }));
      const subBeatLayouts = beats.flatMap((b, i) =>
        (b.subBeats ?? []).map(sb => {
          const img = subBeatImages[i]?.get(sb.id) ?? null;
          const w = (sb.size ?? 80) * scale;
          const h = img && img.naturalWidth > 0 ? w * img.naturalHeight / img.naturalWidth : w;
          return {
            x: (sb.pos?.x ?? ((b.pos?.x ?? 40) + (b.size ?? CARD_W) + 14)) * scale,
            y: (sb.pos?.y ?? (b.pos?.y ?? 40)) * scale,
            w,
            h,
          };
        })
      );
      const visibleLayouts = [
        ...cardLayouts,
        ...subBeatLayouts,
      ];
      const boardBounds: RenderBounds = visibleLayouts.length
        ? visibleLayouts.reduce((acc, r) => ({
            minX: Math.min(acc.minX, r.x),
            minY: Math.min(acc.minY, r.y),
            maxX: Math.max(acc.maxX, r.x + r.w),
            maxY: Math.max(acc.maxY, r.y + r.h),
          }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
        : { minX: 0, minY: 0, maxX: boardDisplayW * scale, maxY: boardDisplayH * scale };
      const paddedBounds: RenderBounds = {
        minX: boardBounds.minX - 80 * scale,
        minY: boardBounds.minY - 80 * scale,
        maxX: boardBounds.maxX + 80 * scale,
        maxY: boardBounds.maxY + 80 * scale,
      };
      const boardWidth = boardDisplayW * scale + W;
      const boardHeight = boardDisplayH * scale + H;
      const boardCenterX = (paddedBounds.minX + paddedBounds.maxX) / 2;
      const boardCenterY = (paddedBounds.minY + paddedBounds.maxY) / 2;
      const sceneW = Math.max(1, paddedBounds.maxX - paddedBounds.minX);
      const sceneH = Math.max(1, paddedBounds.maxY - paddedBounds.minY);
      const cameraPanZoom = Math.max(0.22, Math.min(1, (H * 0.74) / sceneH));
      const cameraPanViewW = W / cameraPanZoom;
      const cameraPanViewH = H / cameraPanZoom;
      const cameraPanStartX = sceneW > cameraPanViewW ? paddedBounds.minX + cameraPanViewW / 2 : boardCenterX;
      const cameraPanEndX = sceneW > cameraPanViewW ? paddedBounds.maxX - cameraPanViewW / 2 : boardCenterX;
      const cameraPanY = sceneH > cameraPanViewH ? paddedBounds.minY + cameraPanViewH / 2 : boardCenterY;

      // Where the camera arrives at the start of the settle phase for a given beat
      function beatPanTarget(bidx: number): { x: number; y: number; zoom: number } {
        if (bidx < 0 || bidx >= beats.length) return { x: cardCenters[0]?.x ?? 0, y: cardCenters[0]?.y ?? 0, zoom: 1 };
        const b = beats[bidx]; const c = cardCenters[bidx]; const layout = cardLayouts[bidx];
        const bw = layout?.w ?? ((b.size ?? CARD_W) * scale);
        const m = b.cameraMode ?? "default";
        if (m === "pan-right") return { x: c.x - bw * 0.35, y: c.y, zoom: 1 };
        if (m === "pan-left") return { x: c.x + bw * 0.35, y: c.y, zoom: 1 };
        return { x: c.x, y: c.y, zoom: 1 };
      }
      // Where the camera ends up at the end of the settle phase for a given beat
      function beatEndCam(bidx: number): { x: number; y: number; zoom: number } {
        if (bidx < 0 || bidx >= beats.length) return { x: cardCenters[0]?.x ?? 0, y: cardCenters[0]?.y ?? 0, zoom: 1 };
        const b = beats[bidx]; const c = cardCenters[bidx]; const layout = cardLayouts[bidx];
        const bw = layout?.w ?? ((b.size ?? CARD_W) * scale);
        const m = b.cameraMode ?? "default";
        if (m === "pan-right") return { x: c.x + bw * 0.35, y: c.y, zoom: 1 };
        if (m === "pan-left") return { x: c.x - bw * 0.35, y: c.y, zoom: 1 };
        if (m === "closeup") return { x: c.x, y: c.y, zoom: 1.9 };
        return { x: c.x, y: c.y, zoom: 1 };
      }

      let prevRenderBeatIdx = -1;
      let wasInCameraPan = false;
      function drawFrame() {
        const elapsedSec = (performance.now() - startMs) / 1000;
        const audioSec = Math.max(0, elapsedSec);

        const flooredSec = Math.floor(elapsedSec);
        if (flooredSec !== lastStatusSec) {
          lastStatusSec = flooredSec;
          setRenderStatus(`Recording ${flooredSec}s / ${safeDuration.toFixed(0)}s...`);
        }

        if (elapsedSec >= safeDuration) {
          renderRecorder.stop();
          audioEl.pause();
          return;
        }

        let camX: number, camY: number, zoom: number;
        const inCameraPan = introPanDuration !== null && audioSec >= cameraPanStart && audioSec < cameraPanEnd && cardCenters.length > 0;

        if (inCameraPan && !wasInCameraPan) {
          for (const vid of videoEls) {
            if (!vid) continue;
            vid.currentTime = 0;
            vid.play().catch(() => {});
          }
          wasInCameraPan = true;
        } else if (!inCameraPan && wasInCameraPan) {
          for (const vid of videoEls) {
            if (!vid) continue;
            vid.pause();
            vid.currentTime = 0;
          }
          prevRenderBeatIdx = -1;
          wasInCameraPan = false;
        }

        if (inCameraPan) {
          const t = (audioSec - cameraPanStart) / Math.max(0.001, cameraPanEnd - cameraPanStart);
          const eased = 0.5 - 0.5 * Math.cos(t * Math.PI);
          camX = cameraPanStartX + (cameraPanEndX - cameraPanStartX) * eased;
          camY = cameraPanY;
          zoom = cameraPanZoom;
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

          const panHandoffSec = introPanDuration !== null && currentIdx === 0
            ? Math.min(0.8, Math.max(0.2, (currentBeat.endTime - currentBeat.startTime) * 0.35))
            : 0;
          const inPanHandoff = panHandoffSec > 0 &&
            audioSec >= currentBeat.startTime &&
            audioSec < currentBeat.startTime + panHandoffSec &&
            Math.abs(currentBeat.startTime - cameraPanEnd) < 0.05;

          if (inPanHandoff) {
            const t = Math.min(1, (audioSec - currentBeat.startTime) / panHandoffSec);
            const eased = 0.5 - 0.5 * Math.cos(t * Math.PI);
            const target = beatPanTarget(currentIdx);
            camX = cameraPanEndX + (target.x - cameraPanEndX) * eased;
            camY = cameraPanY + (target.y - cameraPanY) * eased;
            zoom = cameraPanZoom + (target.zoom - cameraPanZoom) * eased;
          } else if (transition) {
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
            const breathe = mode === "pulse" ? 0.04 * Math.sin(settleProgress * Math.PI) : 0;

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
          const layout = cardLayouts[i];
          const center = cardCenters[i];
          const cardScreenX = (center.x - camX) * zoom + W / 2;
          if (cardScreenX < -W * 1.5 || cardScreenX > W * 2.5) continue;
          const rawVideoEl = videoEls[i];
          const mediaEl: CanvasImageSource | null = rawVideoEl
            ? (rawVideoEl.readyState >= 2 ? rawVideoEl : null)
            : images[i];
          drawCardAt(ctx!, mediaEl, layout.x, layout.y, i, beats[i].searchQuery, layout.w, layout.h, cardStyle);

          // Draw sub-beats that have already appeared during this beat's window
          for (const sb of beats[i].subBeats ?? []) {
            if (audioSec < sb.appearTime) continue;
            const elapsed = audioSec - sb.appearTime;
            const progress = Math.min(1, elapsed / 0.3); // 300ms pop-in
            const alpha = progress;
            const scaleAnim = 0.5 + 0.5 * progress;
            const sbImg = subBeatImages[i]?.get(sb.id) ?? null;
            const sbW = (sb.size ?? 80) * scale;
            const sbNatH = sbImg ? sbImg.naturalHeight : sbImg === null ? 0 : 0;
            const sbNatW = sbImg ? sbImg.naturalWidth : 0;
            const sbH = sbNatW > 0 ? sbW * sbNatH / sbNatW : sbW;
            const sbPosX = sb.pos ? sb.pos.x * scale : layout.x + layout.w + 14 * scale;
            const sbPosY = sb.pos ? sb.pos.y * scale : center.y;
            const sbCx = sbPosX + sbW / 2;
            const sbCy = sbPosY + sbH / 2;
            ctx!.save();
            ctx!.globalAlpha = alpha;
            ctx!.translate(sbCx, sbCy);
            ctx!.scale(scaleAnim, scaleAnim);
            ctx!.translate(-sbCx, -sbCy);
            if (sbImg) {
              ctx!.shadowColor = "rgba(0,0,0,0.35)";
              ctx!.shadowBlur = 10 * scale;
              ctx!.shadowOffsetX = 3 * scale;
              ctx!.shadowOffsetY = 5 * scale;
              ctx!.drawImage(sbImg, sbPosX, sbPosY, sbW, sbH);
            }
            ctx!.restore();
          }
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
      }

      const webmBlob = await recordingDone;
      audioCtx.close();
      if (webmBlob.size < 1000) {
        throw new Error(`Recording produced no data (${webmBlob.size}b, codec: ${actualMimeType || "unknown"}). Try desktop Chrome or Safari 17.2+.`);
      }
      const blobKb = Math.round(webmBlob.size / 1024);
      setRenderStatus(`Uploading to server (${blobKb}kb, ${actualMimeType.split(";")[0]})...`);

      const mp4Res = await fetch(config.railwayUrl + "/render", {
        method: "POST",
        headers: { "Content-Type": actualMimeType, "x-neuralboard-password": config.railwayPassword },
        body: webmBlob,
      });
      if (!mp4Res.ok) {
        const errText = await mp4Res.text().catch(() => "");
        throw new Error("Server error " + mp4Res.status + ": " + errText);
      }
      setRenderStatus("Downloading result...");
      const mp4Blob = await mp4Res.blob();
      const url = URL.createObjectURL(mp4Blob);
      setMp4Url(url);
      setRenderStatus(`Done! (${Math.round(mp4Blob.size / 1024)}kb)`);
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

  async function applyDirectorNotes() {
    if (!directorNotes.trim() || beats.length === 0) return;
    setDirectorLoading(true);
    setDirectorError("");
    setProposedBeats(null);
    try {
      const res = await fetch("/api/director", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: directorNotes, beats }),
      });
      if (res.status === 401) {
        pendingSignInActionRef.current = "director";
        setSignInPrompt("Sign in with Google to use the Director AI.");
        return;
      }
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Director AI failed");
      setProposedBeats(data.beats);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setDirectorError(message);
    } finally {
      setDirectorLoading(false);
    }
  }

  async function confirmDirectorChanges() {
    if (!proposedBeats) return;
    setConfirmingDirector(true);
    try {
      const confirmedBeats: Beat[] = await Promise.all(
        proposedBeats.map(async (pb, i): Promise<Beat> => {
          const base: Beat = {
            startTime: pb.startTime,
            endTime: pb.endTime,
            searchQuery: pb.searchQuery,
            reasoning: pb.reasoning,
            images: pb.images,
            selectedImageIdx: pb.selectedImageIdx ?? 0,
            pos: pb.pos ?? {
              x: 40 + (i % 3) * 160 + (i * 17) % 30,
              y: 40 + Math.floor(i / 3) * 210 + (i * 31) % 40,
            },
            size: pb.size,
            customImageUrl: undefined,
            customVideoUrl: undefined,
          };

          if (pb.wantsVideo && pb.youtubeId && config?.railwayUrl) {
            try {
              const beatDuration = pb.endTime - pb.startTime;
              const clipEnd = pb.youtubeDurationSecs
                ? Math.min(beatDuration, pb.youtubeDurationSecs)
                : beatDuration;
              const dlRes = await fetch("/api/ytdl", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ youtubeId: pb.youtubeId, start: 0, end: clipEnd }),
              });
              if (dlRes.ok) {
                const blob = await dlRes.blob();
                return { ...base, customVideoUrl: URL.createObjectURL(blob) };
              }
            } catch { /* fall through to image */ }
          }

          return base;
        })
      );
      setBeats(confirmedBeats);
      setProposedBeats(null);
      setDirectorNotes("");
    } finally {
      setConfirmingDirector(false);
    }
  }

  const activeBeat = beats[activeBeatIdx];
  const activeBeatImage = activeBeat?.images?.[activeBeat.selectedImageIdx ?? 0];

  // Mobile-responsive layout styles (computed here so they can reference isMobile/previewOpen)
  const mobileSplitStyle: React.CSSProperties = isMobile
    ? { display: "block" }
    : splitStyle;

  // On mobile the sidebar is a full-width block in normal document flow — no drawer
  const mobileSidebarStyle: React.CSSProperties = isMobile
    ? {
        padding: "20px 20px",
        minHeight: "calc(100vh - 104px)",
        overflowY: "auto",
        // extra bottom padding so content clears the floating preview button
        paddingBottom: "calc(80px + env(safe-area-inset-bottom, 0px))",
        // block pointer events when the preview overlay is covering it
        pointerEvents: previewOpen ? "none" : "auto",
      }
    : leftPanelStyle;

  // On mobile the right panel is a full-screen fixed overlay, visible only when previewOpen
  const mobileRightStyle: React.CSSProperties = isMobile
    ? {
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: previewOpen ? "flex" : "none",
        flexDirection: "column",
        userSelect: "none",
      }
    : rightPanelStyle;

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: "#2a2a2a" }}>Neural Board</span>
          <span style={{ fontSize: 11, color: "#6a6a6a", letterSpacing: 1, fontFamily: "monospace" }}>/ BUILDER</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a href="/board2" style={{ fontSize: 10, fontFamily: "monospace", color: "#2a2a2a", textDecoration: "none", border: "1px solid #2a2a2a", padding: "3px 8px", borderRadius: 3, letterSpacing: 0.5 }}>Board</a>
          {session?.user ? (
            <>
              <span style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>{session.user.email}</span>
              {!isSubscribed && (
                <a href="/upgrade" style={{ fontSize: 10, fontFamily: "monospace", color: "#2a2a2a", textDecoration: "none", border: "1px solid #2a2a2a", padding: "3px 8px", borderRadius: 3, letterSpacing: 0.5 }}>
                  subscribe →
                </a>
              )}
              <button onClick={() => signOut()} style={{ ...miniButton, fontSize: 10, padding: "3px 8px" }}>sign out</button>
            </>
          ) : (
            <button onClick={() => signIn("google", { callbackUrl: "/builder" })} style={{ ...miniButton, fontSize: 10, padding: "3px 8px" }}>sign in →</button>
          )}
        </div>
      </header>

      <div style={{ display: "flex", gap: 8, padding: "10px 22px", borderBottom: "1px solid rgba(42,42,42,0.15)", background: "rgba(255,253,245,0.6)" }}>
        {(["board", "compilation"] as AppMode[]).map(mode => {
          const active = appMode === mode;
          return (
            <button key={mode}
              onClick={() => { setAppMode(mode); setDrawMode(false); }}
              style={{ ...miniButton, padding: "5px 12px", fontWeight: 700,
                background: active ? "#2a2a2a" : "transparent",
                color: active ? "#fffdf5" : "#2a2a2a" }}>
              {mode === "board" ? "board" : "compilation"}
            </button>
          );
        })}
      </div>

      <div style={mobileSplitStyle}>
        <section style={mobileSidebarStyle}>
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
                opacity: processing || rendering ? 0.5 : 1,
                minHeight: isMobile ? 44 : undefined }}>
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
              style={{ ...sketchButton, flex: 1, opacity: recording || processing || rendering ? 0.5 : 1, minHeight: isMobile ? 44 : undefined }}>
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
                {appMode === "board" && introPanDuration === null && (
                  <button
                    onClick={() => setCameraPanDuration(Math.min(3, Math.max(0.5, duration - 0.1)))}
                    style={{ ...miniButton, padding: '2px 8px', fontSize: 12 }}
                    title="Add a timed camera pan across the board">↔ pan</button>
                )}
                <button onClick={addCustomBeat} style={{ ...miniButton, fontWeight: 700, padding: '2px 8px', fontSize: 12 }} title="Add a custom beat">+</button>
              </div>
              {appMode === "board" && introPanDuration !== null && (
                <div style={{ ...beatCardStyle, background: "rgba(200,241,53,0.08)", border: "1.5px solid #c8f135", boxShadow: "2px 2px 0 #b0d020", marginBottom: 8 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <div style={{ width: 56, height: 56, border: "1.5px solid #2a2a2a", flexShrink: 0, background: "#2a2a2a",
                      display: "flex", alignItems: "center", justifyContent: "center", color: "#c8f135", fontSize: 22, fontWeight: 700 }}>
                      ↔
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace", color: "#2a2a2a" }}>CAMERA PAN</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          {audioBlob && (
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                const introEnd = Math.min(introPanStart + (introPanDuration ?? 0), duration);
                                playingBeatIdx === -1
                                  ? stopPreview()
                                  : playBeatPreview(-1, { startTime: introPanStart, endTime: introEnd, searchQuery: "camera pan", reasoning: "" });
                              }}
                              style={{ ...miniButton, padding: "0 4px", fontSize: 11, lineHeight: "14px" }}
                              title={playingBeatIdx === -1 ? "Stop preview" : "Preview intro pan audio"}>
                              {playingBeatIdx === -1 ? "⏸" : "▶"}
                            </button>
                          )}
                          <button
                            onClick={removeCameraPan}
                            style={{ ...miniButton, padding: "0 4px", color: "#ff3a3a", borderColor: "#ff3a3a", lineHeight: "14px", fontSize: 13 }}>×</button>
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace", marginBottom: 6 }}>
                        constant-zoom board pan from 0.0–{Math.min(introPanDuration, duration || introPanDuration).toFixed(1)}s
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 10, fontFamily: "monospace", color: "#2a2a2a" }}>duration</span>
                        <input
                          type="number" step="0.5" min="0.5" max="20"
                          value={introPanDuration}
                          onChange={e => setCameraPanDuration(parseFloat(e.target.value) || 3)}
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
                          <button
                            onClick={(e) => { e.stopPropagation(); setYtModalBeatIdx(i); setYtView('search'); setYtQuery(''); setYtResults([]); setYtError(''); setYtModalOpen(true); }}
                            style={{ ...miniButton, height: 22, padding: '0 5px', fontSize: 9, fontWeight: 700, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2 }}
                            title="Search YouTube">
                            ▶ yt
                          </button>
                        </div>
                        {/* Camera options */}
                        {appMode === "board" && <div style={{ marginTop: 6, borderTop: "1px dashed rgba(42,42,42,0.15)", paddingTop: 5 }}>
                          <button
                            onClick={e => { e.stopPropagation(); setExpandedBeatIdx(expandedBeatIdx === i ? null : i); }}
                            style={{ ...miniButton, fontSize: 9, padding: "2px 6px" }}>
                            {expandedBeatIdx === i ? "▴ cam" : "▾ cam"}{b.cameraMode && b.cameraMode !== "default" ? ` · ${b.cameraMode}` : ""}
                          </button>
                          {expandedBeatIdx === i && (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 5 }}>
                              {(["default", "closeup", "pan-left", "pan-right", "pulse"] as CameraMode[]).map(mode => {
                                const active = (b.cameraMode ?? "default") === mode;
                                const labels: Record<CameraMode, string> = { default: "default", closeup: "close-up", "pan-left": "pan ←", "pan-right": "pan →", pulse: "pulse" };
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
                        </div>}
                        {/* Sub-beat add button */}
                        <div style={{ marginTop: 5 }}>
                          <button
                            onClick={e => { e.stopPropagation(); uploadSubBeatBeatIdxRef.current = i; subBeatImageInputRef.current?.click(); }}
                            style={{ ...miniButton, fontSize: 9, padding: "2px 8px", opacity: 0.75 }}>
                            + sub-beat
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* Sub-beat rows — indented under parent beat */}
                  {(b.subBeats ?? []).map((sb, sbi) => (
                    <div key={sb.id} onClick={e => e.stopPropagation()}
                      style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 24, marginBottom: 4,
                        paddingLeft: 10, borderLeft: "2px solid rgba(42,42,42,0.2)",
                        background: "rgba(255,253,245,0.6)", padding: "5px 8px 5px 10px" }}>
                      <div style={{ width: 34, height: 34, flexShrink: 0, overflow: "hidden", border: "1px solid #2a2a2a" }}>
                        <img src={sb.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", fontWeight: 700 }}>
                          SUB {sbi + 1}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a" }}>at</span>
                          <input
                            type="number" step="0.1"
                            min={b.startTime.toFixed(1)} max={b.endTime.toFixed(1)}
                            value={sb.appearTime.toFixed(1)}
                            onChange={e => updateSubBeatAppearTime(i, sb.id, e.target.value)}
                            onClick={e => e.stopPropagation()}
                            style={{ width: 52, fontSize: 9, fontFamily: "monospace", border: "1px solid #2a2a2a", padding: "1px 3px", background: "#fffdf5" }}
                          />
                          <span style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a" }}>s</span>
                        </div>
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); deleteSubBeat(i, sb.id); }}
                        style={{ ...miniButton, padding: "0 4px", color: "#ff3a3a", borderColor: "#ff3a3a", lineHeight: "14px", fontSize: 12, flexShrink: 0 }}>
                        ×
                      </button>
                    </div>
                  ))}
                  {appMode === "board" && i < beats.length - 1 && (
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

          {appMode === "board" && beats.length > 0 ? (
            <>
              <SectionLabel n="4" title="Director Notes" />
              <textarea
                value={directorNotes}
                onChange={(e) => setDirectorNotes(e.target.value)}
                placeholder={'e.g. "make this 5 beats, beat 2 should be a video of UFOs lasting 12 seconds"'}
                rows={3}
                style={{ ...inputStyle, resize: "vertical", marginBottom: 8, fontSize: 12 }}
              />
              <button
                onClick={applyDirectorNotes}
                disabled={directorLoading || !directorNotes.trim()}
                style={{
                  ...sketchButton,
                  width: "100%",
                  background: directorLoading ? "#fffdf5" : "#c8f135",
                  opacity: directorLoading || !directorNotes.trim() ? 0.5 : 1,
                  marginBottom: 4,
                  fontSize: 13,
                  padding: "10px",
                }}>
                {directorLoading ? "Thinking..." : "Apply"}
              </button>
              {directorError ? (
                <p style={{ color: "#ff3a3a", fontSize: 11, fontFamily: "monospace", marginTop: 4, marginBottom: 8 }}>
                  {directorError}
                </p>
              ) : (
                <div style={{ marginBottom: 20 }} />
              )}
            </>
          ) : null}

          {appMode === "board" && beats.length > 0 ? (
            <>
              <SectionLabel n="5" title="Background" />
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

          {appMode === "board" && beats.length > 0 ? (
            <>
              <SectionLabel n="6" title="Card Style" />
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

          {beats.length > 0 ? (
            <button onClick={renderVideo} disabled={rendering} style={{ ...renderButtonStyle, minHeight: isMobile ? 44 : undefined }}>
              {rendering ? (renderStatus || "RENDERING...") : appMode === "compilation" ? "RENDER COMPILATION" : "RENDER VIDEO"}
            </button>
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
            isMobile ? (
              <div style={{ marginTop: 12 }}>
                <video
                  controls
                  playsInline
                  style={{ width: "100%", display: "block", background: "#000", maxHeight: 320 }}
                >
                  <source src={mp4Url} type="video/mp4" />
                </video>
                <div style={{ marginTop: 6, padding: "9px 12px", background: "rgba(200,241,53,0.12)", border: "1px solid #c8f135", fontSize: 11, fontFamily: "monospace", color: "#2a2a2a", lineHeight: 1.55 }}>
                  <strong>iOS Safari:</strong> tap play, then long-press the video → &quot;Save to Photos&quot;<br />
                  <strong>Android:</strong> use the download button below
                </div>
                <a
                  href={mp4Url}
                  download="neuralboard.mp4"
                  onClick={() => {
                    if (!isSubscribed) setCanGenerate(false);
                    fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "download", durationSeconds: duration }) }).catch(() => {});
                  }}
                  style={{ ...sketchButton, display: "block", marginTop: 8, background: "white", textAlign: "center", textDecoration: "none", minHeight: 44, lineHeight: "44px", padding: "0 12px" }}
                >
                  DOWNLOAD MP4
                </a>
              </div>
            ) : (
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
            )
          ) : null}
        </section>

        <section style={{ ...mobileRightStyle, pointerEvents: rendering ? "none" : "auto", opacity: rendering ? 0.6 : 1 }}>
          {isMobile && previewOpen && (
            <div style={{ background: "#0a0a0a", padding: "10px 16px", display: "flex", justifyContent: "flex-end", flexShrink: 0 }}>
              <button
                onClick={() => setPreviewOpen(false)}
                style={{ ...miniButton, color: "#c8f135", borderColor: "rgba(200,241,53,0.5)", padding: "6px 14px", fontSize: 13, fontWeight: 700, minHeight: 36 }}
              >
                ✕ close
              </button>
            </div>
          )}
          {appMode === "compilation" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, background: "#101010", padding: 18 }}>
              {beats.length > 0 && (
                <div style={{ width: "min(100%, 560px)", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(54px, 1fr))", gap: 6 }}>
                  {beats.map((beat, i) => {
                    const thumb = beat.customImageUrl ?? beat.images?.[beat.selectedImageIdx ?? 0];
                    const isActive = i === activeBeatIdx;
                    return (
                      <button
                        key={i}
                        onClick={() => setActiveBeatIdx(i)}
                        style={{ border: isActive ? "2px solid #c8f135" : "1px solid rgba(255,255,255,0.35)", background: "#181818", padding: 3, cursor: "pointer", height: 54, position: "relative" }}
                        title={`Beat ${i + 1}`}
                      >
                        {beat.customVideoUrl ? (
                          <video src={beat.customVideoUrl} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                        ) : thumb ? (
                          <img src={thumb} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                        ) : (
                          <span style={{ color: "#c8f135", fontSize: 9, fontFamily: "monospace" }}>{i + 1}</span>
                        )}
                        <span style={{ position: "absolute", left: 3, bottom: 2, color: "#fff", background: "rgba(0,0,0,0.65)", fontSize: 9, fontFamily: "monospace", padding: "0 3px" }}>
                          {i + 1}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div style={{ position: "relative", width: "min(100%, 980px)", height: isMobile ? "auto" : "min(calc(100vh - 190px), 860px)", flex: isMobile ? 1 : undefined, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "#050505", touchAction: "none" }}>
              <div
                ref={compPreviewRef}
                onPointerDown={() => { setCompSelectedItem(null); compPendingDragRef.current = null; }}
                style={{ position: "relative", aspectRatio: "9 / 16", height: "82%", maxHeight: "100%", background: "#000", overflow: "visible", boxShadow: "0 0 0 1.5px rgba(200,241,53,0.95), 0 0 0 2.5px rgba(255,255,255,0.2)", flex: "0 0 auto", touchAction: "none" }}
              >
                {activeBeat ? (() => {
                  const displayImg = activeBeat.customImageUrl ?? activeBeat.images?.[activeBeat.selectedImageIdx ?? 0];
                  if (!activeBeat.customVideoUrl && !displayImg) {
                    return (
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#c8f135", fontFamily: "monospace", fontSize: 14, padding: 20, textAlign: "center" }}>
                      {activeBeat.searchQuery}
                    </div>
                    );
                  }
                  const rect = compPreviewRef.current?.getBoundingClientRect();
                  const sx = rect ? rect.width / COMP_W : 1;
                  const sy = rect ? rect.height / COMP_H : 1;
                  const mediaRect = getCompMediaRect(activeBeat, null, COMP_W, COMP_H);
                  const cornerX = mediaRect.x + mediaRect.w;
                  const cornerY = mediaRect.y + mediaRect.h;
                  const isMediaSelected = compSelectedItem === 'media';
                  const selectionOutline = isMediaSelected ? "2px solid #c8f135" : "none";
                  const mediaStyle: React.CSSProperties = activeBeat.compMediaRect
                    ? { position: "absolute", left: mediaRect.x * sx, top: mediaRect.y * sy, width: mediaRect.w * sx, height: mediaRect.h * sy, objectFit: "fill", display: "block", cursor: "grab", userSelect: "none", zIndex: 1, outline: selectionOutline }
                    : { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: "block", cursor: "grab", userSelect: "none", zIndex: 1, outline: selectionOutline };
                  const mediaPointerDown = (e: React.PointerEvent<HTMLElement>) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setCompSelectedItem('media');
                    const target = e.currentTarget;
                    const mediaSize = target instanceof HTMLVideoElement
                      ? { w: target.videoWidth, h: target.videoHeight }
                      : { w: (target as HTMLImageElement).naturalWidth, h: (target as HTMLImageElement).naturalHeight };
                    const aspect = getMediaAspectFromSize(mediaSize.w, mediaSize.h) ?? activeBeat.compMediaAspect;
                    const startRect = lockRectAspect(activeBeat.compMediaRect ?? getContainRect(mediaSize.w, mediaSize.h, COMP_W, COMP_H), aspect);
                    if (!activeBeat.compMediaRect) updateCompMediaRect(activeBeatIdx, startRect);
                    compPendingDragRef.current = {
                      type: 'media',
                      pointerId: e.pointerId,
                      startX: e.clientX, startY: e.clientY,
                      lastX: e.clientX, lastY: e.clientY,
                      startItemX: startRect.x, startItemY: startRect.y,
                    };
                  };
                  const mediaPointerMove = (e: React.PointerEvent<HTMLElement>) => {
                    const pending = compPendingDragRef.current;
                    if (pending?.type === 'media' && e.pointerId === pending.pointerId) {
                      pending.lastX = e.clientX;
                      pending.lastY = e.clientY;
                      const dx = e.clientX - pending.startX;
                      const dy = e.clientY - pending.startY;
                      if (dx * dx + dy * dy > 64) {
                        const r = compPreviewRef.current?.getBoundingClientRect();
                        if (!r) return;
                        compMediaDragRef.current = {
                          beatIdx: activeBeatIdx,
                          ox: pending.startX, oy: pending.startY,
                          startX: pending.startItemX, startY: pending.startItemY,
                          currentX: pending.startItemX + dx / (r.width / COMP_W),
                          currentY: pending.startItemY + dy / (r.height / COMP_H),
                        };
                        compPendingDragRef.current = null;
                        const el = e.currentTarget as HTMLElement;
                        el.style.left = compMediaDragRef.current.currentX * (r.width / COMP_W) + "px";
                        el.style.top = compMediaDragRef.current.currentY * (r.height / COMP_H) + "px";
                        el.style.right = "auto";
                        el.style.bottom = "auto";
                      }
                      return;
                    }
                    const d = compMediaDragRef.current;
                    if (!d || d.beatIdx !== activeBeatIdx) return;
                    const r = compPreviewRef.current?.getBoundingClientRect();
                    if (!r) return;
                    d.currentX = d.startX + (e.clientX - d.ox) / (r.width / COMP_W);
                    d.currentY = d.startY + (e.clientY - d.oy) / (r.height / COMP_H);
                    const el = e.currentTarget as HTMLElement;
                    el.style.left = d.currentX * (r.width / COMP_W) + "px";
                    el.style.top = d.currentY * (r.height / COMP_H) + "px";
                    el.style.right = "auto";
                    el.style.bottom = "auto";
                  };
                  const mediaPointerUp = () => {
                    compPendingDragRef.current = null;
                    const d = compMediaDragRef.current;
                    if (!d || d.beatIdx !== activeBeatIdx) return;
                    const beat = beats[d.beatIdx];
                    const currentRect = getCompMediaRect(beat, null, COMP_W, COMP_H);
                    updateCompMediaRect(d.beatIdx, { ...currentRect, x: d.currentX, y: d.currentY });
                    compMediaDragRef.current = null;
                  };
                  return (
                    <>
                      {activeBeat.customVideoUrl ? (
                        <video
                          src={activeBeat.customVideoUrl}
                          muted
                          playsInline
                          autoPlay
                          loop
                          onLoadedMetadata={(e) => initializeCompMediaRect(activeBeatIdx, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                          onPointerDown={mediaPointerDown}
                          onPointerMove={mediaPointerMove}
                          onPointerUp={mediaPointerUp}
                          onPointerCancel={() => { compPendingDragRef.current = null; compMediaDragRef.current = null; }}
                          style={mediaStyle}
                        />
                      ) : (
                        <img
                          src={displayImg}
                          alt=""
                          onLoad={(e) => initializeCompMediaRect(activeBeatIdx, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
                          onPointerDown={mediaPointerDown}
                          onPointerMove={mediaPointerMove}
                          onPointerUp={mediaPointerUp}
                          onPointerCancel={() => { compPendingDragRef.current = null; compMediaDragRef.current = null; }}
                          style={mediaStyle}
                        />
                      )}
                      {isMediaSelected && (
                        <div
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            const target = e.currentTarget.parentElement?.querySelector("img,video");
                            const mediaSize = target instanceof HTMLVideoElement
                              ? { w: target.videoWidth, h: target.videoHeight }
                              : target instanceof HTMLImageElement
                              ? { w: target.naturalWidth, h: target.naturalHeight }
                              : { w: 0, h: 0 };
                            const aspect = getMediaAspectFromSize(mediaSize.w, mediaSize.h) ?? activeBeat.compMediaAspect ?? (mediaRect.w / Math.max(1, mediaRect.h));
                            const r = lockRectAspect(activeBeat.compMediaRect ?? mediaRect, aspect);
                            compMediaResizeRef.current = { beatIdx: activeBeatIdx, ox: e.clientX, startRect: r, aspect: 1 / aspect, currentRect: r };
                          }}
                          onPointerMove={(e) => {
                            const d = compMediaResizeRef.current;
                            if (!d || d.beatIdx !== activeBeatIdx) return;
                            const r = compPreviewRef.current?.getBoundingClientRect();
                            if (!r) return;
                            const nextW = Math.max(80, d.startRect.w + (e.clientX - d.ox) / (r.width / COMP_W));
                            d.currentRect = { ...d.startRect, w: nextW, h: nextW * d.aspect };
                            const el = e.currentTarget.parentElement as HTMLElement | null;
                            const media = el?.querySelector("img,video") as HTMLElement | null;
                            if (media) {
                              media.style.width = d.currentRect.w * (r.width / COMP_W) + "px";
                              media.style.height = d.currentRect.h * (r.height / COMP_H) + "px";
                            }
                            const handle = e.currentTarget as HTMLDivElement;
                            handle.style.left = Math.min(COMP_W, d.currentRect.x + d.currentRect.w) * (r.width / COMP_W) - 7 + "px";
                            handle.style.top = Math.min(COMP_H, d.currentRect.y + d.currentRect.h) * (r.height / COMP_H) - 7 + "px";
                          }}
                          onPointerUp={() => {
                            const d = compMediaResizeRef.current;
                            if (d) updateCompMediaRect(d.beatIdx, d.currentRect);
                            compMediaResizeRef.current = null;
                          }}
                          onPointerCancel={() => { compMediaResizeRef.current = null; }}
                          style={{ position: "absolute", left: Math.min(COMP_W, cornerX) * sx - 7, top: Math.min(COMP_H, cornerY) * sy - 7, width: 14, height: 14, background: "#c8f135", border: "1.5px solid #111", cursor: "se-resize", zIndex: 8, touchAction: "none" }}
                          title="Resize beat media"
                        />
                      )}
                    </>
                  );
                })() : (
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#777", fontFamily: "monospace", fontSize: 13 }}>
                    record or upload audio
                  </div>
                )}
                {(activeBeat?.subBeats ?? []).map((sb, sbIdx) => {
                  const preview = compPreviewRef.current;
                  const rect = preview?.getBoundingClientRect();
                  const sx = rect ? rect.width / 1080 : 1;
                  const sy = rect ? rect.height / 1920 : 1;
                  const size = sb.compSize ?? 260;
                  const pos = sb.compPos ?? { x: 1080 / 2 - size / 2, y: 1920 * 0.16 };
                  const isSubSelected = compSelectedItem === sbIdx;
                  return (
                    <div key={sb.id}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setCompSelectedItem(sbIdx);
                        compPendingDragRef.current = {
                          type: 'sub', subIdx: sbIdx,
                          pointerId: e.pointerId,
                          startX: e.clientX, startY: e.clientY,
                          lastX: e.clientX, lastY: e.clientY,
                          startItemX: pos.x, startItemY: pos.y,
                        };
                      }}
                      onPointerMove={(e) => {
                        const pending = compPendingDragRef.current;
                        if (pending?.type === 'sub' && pending.subIdx === sbIdx && e.pointerId === pending.pointerId) {
                          pending.lastX = e.clientX;
                          pending.lastY = e.clientY;
                          const dx = e.clientX - pending.startX;
                          const dy = e.clientY - pending.startY;
                          if (dx * dx + dy * dy > 64) {
                            const r = compPreviewRef.current?.getBoundingClientRect();
                            if (!r) return;
                            compSubBeatDragRef.current = {
                              id: sb.id, beatIdx: activeBeatIdx, sbIdx,
                              ox: pending.startX, oy: pending.startY,
                              startX: pending.startItemX, startY: pending.startItemY,
                              currentX: pending.startItemX + dx / (r.width / 1080),
                              currentY: pending.startItemY + dy / (r.height / 1920),
                            };
                            compPendingDragRef.current = null;
                            const el = e.currentTarget as HTMLDivElement;
                            el.style.left = compSubBeatDragRef.current.currentX * (r.width / 1080) + "px";
                            el.style.top = compSubBeatDragRef.current.currentY * (r.height / 1920) + "px";
                          }
                          return;
                        }
                        const d = compSubBeatDragRef.current;
                        if (!d || d.id !== sb.id) return;
                        const r = compPreviewRef.current?.getBoundingClientRect();
                        if (!r) return;
                        d.currentX = d.startX + (e.clientX - d.ox) / (r.width / 1080);
                        d.currentY = d.startY + (e.clientY - d.oy) / (r.height / 1920);
                        const el = e.currentTarget as HTMLDivElement;
                        el.style.left = d.currentX * (r.width / 1080) + "px";
                        el.style.top = d.currentY * (r.height / 1920) + "px";
                      }}
                      onPointerUp={() => {
                        compPendingDragRef.current = null;
                        const d = compSubBeatDragRef.current;
                        if (!d || d.id !== sb.id) return;
                        setBeats(prev => prev.map((beat, bi) => bi !== d.beatIdx ? beat : {
                          ...beat,
                          subBeats: (beat.subBeats ?? []).map((s, si) => si === d.sbIdx ? { ...s, compPos: { x: d.currentX, y: d.currentY } } : s),
                        }));
                        compSubBeatDragRef.current = null;
                      }}
                      onPointerCancel={() => { compPendingDragRef.current = null; compSubBeatDragRef.current = null; }}
                      style={{ position: "absolute", left: pos.x * sx, top: pos.y * sy, width: size * sx, cursor: "grab", filter: "drop-shadow(0 6px 12px rgba(0,0,0,0.45))", outline: isSubSelected ? "2px solid #c8f135" : "1px solid rgba(200,241,53,0.35)", touchAction: "none" }}
                    >
                      <img src={sb.imageUrl} alt="" style={{ width: "100%", height: "auto", display: "block", pointerEvents: "none" }} />
                      {isSubSelected && (
                        <div
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            compSubBeatResizeRef.current = { id: sb.id, beatIdx: activeBeatIdx, sbIdx, ox: e.clientX, startSize: size, currentSize: size };
                          }}
                          onPointerMove={(e) => {
                            const d = compSubBeatResizeRef.current;
                            if (!d || d.id !== sb.id) return;
                            const r = compPreviewRef.current?.getBoundingClientRect();
                            if (!r) return;
                            d.currentSize = Math.max(40, d.startSize + (e.clientX - d.ox) / (r.width / 1080));
                            const el = e.currentTarget.parentElement as HTMLDivElement | null;
                            if (el) el.style.width = d.currentSize * (r.width / 1080) + "px";
                          }}
                          onPointerUp={() => {
                            const d = compSubBeatResizeRef.current;
                            if (!d || d.id !== sb.id) return;
                            setBeats(prev => prev.map((beat, bi) => bi !== d.beatIdx ? beat : {
                              ...beat,
                              subBeats: (beat.subBeats ?? []).map((s, si) => si === d.sbIdx ? { ...s, compSize: d.currentSize } : s),
                            }));
                            compSubBeatResizeRef.current = null;
                          }}
                          onPointerCancel={() => { compSubBeatResizeRef.current = null; }}
                          style={{ position: "absolute", right: -7, bottom: -7, width: 14, height: 14, background: "#c8f135", border: "1.5px solid #111", cursor: "se-resize", touchAction: "none" }}
                          title="Resize sub-beat"
                        />
                      )}
                    </div>
                  );
                })}
                <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 7, border: "1.5px solid rgba(200,241,53,0.95)" }} />
              </div>
              </div>
            </div>
          )}
          {/* Draw toolbar */}
          <div style={{ ...drawToolbarStyle, display: appMode === "board" ? "flex" : "none" }}>
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
            style={{ ...boardStyle(background, customBgUrl), display: appMode === "board" ? undefined : "none" }}
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
                        pendingDragRef.current = null;
                        resizeRef.current = { idx: i, startX: e.clientX, startSize: cardW, currentSize: cardW };
                      }}
                      style={{
                        position: "absolute",
                        bottom: isMobile ? -14 : -6,
                        right: isMobile ? -14 : -6,
                        width: isMobile ? 28 : 12,
                        height: isMobile ? 28 : 12,
                        background: isMobile ? "rgba(255,255,255,0.88)" : (isActive ? "#c8f135" : "white"),
                        border: isMobile ? "1.5px solid rgba(42,42,42,0.35)" : "1.5px solid #2a2a2a",
                        cursor: "se-resize",
                        zIndex: 20,
                        borderRadius: isMobile ? "50%" : 2,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 13,
                        color: "#2a2a2a",
                        userSelect: "none",
                      }}
                    >
                      {isMobile ? "⤡" : ""}
                    </div>
                  )}
                  {isActive && !drawMode && (
                    <div
                      onPointerDown={(e) => { e.stopPropagation(); deleteBeat(i); }}
                      style={{
                        position: "absolute",
                        top: isMobile ? -16 : -8,
                        right: isMobile ? -16 : -8,
                        width: isMobile ? 36 : 18,
                        height: isMobile ? 36 : 18,
                        background: "#ff3a3a",
                        border: "1.5px solid #2a2a2a",
                        borderRadius: "50%",
                        cursor: "pointer",
                        zIndex: 21,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "white",
                        fontSize: isMobile ? 20 : 12,
                        fontWeight: 700,
                        userSelect: "none",
                      }}
                    >×</div>
                  )}
                </div>
              );
            })}

            {/* Sub-beat images on the board — always visible so user can nudge positions */}
            {beats.flatMap((b, i) =>
              (b.subBeats ?? []).map((sb, sbIdx) => {
                const sbW = sb.size ?? 80;
                const sbX = sb.pos?.x ?? ((b.pos?.x ?? 40) + (b.size ?? CARD_W) + 14);
                const sbY = sb.pos?.y ?? (b.pos?.y ?? 40);
                return (
                  <div
                    key={sb.id}
                    onPointerDown={(e) => {
                      if (drawMode) return;
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      subBeatDragRef.current = {
                        id: sb.id, beatIdx: i, sbIdx,
                        ox: e.clientX, oy: e.clientY,
                        startX: sbX, startY: sbY,
                        currentX: sbX, currentY: sbY,
                      };
                    }}
                    onPointerMove={(e) => {
                      const d = subBeatDragRef.current;
                      if (!d || d.id !== sb.id) return;
                      d.currentX = d.startX + (e.clientX - d.ox);
                      d.currentY = d.startY + (e.clientY - d.oy);
                      const el = e.currentTarget as HTMLDivElement;
                      el.style.left = d.currentX + "px";
                      el.style.top = d.currentY + "px";
                    }}
                    onPointerUp={() => {
                      const d = subBeatDragRef.current;
                      if (!d || d.id !== sb.id) return;
                      setBeats(prev => prev.map((beat, bi) => {
                        if (bi !== d.beatIdx) return beat;
                        return {
                          ...beat, subBeats: (beat.subBeats ?? []).map((s, si) =>
                            si === d.sbIdx ? { ...s, pos: { x: d.currentX, y: d.currentY } } : s
                          ),
                        };
                      }));
                      subBeatDragRef.current = null;
                    }}
                    onPointerCancel={() => { subBeatDragRef.current = null; }}
                    onDragStart={(e) => e.preventDefault()}
                    style={{
                      position: "absolute",
                      left: sbX,
                      top: sbY,
                      width: sbW,
                      cursor: drawMode ? "crosshair" : "grab",
                      userSelect: "none",
                      zIndex: 5,
                      filter: "drop-shadow(2px 3px 5px rgba(0,0,0,0.3))",
                      outline: "1.5px solid rgba(42,42,42,0.4)",
                    }}
                  >
                    <img src={sb.imageUrl} alt="" style={{ width: "100%", height: "auto", display: "block", pointerEvents: "none" }} />
                    <div style={{ position: "absolute", top: -6, left: -6, width: 12, height: 12,
                      background: "#2a2a2a", border: "1px solid #c8f135", borderRadius: "50%",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: "#c8f135", fontSize: 7, fontFamily: "monospace", fontWeight: 700, lineHeight: 1 }}>
                      s
                    </div>
                  </div>
                );
              })
            )}

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
        {/* Hidden file input for sub-beat image upload */}
        <input ref={subBeatImageInputRef} type="file" accept="image/*" onChange={handleSubBeatUpload} style={{ display: "none" }} />
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
                    <div style={{ display: 'flex', flexShrink: 0 }}>
                      {(['Shorts', 'Normal'] as const).map(label => {
                        const active = label === 'Shorts' ? ytShortsOnly : !ytShortsOnly;
                        return (
                          <button key={label}
                            onClick={() => { const v = label === 'Shorts'; setYtShortsOnly(v); handleYtSearch(v); }}
                            style={{ ...miniButton, fontSize: 11, padding: '4px 8px',
                              background: active ? '#2a2a2a' : 'transparent',
                              color: active ? '#fffdf5' : '#2a2a2a',
                              marginRight: label === 'Shorts' ? -1 : 0,
                              position: 'relative', zIndex: active ? 1 : 0 }}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
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
                    <button onClick={() => handleYtSearch()} disabled={ytLoading}
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
                          setYtStartInput("0:00");
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
                  {(() => {
                    const maxSec = parseDurationSec(ytSelected?.duration);
                    const clipLen = Math.max(1, Math.round(ytEnd - ytStart));
                    const maxClipLen = Math.max(1, Math.min(30, Math.floor(maxSec - ytStart)));
                    const setStartAndKeepLength = (nextStart: number) => {
                      const clampedStart = Math.max(0, Math.min(Math.max(0, maxSec - 1), nextStart));
                      const nextLen = Math.min(clipLen, Math.max(1, Math.min(30, Math.floor(maxSec - clampedStart))));
                      setYtStart(clampedStart);
                      setYtEnd(clampedStart + nextLen);
                    };
                    const setClipLen = (nextLen: number) => {
                      const clampedLen = Math.max(1, Math.min(maxClipLen, nextLen));
                      setYtEnd(ytStart + clampedLen);
                    };
                    return (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 11, width: 76 }}>source time</span>
                      <input
                        type="text"
                        value={ytStartInput}
                        placeholder="1:23"
                        onChange={e => {
                          const next = e.target.value;
                          setYtStartInput(next);
                          const parsed = parseTimestampSec(next);
                          if (parsed !== null) setStartAndKeepLength(parsed);
                        }}
                        onBlur={() => setYtStartInput(formatTimestamp(ytStart))}
                        style={{ width: 90, fontFamily: 'monospace', fontSize: 12, border: '1px solid #2a2a2a', padding: '4px 6px', background: '#fffdf5' }}
                      />
                      <span style={{ fontSize: 10, color: '#6a6a6a' }}>of {formatTimestamp(maxSec)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, width: 76 }}>clip length</span>
                      <input type="range" min={1} max={maxClipLen} step={1} value={Math.min(clipLen, maxClipLen)}
                        onChange={e => setClipLen(Number(e.target.value))}
                        style={{ flex: 1 }} />
                      <input type="number" min={1} max={maxClipLen} step={1} value={Math.min(clipLen, maxClipLen)}
                        onChange={e => setClipLen(Number(e.target.value))}
                        style={{ width: 50, fontFamily: 'monospace', fontSize: 11, border: '1px solid #2a2a2a', padding: '2px 4px', background: '#fffdf5' }} />
                      <span style={{ fontSize: 10, color: '#6a6a6a' }}>s</span>
                    </div>
                    <div style={{ fontSize: 10, color: '#6a6a6a', marginTop: 8 }}>
                      pulls {formatTimestamp(ytStart)}–{formatTimestamp(ytEnd)} · max 30s
                    </div>
                  </div>
                    );
                  })()}
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

      {proposedBeats && (
        <div style={modalOverlayStyle}>
          <div style={modalStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <span style={{ fontFamily: "'Caveat', cursive", fontSize: 24, fontWeight: 700, color: "#2a2a2a" }}>
                Proposed Changes
              </span>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "#6a6a6a" }}>
                {beats.length} beat{beats.length !== 1 ? "s" : ""} → {proposedBeats.length} beat{proposedBeats.length !== 1 ? "s" : ""}
              </span>
            </div>

            <div style={{ maxHeight: "55vh", overflowY: "auto", marginBottom: 14 }}>
              {proposedBeats.map((pb, i) => {
                const oldBeat = beats[i];
                const oldDur = oldBeat ? (oldBeat.endTime - oldBeat.startTime).toFixed(1) : "—";
                const newDur = (pb.endTime - pb.startTime).toFixed(1);
                const changed = !oldBeat || oldDur !== newDur;
                return (
                  <div key={i} style={previewBeatRowStyle}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#2a2a2a" }}>
                        BEAT {i + 1}
                      </span>
                      <span style={{ fontFamily: "monospace", fontSize: 10, color: changed ? "#ff3a3a" : "#6a6a6a" }}>
                        {oldBeat ? `${oldDur}s → ` : ""}{newDur}s
                      </span>
                    </div>
                    {pb.wantsVideo && pb.youtubeThumbnail ? (
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <img
                          src={pb.youtubeThumbnail}
                          alt=""
                          style={{ width: 80, height: 45, objectFit: "cover", border: "1px solid #2a2a2a", flexShrink: 0 }}
                        />
                        <div>
                          <div style={{ fontSize: 9, fontFamily: "monospace", fontWeight: 700, color: "#c8f135", background: "#2a2a2a", padding: "1px 5px", display: "inline-block", marginBottom: 3 }}>
                            VIDEO
                          </div>
                          <div style={{ fontSize: 10, fontFamily: "monospace", color: "#2a2a2a", lineHeight: 1.35 }}>
                            {pb.youtubeTitle}
                          </div>
                        </div>
                      </div>
                    ) : pb.wantsVideo ? (
                      <div style={{ fontSize: 10, fontFamily: "monospace", color: "#ff7a3a" }}>
                        video requested — no result found, using image
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {pb.images?.[0] && (
                          <img
                            src={pb.images[0]}
                            alt=""
                            style={{ width: 36, height: 36, objectFit: "cover", border: "1px solid rgba(42,42,42,0.3)", flexShrink: 0 }}
                          />
                        )}
                        <span style={{ fontSize: 10, fontFamily: "monospace", color: "#2a2a2a" }}>{pb.searchQuery}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={confirmDirectorChanges}
                disabled={confirmingDirector}
                style={{ ...sketchButton, flex: 1, background: "#c8f135", opacity: confirmingDirector ? 0.5 : 1 }}>
                {confirmingDirector ? "Downloading videos..." : "Confirm"}
              </button>
              <button
                onClick={() => setProposedBeats(null)}
                disabled={confirmingDirector}
                style={{ ...sketchButton, flex: 1, opacity: confirmingDirector ? 0.5 : 1 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile floating preview button — only shown when the overlay is closed */}
      {isMobile && !previewOpen && (
        <button
          onClick={() => setPreviewOpen(true)}
          style={{
            position: "fixed",
            bottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
            right: 20,
            zIndex: 300,
            background: "#c8f135",
            color: "#2a2a2a",
            border: "2px solid #2a2a2a",
            boxShadow: "3px 3px 0 #2a2a2a",
            fontFamily: "monospace",
            fontWeight: 700,
            fontSize: 13,
            padding: "10px 16px",
            cursor: "pointer",
            minHeight: 44,
            letterSpacing: 0.5,
          }}
        >
          ▶ Preview
        </button>
      )}

      {signInPrompt && (
        <div style={modalOverlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 360, textAlign: "center" }}>
            <h2 style={{ fontFamily: "'Caveat', cursive", fontSize: 30, color: "#2a2a2a", marginBottom: 6 }}>Sign in to continue</h2>
            <p style={{ fontFamily: "monospace", fontSize: 12, color: "#6a6a6a", marginBottom: 24 }}>{signInPrompt}</p>
            <button onClick={handleSignInConfirm} style={primaryButtonStyle}>
              Sign in with Google
            </button>
            <button
              onClick={() => { setSignInPrompt(null); pendingSignInActionRef.current = null; }}
              style={{ ...miniButton, marginTop: 12, display: "block", width: "100%", padding: "8px", fontSize: 11 }}>
              cancel
            </button>
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

async function readJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const fallback = text.trim() || `Request failed with status ${res.status}`;
    throw new Error(fallback.slice(0, 240));
  }
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

function getMediaSourceSize(media: CanvasImageSource | null): { w: number; h: number } {
  if (!media) return { w: 0, h: 0 };
  if (media instanceof HTMLVideoElement) return { w: media.videoWidth, h: media.videoHeight };
  const img = media as HTMLImageElement;
  return { w: img.naturalWidth || img.width || 0, h: img.naturalHeight || img.height || 0 };
}

function getMediaAspectFromSize(w: number, h: number): number | undefined {
  return w > 0 && h > 0 ? w / h : undefined;
}

function lockRectAspect(rect: CompRect, aspect?: number): CompRect {
  if (!aspect || aspect <= 0) return rect;
  const centerY = rect.y + rect.h / 2;
  const h = rect.w / aspect;
  return { ...rect, h, y: centerY - h / 2 };
}

function getContainRect(srcW: number, srcH: number, w: number, h: number): CompRect {
  if (!srcW || !srcH) return { x: 0, y: 0, w, h };
  const scale = Math.min(w / srcW, h / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  return { x: (w - drawW) / 2, y: (h - drawH) / 2, w: drawW, h: drawH };
}

function getCompMediaRect(beat: Beat | undefined, media: CanvasImageSource | null, w: number, h: number): CompRect {
  const size = getMediaSourceSize(media);
  const aspect = beat?.compMediaAspect ?? getMediaAspectFromSize(size.w, size.h);
  if (beat?.compMediaRect) return lockRectAspect(beat.compMediaRect, aspect);
  return getContainRect(size.w, size.h, w, h);
}

function drawMediaContain(ctx: CanvasRenderingContext2D, media: CanvasImageSource | null, x: number, y: number, w: number, h: number, fallbackColor = "#111") {
  if (!media) {
    ctx.fillStyle = fallbackColor;
    ctx.fillRect(x, y, w, h);
    return;
  }
  const { w: srcW, h: srcH } = getMediaSourceSize(media);
  if (!srcW || !srcH) {
    ctx.fillStyle = fallbackColor;
    ctx.fillRect(x, y, w, h);
    return;
  }
  const scale = Math.min(w / srcW, h / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  ctx.drawImage(media, x + (w - drawW) / 2, y + (h - drawH) / 2, drawW, drawH);
}

function drawCardAt(ctx: CanvasRenderingContext2D, img: CanvasImageSource | null, worldX: number, worldY: number, beatIdx: number, fallbackText: string, cardWidth = 720, cardHeight = 960, style: "card" | "bare" = "card") {
  const cardW = cardWidth;
  const cardH = cardHeight;
  const rotationDeg = ((((beatIdx * 137) % 60) - 30) / 10) * 0.4;
  const rotation = rotationDeg * Math.PI / 180;

  if (style === "bare") {
    ctx.save();
    ctx.translate(worldX + cardW / 2, worldY);
    ctx.rotate(rotation);
    ctx.translate(-cardW / 2, 0);
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = 6;
    ctx.shadowOffsetY = 10;
    if (img) {
      const srcW = img instanceof HTMLVideoElement ? img.videoWidth : (img as HTMLImageElement).naturalWidth;
      const srcH = img instanceof HTMLVideoElement ? img.videoHeight : (img as HTMLImageElement).naturalHeight;
      ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, cardW, cardH);
    } else {
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(0, 0, cardW, cardH);
    }
    ctx.restore();
    return;
  }

  const borderW = 8 * (cardW / 130);
  const labelH = 22 * (cardW / 130);
  const marginBottom = 6 * (cardW / 130);

  ctx.save();
  ctx.translate(worldX + cardW / 2, worldY);
  ctx.rotate(rotation);
  ctx.translate(-cardW / 2, 0);
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetX = 8;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, cardW, cardH);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  const imgW = cardW - borderW * 2;
  const imgH = Math.max(1, cardH - borderW * 2 - labelH - marginBottom);
  const imgX = borderW;
  const imgY = borderW;

  if (img) {
    const srcW = img instanceof HTMLVideoElement ? img.videoWidth : (img as HTMLImageElement).width;
    const srcH = img instanceof HTMLVideoElement ? img.videoHeight : (img as HTMLImageElement).height;
    ctx.drawImage(img, 0, 0, srcW, srcH, imgX, imgY, imgW, imgH);
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
  ctx.fillStyle = "#2a2a2a";
  ctx.font = `bold ${Math.max(20, 9 * (cardW / 130))}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`BEAT ${beatIdx + 1}`, cardW / 2, cardH - labelH / 2);
  ctx.fillStyle = "#ff3a3a";
  ctx.strokeStyle = "#2a2a2a";
  ctx.lineWidth = Math.max(1, 1 * (cardW / 130));
  ctx.beginPath();
  ctx.arc(cardW / 2, -6 * (cardW / 130), 5.5 * (cardW / 130), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
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

function parseTimestampSec(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':').map(part => part.trim());
  if (parts.some(part => part === '' || !/^\d+(\.\d+)?$/.test(part))) return null;
  const nums = parts.map(Number);
  if (nums.some(n => !Number.isFinite(n) || n < 0)) return null;
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return null;
}

function formatTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(42,42,42,0.72)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};

const modalStyle: React.CSSProperties = {
  background: "#fffdf5",
  border: "2px solid #2a2a2a",
  boxShadow: "4px 4px 0 #2a2a2a",
  padding: "20px 24px",
  maxWidth: 500,
  width: "100%",
  maxHeight: "85vh",
  overflowY: "auto",
};

const previewBeatRowStyle: React.CSSProperties = {
  border: "1px solid rgba(42,42,42,0.2)",
  padding: "8px 10px",
  marginBottom: 6,
  background: "rgba(255,253,245,0.6)",
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
