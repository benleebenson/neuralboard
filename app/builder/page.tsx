"use client";

import { useState, useRef, useEffect } from "react";

type Beat = {
  startTime: number;
  endTime: number;
  searchQuery: string;
  reasoning: string;
  images?: string[];
  selectedImageIdx?: number;
};

type Background = "cork" | "beige" | "graph" | "custom";

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

  const [activeBeatIdx, setActiveBeatIdx] = useState(0);
  const [background, setBackground] = useState<Background>("cork");
  const [customBgUrl, setCustomBgUrl] = useState<string>("");
  const [draggedBeatIdx, setDraggedBeatIdx] = useState<number | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioFileInputRef = useRef<HTMLInputElement | null>(null);
  const bgFileInputRef = useRef<HTMLInputElement | null>(null);

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
      const newBeats: Beat[] = (data.beats || []).map((b: Beat) => ({
        ...b,
        selectedImageIdx: 0,
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
      const images: (HTMLImageElement | null)[] = await Promise.all(
        beats.map((b) => {
          const list = b.images || [];
          if (list.length === 0) return null;
          const startIdx = b.selectedImageIdx ?? 0;
          const reordered = [...list.slice(startIdx), ...list.slice(0, startIdx)];
          return loadFirstWorking(reordered);
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
      const cardSpacing = W * 1.1;
      const cardCenters = beats.map((_, i) => {
        const x = i * cardSpacing + W / 2;
        const jitterY = ((i * 73) % 200) - 100;
        const y = H / 2 + jitterY;
        return { x, y };
      });
      const boardWidth = N * cardSpacing + W;
      const boardHeight = H;

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
          drawCardAt(ctx!, images[i], center.x, center.y, i, beats[i].searchQuery);
        }
        ctx!.restore();

        const progressY = H - 20;
        ctx!.fillStyle = "#222";
        ctx!.fillRect(0, progressY, W, 20);
        ctx!.fillStyle = "#c8f135";
        ctx!.fillRect(0, progressY, (elapsedSec / safeDuration) * W, 20);
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
              <SectionLabel n="3" title="Beats" right={beats.length + " found / drag to reorder"} />
              {beats.map((b, i) => {
                const isActive = i === activeBeatIdx;
                const thumbUrl = b.images?.[b.selectedImageIdx ?? 0];
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
                      <div style={{ width: 60, height: 60, border: "1.5px solid #2a2a2a", flexShrink: 0, overflow: "hidden", background: "#d4d4d4" }}>
                        {thumbUrl ? (
                          <img src={thumbUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <div style={{ width: "100%", height: "100%", background: "#2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 9, padding: 4, textAlign: "center" }}>no image</div>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "monospace", color: "#2a2a2a" }}>
                            BEAT {i + 1}{isActive ? " <" : ""}
                          </span>
                          <span style={{ fontSize: 10, color: "#6a6a6a", fontFamily: "monospace" }}>
                            {b.startTime.toFixed(1)}-{b.endTime.toFixed(1)}s
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: "#2a2a2a", marginBottom: 4, fontFamily: "monospace" }}>
                          {b.searchQuery}
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={(e) => { e.stopPropagation(); cycleImage(i); }}
                            style={miniButton}
                            disabled={!b.images || b.images.length < 2}>
                            replace img ({(b.selectedImageIdx ?? 0) + 1}/{b.images?.length || 0})
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

          {beats.length > 0 && audioBlob ? (
            <button onClick={renderVideo} disabled={rendering} style={renderButtonStyle}>
              {rendering ? (renderStatus || "RENDERING...") : "RENDER VIDEO"}
            </button>
          ) : null}

          {error ? <p style={{ color: "#ff3a3a", fontSize: 12, marginTop: 12, fontFamily: "monospace" }}>{error}</p> : null}

          {mp4Url ? (
            <a href={mp4Url} download="neuralboard.mp4" style={{ ...sketchButton, display: "block", marginTop: 12, background: "white", textAlign: "center", textDecoration: "none" }}>
              DOWNLOAD MP4
            </a>
          ) : null}
        </section>

        <section style={rightPanelStyle}>
          <div style={{ fontFamily: "'Caveat', cursive", fontSize: 18, color: "#2a2a2a", fontWeight: 700, marginBottom: 12, alignSelf: "flex-start" }}>
            preview
          </div>
          <div style={previewFrameStyle(background, customBgUrl)}>
            {activeBeat ? (
              <div style={polaroidStyle(activeBeatIdx)}>
                {activeBeatImage ? (
                  <img src={activeBeatImage} alt="" style={{ width: "100%", aspectRatio: "3/4", objectFit: "cover", display: "block" }} />
                ) : (
                  <div style={{ width: "100%", aspectRatio: "3/4", background: "#2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", color: "#c8f135", fontSize: 14, fontFamily: "monospace", padding: 12, textAlign: "center" }}>
                    {activeBeat.searchQuery}
                  </div>
                )}
                <div style={{ height: 28, background: "white" }} />
                <div style={{ position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)", width: 14, height: 14, background: "#ff3a3a", border: "1px solid #2a2a2a", borderRadius: "50%" }} />
              </div>
            ) : (
              <div style={{ color: "#6a6a6a", fontFamily: "monospace", fontSize: 13, textAlign: "center", padding: 20 }}>
                record or upload audio<br/>to see your video preview
              </div>
            )}
            {beats.length > 0 ? (
              <div style={{ position: "absolute", bottom: 8, left: 8, right: 8 }}>
                <div style={{ height: 4, background: "rgba(0,0,0,0.15)", border: "1px solid #2a2a2a" }}>
                  <div style={{ width: (((activeBeatIdx + 1) / beats.length) * 100) + "%", height: "100%", background: "#c8f135" }} />
                </div>
              </div>
            ) : null}
          </div>
          {beats.length > 0 ? (
            <div style={{ marginTop: 14, fontFamily: "monospace", fontSize: 11, color: "#6a6a6a" }}>
              beat {activeBeatIdx + 1} of {beats.length}
            </div>
          ) : null}
          <div style={tipBoxStyle}>
            <span style={{ fontFamily: "'Caveat', cursive", fontSize: 16, fontWeight: 700 }}>tip:</span> click a beat to preview / drag to reorder / replace img cycles candidates
          </div>
        </section>
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

function drawCardAt(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, worldX: number, worldY: number, beatIdx: number, fallbackText: string) {
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
    const imgRatio = img.width / img.height;
    const slotRatio = imgW / imgH;
    let sx = 0, sy = 0, sw = img.width, sh = img.height;
    if (imgRatio > slotRatio) { sw = img.height * slotRatio; sx = (img.width - sw) / 2; }
    else { sh = img.width / slotRatio; sy = (img.height - sh) / 2; }
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
  padding: 24,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-start",
  paddingTop: 60,
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

function previewFrameStyle(background: Background, customBgUrl: string): React.CSSProperties {
  const bg =
    background === "cork" ? "linear-gradient(135deg, #b08964 0%, #8a6740 100%)" :
    background === "beige" ? "#e8d9b8" :
    background === "custom" && customBgUrl ? "center/cover no-repeat url(" + customBgUrl + ")" :
    "#f5f1e8";
  const isGraph = background === "graph";
  return {
    position: "relative",
    width: 320,
    aspectRatio: "9/16",
    border: "2px solid #2a2a2a",
    boxShadow: "4px 4px 0 #2a2a2a",
    background: bg,
    backgroundImage: isGraph
      ? "linear-gradient(rgba(100,130,180,.4) 1px, transparent 1px), linear-gradient(90deg, rgba(100,130,180,.4) 1px, transparent 1px)"
      : undefined,
    backgroundSize: isGraph ? "20px 20px" : undefined,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

function polaroidStyle(beatIdx: number): React.CSSProperties {
  const rot = (((beatIdx * 137) % 60) - 30) / 10;
  return {
    position: "relative",
    width: "75%",
    background: "white",
    border: "1px solid #2a2a2a",
    boxShadow: "3px 3px 0 rgba(0,0,0,0.3)",
    transform: "rotate(" + (rot * 0.3) + "deg)",
    overflow: "visible",
  };
}

const tipBoxStyle: React.CSSProperties = {
  marginTop: 20,
  padding: "10px 14px",
  background: "rgba(255,253,245,0.85)",
  border: "1.5px dashed #2a2a2a",
  maxWidth: 320,
  fontSize: 11,
  lineHeight: 1.5,
  fontFamily: "monospace",
  color: "#2a2a2a",
};
