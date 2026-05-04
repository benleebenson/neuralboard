"use client";

import { useState, useRef, useEffect } from "react";

type Beat = {
  startTime: number;
  endTime: number;
  searchQuery: string;
  reasoning: string;
  images?: string[];
};

const RAILWAY_URL = process.env.NEXT_PUBLIC_RAILWAY_URL || "";

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

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem("nb_pw");
    if (saved) {
      setPassword(saved);
      setAuthed(true);
    }
  }, []);

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
      setBeats(data.beats || []);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      setError(message);
    } finally {
      setProcessing(false);
    }
  }

  async function renderVideo() {
    if (!audioBlob || beats.length === 0) {
      setError("Need both audio and beats to render");
      return;
    }
    if (!RAILWAY_URL) {
      setError("Railway URL not configured");
      return;
    }
    setRendering(true);
    setError("");
    setRenderStatus("Loading images...");
    setMp4Url("");

    try {
      const images = await Promise.all(
        beats.map((b) => {
          if (!b.images || b.images.length === 0) return null;
          return loadFirstWorking(b.images);
        })
      );

      setRenderStatus("Setting up canvas...");

    // Detective-board palette
      const CORK_COLOR = "#b08964";
      const CORK_DARK = "#8a6740";
      const CARD_BORDER = "#fafafa";
      const CARD_SHADOW = "rgba(0, 0, 0, 0.4)";
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

      let prevBeatIdx = -1;
      let crossfadeStartMs = 0;
      const CROSSFADE_MS = 400;

      // ── Pre-compute card positions on the virtual corkboard ─────
      // Cards laid out horizontally with slight vertical jitter
      const N = beats.length;
      const cardSpacing = W * 1.1; // slight overlap-free spacing
      const cardCenters = beats.map((_, i) => {
        const x = i * cardSpacing + W / 2;
        // Pseudo-random vertical jitter (deterministic, stable)
        const jitterY = (((i * 73) % 200) - 100); // -100 to +100 px
        const y = H / 2 + jitterY;
        return { x, y };
      });
      const boardWidth = N * cardSpacing + W; // total scrollable width
      const boardHeight = H;

      function drawFrame() {
        const elapsedSec = (performance.now() - startMs) / 1000;
        if (Math.floor(elapsedSec) % 2 === 0 && Math.floor(elapsedSec * 10) % 10 === 0) console.log("RENDER tick: elapsed=" + elapsedSec.toFixed(1) + "s duration=" + duration);

        if (elapsedSec >= duration) {
          renderRecorder.stop();
          audioEl.pause();
          return;
        }

        // ── Determine current beat & how far into it we are ─────
        const idx = beats.findIndex(
          (b) => elapsedSec >= b.startTime && elapsedSec < b.endTime
        );
        const currentIdx = idx >= 0 ? idx : beats.length - 1;
        const currentBeat = beats[currentIdx];
        const beatProgress = currentBeat
          ? Math.min(1, Math.max(0, (elapsedSec - currentBeat.startTime) /
              (currentBeat.endTime - currentBeat.startTime)))
          : 0;

        // ── Smooth camera position: ease between previous card and current ─
        // For the first half of each beat, pan from prev card to current card.
        // For the second half, hold steady on current card.
        const prevIdx = Math.max(0, currentIdx - 1);
        const fromCenter = cardCenters[prevIdx];
        const toCenter = cardCenters[currentIdx];

        // Pan completes by the 60% mark of the beat — gives time to settle
        const panProgress = Math.min(1, beatProgress / 0.6);
        // Ease in-out cubic for smooth feel
        const eased = panProgress < 0.5
          ? 4 * panProgress * panProgress * panProgress
          : 1 - Math.pow(-2 * panProgress + 2, 3) / 2;

        const camX = fromCenter.x + (toCenter.x - fromCenter.x) * eased;
        const camY = fromCenter.y + (toCenter.y - fromCenter.y) * eased;

        // Slight zoom: zoom in slightly during second half (settled)
        const zoom = 1 + 0.05 * Math.min(1, Math.max(0, (beatProgress - 0.5) * 2));

        // ── Draw cork background, but offset by camera position ─
        ctx!.save();
        ctx!.fillStyle = CORK_COLOR;
        ctx!.fillRect(0, 0, W, H);

        // Cork grain dots — fixed pattern, scrolls with camera
        ctx!.fillStyle = CORK_DARK;
        for (let i = 0; i < 600; i++) {
          const px = (i * 137.5) % boardWidth;
          const py = (i * 89.3) % boardHeight;
          // Translate to screen coords
          const screenX = px - camX + W / 2;
          const screenY = py - camY + H / 2;
          if (screenX < -5 || screenX > W + 5 || screenY < -5 || screenY > H + 5) continue;
          const r = ((i * 7) % 3) + 0.5;
          ctx!.globalAlpha = 0.15;
          ctx!.beginPath();
          ctx!.arc(screenX, screenY, r, 0, Math.PI * 2);
          ctx!.fill();
        }
        ctx!.globalAlpha = 1;

        // ── Draw all cards positioned in world-space, transformed to screen ─
        // Set up camera transform: translate so camX/camY is at center, then zoom
        ctx!.translate(W / 2, H / 2);
        ctx!.scale(zoom, zoom);
        ctx!.translate(-camX, -camY);

        // Draw each card at its world position, but only if visible on screen
        for (let i = 0; i < beats.length; i++) {
          const center = cardCenters[i];
          const cardScreenX = (center.x - camX) * zoom + W / 2;
          // Cull cards that are way off-screen
          if (cardScreenX < -W || cardScreenX > W * 2) continue;

          const img = images[i];
          drawCardAt(
            ctx!,
            img,
            center.x,
            center.y,
            i,
            CARD_BORDER,
            CARD_SHADOW,
            beats[i].searchQuery
          );
        }

        ctx!.restore();

        // ── Progress bar (drawn after restore, in screen space) ─
        const progressY = H - 20;
        ctx!.fillStyle = "#222";
        ctx!.fillRect(0, progressY, W, 20);
        ctx!.fillStyle = "#c8f135";
        ctx!.fillRect(0, progressY, (elapsedSec / duration) * W, 20);

        requestAnimationFrame(drawFrame);
      }


      requestAnimationFrame(drawFrame);

      const webmBlob = await recordingDone;
      audioCtx.close();

      setRenderStatus("Converting to MP4 on server...");

      const mp4Res = await fetch(RAILWAY_URL + "/render", {
        method: "POST",
        headers: {
          "Content-Type": "video/webm",
          "x-neuralboard-password": password,
        },
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
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-8">
        <div className="max-w-sm w-full">
          <h1 className="text-2xl font-bold mb-2 text-center" style={{ color: "#c8f135" }}>
            Neural Board
          </h1>
          <p className="text-sm text-gray-500 mb-8 text-center">
            Private beta - enter the password.
          </p>
          <input
            type="password"
            value={pwInput}
            onChange={(e) => setPwInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleUnlock();
            }}
            placeholder="Password"
            autoFocus
            className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg text-white placeholder-gray-600 mb-3"
          />
          <button
            onClick={handleUnlock}
            className="w-full px-4 py-3 text-black font-bold rounded-lg transition"
            style={{ backgroundColor: "#c8f135" }}
          >
            Unlock
          </button>
          {pwError ? (
            <p className="text-red-400 text-xs text-center mt-3">{pwError}</p>
          ) : null}
        </div>
      </main>
    );
  }

  let recordButtonLabel = "Record";
  if (processing) recordButtonLabel = "Planning beats and finding images...";
  else if (recording) recordButtonLabel = "Stop";

  let renderButtonLabel = "Render Video";
  if (rendering) renderButtonLabel = renderStatus || "Rendering...";

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center p-8">
      <div className="max-w-3xl w-full">
        <h1 className="text-3xl font-bold mb-2 text-center mt-12" style={{ color: "#c8f135" }}>
          Neural Board - Builder
        </h1>
        <p className="text-sm text-gray-400 mb-12 text-center">
          Record a narration. Watch it become a visual plan.
        </p>

        <div className="flex justify-center mb-12">
          <button
            onClick={recording ? stopRecording : startRecording}
            disabled={processing || rendering}
            className="px-8 py-4 rounded-full text-lg font-bold transition disabled:opacity-50"
            style={{
              backgroundColor: recording ? "#ef4444" : "#c8f135",
              color: recording ? "#fff" : "#000",
            }}
          >
            {recordButtonLabel}
          </button>
        </div>

        {error ? (
          <p className="mb-8 text-red-400 text-sm text-center">{error}</p>
        ) : null}

        {transcript ? (
          <div className="mb-10">
            <h2 className="text-xs uppercase tracking-widest text-gray-500 mb-3">
              Transcript ({duration.toFixed(1)}s)
            </h2>
            <p className="text-base leading-relaxed bg-zinc-900 p-6 rounded-lg border border-zinc-800">
              {transcript}
            </p>
          </div>
        ) : null}

        {beats.length > 0 ? (
          <div className="mb-10">
            <h2 className="text-xs uppercase tracking-widest text-gray-500 mb-3">
              {beats.length} visual beats planned
            </h2>
            <div className="space-y-4">
              {beats.map((b, i) => (
                <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "#c8f135" }}>
                      Beat {i + 1}
                    </span>
                    <span className="text-gray-500 text-xs font-mono">
                      {b.startTime.toFixed(1)}s - {b.endTime.toFixed(1)}s
                    </span>
                  </div>
                  <p className="text-white text-base mb-1">{b.searchQuery}</p>
                  {b.reasoning ? (
                    <p className="text-gray-500 text-xs italic mb-3">{b.reasoning}</p>
                  ) : null}
                  {b.images && b.images.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2 mt-3">
                      {b.images.map((url, j) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={j}
                          src={url}
                          alt={b.searchQuery + " " + (j + 1)}
                          className="w-full aspect-video object-cover rounded border border-zinc-700"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-gray-600 text-xs mt-3 italic">No images found.</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {beats.length > 0 && audioBlob ? (
          <div className="mb-10 text-center">
            <button
              onClick={renderVideo}
              disabled={rendering}
              className="px-8 py-4 rounded-full text-lg font-bold transition disabled:opacity-50"
              style={{ backgroundColor: "#c8f135", color: "#000" }}
            >
              {renderButtonLabel}
            </button>
            {rendering && renderStatus ? (
              <p className="text-gray-500 text-xs mt-3">{renderStatus}</p>
            ) : null}
          </div>
        ) : null}

        {mp4Url ? (
          <div className="mb-10 text-center">
            
            <a
              href={mp4Url}
              download="neuralboard.mp4"
              className="inline-block px-8 py-4 rounded-full text-lg font-bold bg-white text-black hover:bg-gray-200 transition"
            >
              Download MP4
            </a>
            <p className="text-gray-500 text-xs mt-3">Tap to download to your device.</p>
          </div>
        ) : null}

        <canvas ref={canvasRef} style={{ display: "none" }} />
      </div>
    </main>
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image: " + url));
    img.src = url;
  });
}

async function loadFirstWorking(urls: string[]): Promise<HTMLImageElement | null> {
  for (const url of urls) {
    try {
      const img = await loadImage(url);
      return img;
    } catch {
      continue;
    }
  }
  return null;
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  W: number,
  H: number
) {
  const imgRatio = img.width / img.height;
  const canvasRatio = W / H;
  let sx = 0;
  let sy = 0;
  let sw = img.width;
  let sh = img.height;
  if (imgRatio > canvasRatio) {
    sw = img.height * canvasRatio;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / canvasRatio;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
}

function drawCardAt(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  worldX: number,
  worldY: number,
  beatIdx: number,
  borderColor: string,
  shadowColor: string,
  fallbackText: string
) {
  // Card dimensions (in world space)
  const cardW = 720;
  const cardH = 960;
  const borderW = 18;

  // Deterministic rotation per beat
  const rotation = (((beatIdx * 137) % 60) - 30) / 100; // ~ -0.3 to +0.3 rad

  ctx.save();
  ctx.translate(worldX, worldY);
  ctx.rotate(rotation * 0.4); // slight tilt

  // Drop shadow
  ctx.shadowColor = shadowColor;
  ctx.shadowBlur = 30;
  ctx.shadowOffsetX = 8;
  ctx.shadowOffsetY = 12;

  // White polaroid border
  ctx.fillStyle = borderColor;
  ctx.fillRect(-cardW / 2, -cardH / 2, cardW, cardH);

  // Reset shadow before image
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Image area
  const imgW = cardW - borderW * 2;
  const imgH = cardH - borderW * 2 - 80; // bottom strip for "label" feel
  const imgX = -cardW / 2 + borderW;
  const imgY = -cardH / 2 + borderW;

  if (img) {
    // Cover-fit
    const imgRatio = img.width / img.height;
    const slotRatio = imgW / imgH;
    let sx = 0, sy = 0, sw = img.width, sh = img.height;
    if (imgRatio > slotRatio) {
      sw = img.height * slotRatio;
      sx = (img.width - sw) / 2;
    } else {
      sh = img.width / slotRatio;
      sy = (img.height - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, imgX, imgY, imgW, imgH);
  } else {
    // Fallback: dark area with the search query
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(imgX, imgY, imgW, imgH);
    ctx.fillStyle = "#c8f135";
    ctx.font = "bold 36px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Wrap text
    const words = fallbackText.split(" ");
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if ((line + " " + word).length > 18) {
        lines.push(line);
        line = word;
      } else {
        line = line ? line + " " + word : word;
      }
    }
    if (line) lines.push(line);
    lines.forEach((ln, i) => {
      ctx.fillText(ln, imgX + imgW / 2, imgY + imgH / 2 + (i - lines.length / 2) * 44);
    });
  }

  ctx.restore();
}