"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BOARD_LIBRARY_PENDING_FILE,
  type BoardLibraryEntry,
  getBoardsDirectory,
  listBoards,
  supportsBoardDirectory,
  updateTrainingFlag,
} from "@/lib/board-library";

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

export default function BoardLibraryPage() {
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null);
  const [boards, setBoards] = useState<BoardLibraryEntry[]>([]);
  const [trainingOnly, setTrainingOnly] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async (handle: FileSystemDirectoryHandle) => {
    setBusy(true);
    try {
      setBoards(await listBoards(handle));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not read the boards folder.");
    } finally {
      setBusy(false);
    }
  }, []);

  const chooseFolder = useCallback(async () => {
    try {
      const handle = await getBoardsDirectory({ prompt: true, write: true });
      setDirectory(handle);
      if (handle) await refresh(handle);
    } catch (error) {
      if ((error as DOMException)?.name !== "AbortError") setMessage(error instanceof Error ? error.message : "Folder access failed.");
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    void (async () => {
      try {
        const handle = await getBoardsDirectory({ prompt: false, write: true });
        setDirectory(handle);
        if (handle) await refresh(handle);
        else setBusy(false);
      } catch {
        setBusy(false);
      }
    })();
  }, [refresh]);

  const visibleBoards = useMemo(() => trainingOnly ? boards.filter((board) => board.meta.trainingExample) : boards, [boards, trainingOnly]);
  const trainingCount = boards.filter((board) => board.meta.trainingExample).length;

  const toggleTraining = async (entry: BoardLibraryEntry) => {
    if (!directory) return;
    const next = !entry.meta.trainingExample;
    setBoards((current) => current.map((board) => board.fileName === entry.fileName ? { ...board, meta: { ...board.meta, trainingExample: next } } : board));
    try {
      await updateTrainingFlag(directory, entry, next);
      await refresh(directory);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update the board.");
      await refresh(directory);
    }
  };

  const removeBoard = async (entry: BoardLibraryEntry) => {
    if (!directory || !window.confirm(`Delete “${entry.meta.title}” from the library? This removes ${entry.fileName}.`)) return;
    await directory.removeEntry(entry.fileName);
    await refresh(directory);
  };

  const openBoard = (entry: BoardLibraryEntry) => {
    sessionStorage.setItem(BOARD_LIBRARY_PENDING_FILE, entry.fileName);
    window.location.assign("/board2");
  };

  return (
    <main style={{ minHeight: "100vh", background: "#fffdf5", color: "#2a2a2a", padding: "28px clamp(18px, 4vw, 56px)", fontFamily: "monospace" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 28 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#777" }}>Neuralboard</div>
          <h1 style={{ margin: "5px 0 0", fontFamily: "Georgia, serif", fontSize: 34 }}>Board Library</h1>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Link href="/board2" style={buttonStyle}>← Editor</Link>
          <button onClick={chooseFolder} style={{ ...buttonStyle, background: "#c8f135" }}>{directory ? "Change folder" : "Choose boards folder"}</button>
        </div>
      </header>

      {!supportsBoardDirectory() ? (
        <section style={emptyStyle}>This browser does not support folder access. Saving in the editor will continue to download `.nbp` files.</section>
      ) : !directory ? (
        <section style={emptyStyle}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Choose your boards folder</div>
          <div style={{ color: "#666", marginBottom: 18 }}>The folder handle is remembered in this browser. You may only need to re-approve access after restarting it.</div>
          <button onClick={chooseFolder} style={{ ...buttonStyle, background: "#c8f135" }}>Choose folder</button>
        </section>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
            <button onClick={() => setTrainingOnly(false)} style={{ ...filterStyle, background: !trainingOnly ? "#2a2a2a" : "transparent", color: !trainingOnly ? "#fff" : "#2a2a2a" }}>All ({boards.length})</button>
            <button onClick={() => setTrainingOnly(true)} style={{ ...filterStyle, background: trainingOnly ? "#2a2a2a" : "transparent", color: trainingOnly ? "#fff" : "#2a2a2a" }}>⭐ Training examples ({trainingCount})</button>
            {busy && <span style={{ color: "#777" }}>Reading folder…</span>}
          </div>
          {message && <p style={{ color: "#b42318" }}>{message}</p>}
          {!busy && visibleBoards.length === 0 ? (
            <section style={emptyStyle}>{trainingOnly ? "No boards are flagged as training examples yet." : "No .nbp boards found in this folder."}</section>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 20 }}>
              {visibleBoards.map((entry) => (
                <article key={entry.fileName} style={{ border: "2px solid #2a2a2a", background: "white", boxShadow: "4px 4px 0 #2a2a2a", overflow: "hidden" }}>
                  <button onClick={() => openBoard(entry)} style={{ border: 0, padding: 0, width: "100%", background: "#ece9de", cursor: "pointer", display: "block", aspectRatio: "16 / 9", position: "relative" }} aria-label={`Open ${entry.meta.title}`}>
                    {entry.thumbnailDataUri ? <Image src={entry.thumbnailDataUri} alt="" fill unoptimized sizes="(max-width: 600px) 100vw, 300px" style={{ objectFit: "cover" }} /> : <span style={{ display: "grid", placeItems: "center", height: "100%", fontSize: 34 }}>▧</span>}
                  </button>
                  <div style={{ padding: 14 }}>
                    <button onClick={() => openBoard(entry)} style={{ border: 0, padding: 0, background: "none", cursor: "pointer", font: "700 17px Georgia, serif", textAlign: "left" }}>{entry.meta.title}</button>
                    <div style={{ color: "#777", fontSize: 11, margin: "7px 0 14px" }}>{new Date(entry.meta.modifiedAt).toLocaleString()} · {formatDuration(entry.meta.duration)}</div>
                    <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: 12 }}>
                      <input type="checkbox" checked={entry.meta.trainingExample} onChange={() => void toggleTraining(entry)} /> ⭐ Training example
                    </label>
                    <button onClick={() => void removeBoard(entry)} style={{ border: 0, background: "none", color: "#b42318", padding: "12px 0 0", cursor: "pointer", font: "11px monospace" }}>Delete from library</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}

const buttonStyle: React.CSSProperties = { border: "1.5px solid #2a2a2a", color: "#2a2a2a", background: "white", padding: "9px 13px", textDecoration: "none", cursor: "pointer", font: "12px monospace", boxShadow: "2px 2px 0 #2a2a2a" };
const filterStyle: React.CSSProperties = { border: "1.5px solid #2a2a2a", padding: "7px 11px", cursor: "pointer", font: "11px monospace" };
const emptyStyle: React.CSSProperties = { border: "2px dashed #aaa", padding: 32, maxWidth: 680, color: "#555", background: "rgba(255,255,255,.55)" };
