"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./clips.module.css";
import { audioBufferSegmentToMonoWav, waveformPeaks } from "@/lib/audio/browser-audio";
import { mergeTranscriptionChunks, TRANSCRIPTION_CHUNK_CONTEXT_SECONDS, TRANSCRIPTION_CHUNK_SECONDS, type MergedTranscription, type TranscriptSegment, type TranscriptionChunk } from "@/lib/audio/transcription";
import { planLipSyncChunks } from "@/lib/character/lipsync";
import { saveClipBoardHandoff } from "@/lib/clip-finder/handoff";
import type { ClipSuggestion } from "@/lib/clip-finder/selection";
import { MainSectionNav } from "@/app/components/MainSectionNav";

const MAX_SOURCE_BYTES = 1536 * 1024 * 1024;
type Phase = "idle" | "preparing" | "transcribing" | "analyzing" | "done" | "error";
type ReviewClip = ClipSuggestion & { id: string; dismissed: boolean };

function formatTime(seconds: number) { const safe = Math.max(0, seconds); const m = Math.floor(safe / 60); return `${m}:${(safe % 60).toFixed(1).padStart(4, "0")}`; }
function transcriptInRange(segments: TranscriptSegment[], start: number, end: number) { return segments.filter((s) => s.end > start && s.start < end).map((s) => s.text).join(" ").replace(/\s+/g, " ").trim(); }
function fileKey(file: File) { return `${file.name}:${file.size}:${file.lastModified}`; }

async function cacheDb() {
  return new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("neuralboard-clip-transcripts", 1); request.onupgradeneeded = () => request.result.createObjectStore("transcripts"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function getCached(key: string): Promise<MergedTranscription | null> { const db = await cacheDb(); const value = await new Promise<MergedTranscription | undefined>((resolve, reject) => { const r = db.transaction("transcripts").objectStore("transcripts").get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close(); return value ?? null; }
async function putCached(key: string, value: MergedTranscription) { const db = await cacheDb(); await new Promise<void>((resolve, reject) => { const tx = db.transaction("transcripts", "readwrite"); tx.objectStore("transcripts").put(value, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close(); }

export default function ClipsPage() {
  const router = useRouter(); const inputRef = useRef<HTMLInputElement>(null); const controllerRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null); const [buffer, setBuffer] = useState<AudioBuffer | null>(null); const [transcription, setTranscription] = useState<MergedTranscription | null>(null);
  const [clips, setClips] = useState<ReviewClip[]>([]); const [phase, setPhase] = useState<Phase>("idle"); const [detail, setDetail] = useState(""); const [percent, setPercent] = useState(0); const [error, setError] = useState("");
  const [startedAt, setStartedAt] = useState(0); const [now, setNow] = useState(0); const [buildingId, setBuildingId] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const sourceUrlRef = useRef("");
  useEffect(() => { if (!startedAt || phase === "idle" || phase === "done" || phase === "error") return; const id = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [startedAt, phase]);
  useEffect(() => () => { if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current); }, []);
  const peaks = useMemo(() => buffer ? waveformPeaks(buffer) : [], [buffer]);

  async function transcribe(decoded: AudioBuffer, source: File, signal: AbortSignal) {
    const cached = await getCached(fileKey(source)); if (cached) { setDetail("Using cached transcript…"); setPercent(72); return cached; }
    const windows = planLipSyncChunks(decoded.duration, TRANSCRIPTION_CHUNK_SECONDS, TRANSCRIPTION_CHUNK_CONTEXT_SECONDS); const chunks: TranscriptionChunk[] = [];
    for (let index = 0; index < windows.length; index++) {
      signal.throwIfAborted(); setDetail(`Transcribing (chunk ${index + 1}/${windows.length})…`); setPercent(12 + 58 * index / windows.length);
      const window = windows[index]; const wav = audioBufferSegmentToMonoWav(decoded, window.audioStart, window.audioEnd - window.audioStart); const form = new FormData(); form.append("audio", wav, `podcast-${index + 1}.wav`);
      const response = await fetch("/api/board2/transcribe-audio", { method: "POST", body: form, signal }); const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `Transcription failed (${response.status})`);
      chunks.push({ window, transcript: String(data.transcript ?? ""), segments: Array.isArray(data.segments) ? data.segments : [] });
    }
    const merged = mergeTranscriptionChunks(chunks, decoded.duration); await putCached(fileKey(source), merged); return merged;
  }

  async function analyze(result: MergedTranscription, signal: AbortSignal) {
    setPhase("analyzing"); setDetail("Analyzing for clips…"); setPercent(76);
    const response = await fetch("/api/clips/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result), signal }); const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `Analysis failed (${response.status})`);
    setClips((data.clips as ClipSuggestion[]).map((clip, index) => ({ ...clip, id: `${Date.now()}-${index}`, dismissed: false }))); setPercent(100); setPhase("done"); setDetail(`Found ${data.clips.length} strong clip${data.clips.length === 1 ? "" : "s"}`);
  }

  async function handleFile(source: File) {
    if (source.size > MAX_SOURCE_BYTES) { setError("That file exceeds the 1.5 GiB Clip Finder limit."); setPhase("error"); return; }
    controllerRef.current?.abort(); const controller = new AbortController(); controllerRef.current = controller; if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current); sourceUrlRef.current = URL.createObjectURL(source); setSourceUrl(sourceUrlRef.current); setFile(source); setClips([]); setError(""); const startTime = Date.now(); setStartedAt(startTime); setNow(startTime); setPhase("preparing"); setDetail("Preparing audio…"); setPercent(3);
    try { const context = new AudioContext(); const decoded = await context.decodeAudioData(await source.arrayBuffer()); await context.close().catch(() => {}); controller.signal.throwIfAborted(); setBuffer(decoded); setPhase("transcribing"); setPercent(10); const result = await transcribe(decoded, source, controller.signal); setTranscription(result); await analyze(result, controller.signal); }
    catch (e) { if (e instanceof DOMException && e.name === "AbortError") { setPhase("idle"); setDetail("Cancelled"); } else { setError(e instanceof Error ? e.message : "Clip Finder failed"); setPhase("error"); } }
    finally { if (controllerRef.current === controller) controllerRef.current = null; }
  }

  async function reanalyze() { if (!transcription) return; const controller = new AbortController(); controllerRef.current = controller; setStartedAt(Date.now()); setError(""); try { await analyze(transcription, controller.signal); } catch (e) { setError(e instanceof Error ? e.message : "Analysis failed"); setPhase("error"); } }
  function updateClip(id: string, patch: Partial<ReviewClip>) { setClips((current) => current.map((clip) => clip.id === id ? { ...clip, ...patch } : clip)); }
  async function build(clip: ReviewClip) {
    if (!buffer || !transcription) return; setBuildingId(clip.id);
    try { const audio = audioBufferSegmentToMonoWav(buffer, clip.startTime, clip.endTime - clip.startTime); const segments = transcription.segments.filter((s) => s.end > clip.startTime && s.start < clip.endTime).map((s) => ({ start: Math.max(0, s.start - clip.startTime), end: Math.min(clip.endTime, s.end) - clip.startTime, text: s.text })); const id = crypto.randomUUID(); await saveClipBoardHandoff({ id, name: clip.title, audio, durationSec: clip.endTime - clip.startTime, transcript: transcriptInRange(transcription.segments, clip.startTime, clip.endTime), segments, createdAt: startedAt }); router.push(`/board2?clipImport=${encodeURIComponent(id)}`); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not send clip to Board 2"); setBuildingId(null); }
  }
  const active = clips.filter((clip) => !clip.dismissed); const elapsed = startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  return <main className={styles.page}><div className={styles.shell}>
    <header className={`${styles.header} main-section-page-header`}><div><h1 className={styles.title}>Clip Finder</h1><p className={styles.sub}>Upload a full podcast, find the moments that stand alone, trim them precisely, then build a Neural Board video. Audio stays in your browser except for ~60-second transcription chunks.</p></div><MainSectionNav active="clips" /></header>
    <section className={styles.drop}><input ref={inputRef} hidden type="file" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,.mp3,.wav,.m4a" onChange={(e) => { const chosen = e.target.files?.[0]; e.target.value = ""; if (chosen) void handleFile(chosen); }} /><button className={styles.button} onClick={() => inputRef.current?.click()}>Choose podcast audio</button><p>{file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : "MP3, WAV, or M4A · up to 1.5 GiB"}</p></section>
    {phase !== "idle" && <section className={styles.progress}><div className={styles.progressTop}><span>{detail || error}</span><span>{elapsed}s elapsed</span></div><div className={styles.track}><div className={styles.fill} style={{ width: `${percent}%` }} /></div><div className={styles.controls}>{(phase === "preparing" || phase === "transcribing" || phase === "analyzing") && <button className={`${styles.fine} ${styles.danger}`} onClick={() => controllerRef.current?.abort()}>Cancel</button>}{transcription && phase !== "preparing" && phase !== "transcribing" && phase !== "analyzing" && <button className={styles.fine} onClick={() => void reanalyze()}>Re-analyze cached transcript</button>}</div>{error && <p style={{color:"#a32916"}}>{error}</p>}</section>}
    <section className={styles.cards}>{active.map((clip) => <ClipCard key={clip.id} clip={clip} duration={buffer?.duration ?? 0} peaks={peaks} sourceUrl={sourceUrl} transcript={transcription?.segments ?? []} onChange={(patch) => updateClip(clip.id, patch)} onDismiss={() => updateClip(clip.id, { dismissed: true })} onBuild={() => void build(clip)} building={buildingId === clip.id} />)}</section>
    {phase === "done" && !active.length && <p className={styles.empty}>No clips remain. Re-analyze to restore suggestions.</p>}
  </div></main>;
}

function ClipCard({ clip, duration, peaks, sourceUrl, transcript, onChange, onDismiss, onBuild, building }: { clip: ReviewClip; duration: number; peaks: number[]; sourceUrl: string; transcript: TranscriptSegment[]; onChange: (patch: Partial<ReviewClip>) => void; onDismiss: () => void; onBuild: () => void; building: boolean }) {
  const start = Math.max(0, clip.startTime); const end = Math.min(duration, clip.endTime); const text = transcriptInRange(transcript, start, end);
  function setStart(value: number) { const next = Math.max(0, Math.min(end - .5, value)); onChange({ startTime: next, transcript: transcriptInRange(transcript, next, end) }); }
  function setEnd(value: number) { const next = Math.min(duration, Math.max(start + .5, value)); onChange({ endTime: next, transcript: transcriptInRange(transcript, start, next) }); }
  return <article className={styles.card}><div className={styles.cardHead}><div><h2>{clip.title}</h2><div className={styles.meta}>{formatTime(start)} – {formatTime(end)} · {(end - start).toFixed(1)}s</div></div><button className={`${styles.fine} ${styles.danger}`} onClick={onDismiss}>Dismiss</button></div><p className={styles.reason}>{clip.reason}</p>
    {sourceUrl && <audio controls src={`${sourceUrl}#t=${start},${end}`} onPlay={(e) => { if (e.currentTarget.currentTime < start || e.currentTarget.currentTime >= end) e.currentTarget.currentTime = start; }} onTimeUpdate={(e) => { if (e.currentTarget.currentTime >= end) e.currentTarget.pause(); }} style={{width:"100%"}} />}
    <div className={styles.wave}><svg preserveAspectRatio="none" viewBox={`0 0 ${Math.max(1, peaks.length)} 100`} aria-label="Podcast waveform">{peaks.map((peak, index) => <line key={index} x1={index} x2={index} y1={50-peak*45} y2={50+peak*45} stroke="#6f675d" strokeWidth="1" />)}</svg><input aria-label="Clip start" className={styles.range} type="range" min={0} max={duration} step={.1} value={start} onChange={(e) => setStart(Number(e.target.value))} /><input aria-label="Clip end" className={styles.range} type="range" min={0} max={duration} step={.1} value={end} onChange={(e) => setEnd(Number(e.target.value))} /></div>
    <div className={styles.controls}><b>Start</b><button className={styles.fine} onClick={() => setStart(start-.5)}>−0.5s</button><input className={styles.timeInput} type="number" step="0.1" value={start.toFixed(1)} onChange={(e) => setStart(Number(e.target.value))}/><button className={styles.fine} onClick={() => setStart(start+.5)}>+0.5s</button><b>End</b><button className={styles.fine} onClick={() => setEnd(end-.5)}>−0.5s</button><input className={styles.timeInput} type="number" step="0.1" value={end.toFixed(1)} onChange={(e) => setEnd(Number(e.target.value))}/><button className={styles.fine} onClick={() => setEnd(end+.5)}>+0.5s</button></div>
    <p className={styles.transcript}>{text || clip.transcript}</p><div className={styles.actions}><span>{transcript.filter((s) => s.end > start && s.start < end).length} transcript segments</span><button className={styles.button} disabled={building} onClick={onBuild}>{building ? "Sending to Board 2…" : "Build video from this clip"}</button></div></article>;
}
