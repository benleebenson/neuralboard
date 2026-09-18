"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BOARD_LIBRARY_PENDING_FILE, type BoardLibraryEntry, getBoardsDirectory, listBoards, supportsBoardDirectory, updateTrainingFlag } from "@/lib/board-library";
import { MainSectionNav } from "@/app/components/MainSectionNav";

type CloudAsset = { id: string; url: string; thumbnail_url?: string; label?: string; description?: string; is_intro?: boolean; created_at?: string };
type Candidate = { dataUrl: string; sourceUrl: string; width: number; height: number; source: string };

function formatDuration(seconds: number): string { const rounded = Math.max(0, Math.round(seconds)); return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`; }

export default function BoardLibraryPage() {
  const [tab, setTab] = useState<"boards" | "assets">("boards");
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null);
  const [boards, setBoards] = useState<BoardLibraryEntry[]>([]);
  const [trainingOnly, setTrainingOnly] = useState(false);
  const [assets, setAssets] = useState<CloudAsset[]>([]);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [topic, setTopic] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [discovering, setDiscovering] = useState(false);
  const dragStart = useRef<number | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const refreshBoards = useCallback(async (handle: FileSystemDirectoryHandle) => { setBusy(true); try { setBoards(await listBoards(handle)); setMessage(""); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not read the boards folder."); } finally { setBusy(false); } }, []);
  const refreshAssets = useCallback(async () => { setBusy(true); try { const response = await fetch("/api/board2/assets?type=image", { cache: "no-store" }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not load assets"); setAssets(data.assets ?? []); setMessage(""); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not load assets."); } finally { setBusy(false); } }, []);
  const chooseFolder = useCallback(async () => { try { const handle = await getBoardsDirectory({ prompt: true, write: true }); setDirectory(handle); if (handle) await refreshBoards(handle); } catch (error) { if ((error as DOMException)?.name !== "AbortError") setMessage(error instanceof Error ? error.message : "Folder access failed."); setBusy(false); } }, [refreshBoards]);

  useEffect(() => { void (async () => { try { const handle = await getBoardsDirectory({ prompt: false, write: true }); setDirectory(handle); if (handle) await refreshBoards(handle); else setBusy(false); } catch { setBusy(false); } })(); }, [refreshBoards]);

  const visibleBoards = useMemo(() => trainingOnly ? boards.filter((board) => board.meta.trainingExample) : boards, [boards, trainingOnly]);
  const uploadAsset = async (file: File, source = "manual") => { const form = new FormData(); form.set("file", file); form.set("label", file.name); form.set("source", source); const response = await fetch("/api/board2/assets", { method: "POST", body: form }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Upload failed"); await refreshAssets(); };
  const searchCandidates = async () => { if (!topic.trim()) return; setDiscovering(true); setMessage(""); try { const response = await fetch("/api/board2/find-images", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: topic.trim(), count: 3 }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Image search failed"); setCandidates(data.images ?? []); setCandidateIndex(0); } catch (error) { setMessage(error instanceof Error ? error.message : "Image search failed"); } finally { setDiscovering(false); } };
  const swipe = async (keep: boolean) => { const candidate = candidates[candidateIndex]; if (!candidate) return; if (keep) { const blob = await fetch(candidate.dataUrl).then((response) => response.blob()); await uploadAsset(new File([blob], `${topic || "curated"}.webp`, { type: blob.type || "image/webp" }), "mobile-curation"); } setCandidateIndex((index) => index + 1); };
  const currentCandidate = candidates[candidateIndex];

  return <main style={{ minHeight: "100vh", background: "#fffdf5", color: "#2a2a2a", padding: "28px clamp(18px, 4vw, 56px)", fontFamily: "monospace" }}>
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 20 }}><div><div style={{ fontSize: 11, letterSpacing: 2, color: "#777" }}>NEURALBOARD</div><h1 style={{ margin: "5px 0 0", fontFamily: "Georgia, serif", fontSize: 34 }}>Library</h1></div><MainSectionNav active="library" /></header>
    <nav style={{ display: "flex", gap: 8, marginBottom: 22 }}><button onClick={() => setTab("boards")} style={{ ...filterStyle, background: tab === "boards" ? "#2a2a2a" : "white", color: tab === "boards" ? "white" : "#2a2a2a" }}>Boards</button><button onClick={() => { setTab("assets"); void refreshAssets(); }} style={{ ...filterStyle, background: tab === "assets" ? "#2a2a2a" : "white", color: tab === "assets" ? "white" : "#2a2a2a" }}>Assets</button></nav>
    {message && <p style={{ color: "#b42318" }}>{message}</p>}
    {tab === "boards" ? <>
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}><button onClick={chooseFolder} style={{ ...buttonStyle, background: "#c8f135" }}>{directory ? "Change folder" : "Choose boards folder"}</button><button onClick={() => setTrainingOnly(false)} style={filterStyle}>All ({boards.length})</button><button onClick={() => setTrainingOnly(true)} style={filterStyle}>⭐ Training ({boards.filter((board) => board.meta.trainingExample).length})</button></div>
      {!supportsBoardDirectory() || !directory ? <section style={emptyStyle}>Choose a local boards folder to see `.nbp` projects.</section> : <div style={gridStyle}>{visibleBoards.map((entry) => <article key={entry.fileName} style={cardStyle}><button onClick={() => { sessionStorage.setItem(BOARD_LIBRARY_PENDING_FILE, entry.fileName); location.assign("/board2"); }} style={imageButtonStyle}>{entry.thumbnailDataUri ? <Image src={entry.thumbnailDataUri} alt="" fill unoptimized style={{ objectFit: "cover" }} /> : "▧"}</button><div style={{ padding: 14 }}><b style={{ fontFamily: "Georgia, serif" }}>{entry.meta.title}</b><div style={{ color: "#777", fontSize: 11, margin: "7px 0" }}>{formatDuration(entry.meta.duration)}</div><label><input type="checkbox" checked={entry.meta.trainingExample} onChange={async () => { await updateTrainingFlag(directory, entry, !entry.meta.trainingExample); await refreshBoards(directory); }} /> ⭐ Training example</label><button onClick={async () => { if (confirm(`Delete “${entry.meta.title}”?`)) { await directory.removeEntry(entry.fileName); await refreshBoards(directory); } }} style={deleteStyle}>Delete</button></div></article>)}</div>}
    </> : <>
      <section style={{ border: "2px solid #2a2a2a", padding: 14, background: "white", marginBottom: 20 }}><h2 style={{ margin: "0 0 10px", font: "700 18px Georgia,serif" }}>Swipe to curate</h2><div style={{ display: "flex", gap: 8 }}><input value={topic} onChange={(event) => setTopic(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchCandidates(); }} placeholder="Topic: lucid dreaming, Carl Jung…" style={{ flex: 1, minWidth: 0, padding: 10, border: "1.5px solid #2a2a2a" }} /><button onClick={() => void searchCandidates()} disabled={discovering} style={{ ...buttonStyle, background: "#c8f135" }}>{discovering ? "Finding…" : "Find images"}</button><button onClick={() => uploadRef.current?.click()} style={buttonStyle}>Camera roll</button><input ref={uploadRef} hidden type="file" accept="image/*" multiple onChange={(event) => { void Promise.all([...event.target.files ?? []].map((file) => uploadAsset(file))); event.target.value = ""; }} /></div>
      {currentCandidate && <div onPointerDown={(event) => { dragStart.current = event.clientX; }} onPointerUp={(event) => { if (dragStart.current == null) return; const delta = event.clientX - dragStart.current; dragStart.current = null; if (Math.abs(delta) > 50) void swipe(delta > 0); }} style={{ margin: "16px auto 0", maxWidth: 520, touchAction: "pan-y" }}><div style={{ position: "relative", height: "min(58vh, 560px)", background: "#111", border: "2px solid #2a2a2a" }}><Image src={currentCandidate.dataUrl} alt={topic} fill unoptimized style={{ objectFit: "contain" }} /></div><div style={{ display: "flex", gap: 10, marginTop: 10 }}><button onClick={() => void swipe(false)} style={{ ...buttonStyle, flex: 1, background: "#ffd3cc" }}>← Discard</button><button onClick={() => void swipe(true)} style={{ ...buttonStyle, flex: 1, background: "#c8f135" }}>Save →</button></div><p style={{ textAlign: "center", color: "#777", fontSize: 11 }}>Swipe left to discard · right to save</p></div>}</section>
      <div style={gridStyle}>{assets.map((asset) => <article key={asset.id} style={cardStyle}><div style={{ position: "relative", aspectRatio: "4/3", background: "#eee" }}>{asset.url && <Image src={asset.url} alt={asset.description || asset.label || "Library asset"} fill unoptimized style={{ objectFit: "cover" }} />}{asset.is_intro && <span style={{ position: "absolute", top: 8, left: 8, background: "#c8f135", padding: "4px 7px", border: "1px solid #2a2a2a", fontSize: 10 }}>INTRO</span>}</div><div style={{ padding: 12 }}><b>{asset.label || "Untitled image"}</b><p style={{ color: "#666", fontSize: 11, lineHeight: 1.45 }}>{asset.description || "Description pending"}</p><button onClick={async () => { await fetch("/api/board2/assets", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: asset.id, isIntro: true }) }); await refreshAssets(); }} style={{ ...buttonStyle, padding: "6px 8px", background: asset.is_intro ? "#c8f135" : "white" }}>{asset.is_intro ? "✓ Permanent intro" : "Set as intro"}</button><button onClick={async () => { if (confirm("Delete this asset?")) { await fetch(`/api/board2/assets?id=${asset.id}`, { method: "DELETE" }); await refreshAssets(); } }} style={deleteStyle}>Delete</button></div></article>)}</div>
      {!busy && !assets.length && <section style={emptyStyle}>No cloud assets yet. Upload an image or swipe right on a search result.</section>}
    </>}
  </main>;
}

const buttonStyle: React.CSSProperties = { border: "1.5px solid #2a2a2a", color: "#2a2a2a", background: "white", padding: "9px 13px", cursor: "pointer", font: "12px monospace", boxShadow: "2px 2px 0 #2a2a2a" };
const filterStyle: React.CSSProperties = { ...buttonStyle, boxShadow: "none", padding: "7px 12px" };
const emptyStyle: React.CSSProperties = { border: "2px dashed #aaa", padding: 32, color: "#555", background: "rgba(255,255,255,.55)" };
const gridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 18 };
const cardStyle: React.CSSProperties = { border: "2px solid #2a2a2a", background: "white", boxShadow: "4px 4px 0 #2a2a2a", overflow: "hidden" };
const imageButtonStyle: React.CSSProperties = { border: 0, padding: 0, width: "100%", background: "#ece9de", cursor: "pointer", display: "grid", placeItems: "center", aspectRatio: "16/9", position: "relative", fontSize: 34 };
const deleteStyle: React.CSSProperties = { border: 0, background: "none", color: "#b42318", padding: "10px 0 0 10px", cursor: "pointer", font: "11px monospace" };
