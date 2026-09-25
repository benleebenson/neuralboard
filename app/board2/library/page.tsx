"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BOARD_LIBRARY_PENDING_FILE, type BoardLibraryEntry, getBoardsDirectory, listBoards, readNbpManifest, supportsBoardDirectory, updateTrainingFlag } from "@/lib/board-library";
import { MainSectionNav } from "@/app/components/MainSectionNav";
import { addSimpleWorldBoard, listSimpleWorldBoards } from "@/lib/simple-world";

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
  const [spaceBoardFiles, setSpaceBoardFiles] = useState<Set<string>>(() => new Set());
  const [addingToSpace, setAddingToSpace] = useState<string | null>(null);

  const refreshBoards = useCallback(async (handle: FileSystemDirectoryHandle) => {
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
      if (handle) await refreshBoards(handle);
    } catch (error) {
      if ((error as DOMException)?.name !== "AbortError") setMessage(error instanceof Error ? error.message : "Folder access failed.");
      setBusy(false);
    }
  }, [refreshBoards]);

  useEffect(() => {
    void (async () => {
      try {
        const handle = await getBoardsDirectory({ prompt: false, write: true });
        setDirectory(handle);
        if (handle) await refreshBoards(handle);
        else setBusy(false);
      } catch {
        setBusy(false);
      }
    })();
  }, [refreshBoards]);

  useEffect(() => {
    void listSimpleWorldBoards()
      .then((items) => setSpaceBoardFiles(new Set(items.map((item) => item.fileName))))
      .catch(() => {});
  }, []);

  const visibleBoards = useMemo(
    () => trainingOnly ? boards.filter((board) => board.meta.trainingExample) : boards,
    [boards, trainingOnly],
  );

  const addToSpace = useCallback(async (entry: BoardLibraryEntry) => {
    if (!directory || addingToSpace) return;
    setAddingToSpace(entry.fileName);
    setMessage("");
    try {
      const sourceFileHandle = await directory.getFileHandle(entry.fileName);
      await addSimpleWorldBoard({
        file: entry.file,
        fileName: entry.fileName,
        name: entry.meta.title,
        sourceFileHandle,
        sourceDirectoryHandle: directory,
      });
      setSpaceBoardFiles((current) => new Set(current).add(entry.fileName));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add that board to the space.");
    } finally {
      setAddingToSpace(null);
    }
  }, [addingToSpace, directory]);

  const addFilesToSpace = useCallback(async (files: File[]) => {
    if (!files.length || addingToSpace) return;
    setAddingToSpace(files[0].name);
    setMessage("");
    try {
      const root = await navigator.storage.getDirectory();
      const sources = await root.getDirectoryHandle("neuralboard-space-sources", { create: true });
      for (const file of files) {
        const { manifest } = readNbpManifest(new Uint8Array(await file.arrayBuffer()));
        const sourceFileHandle = await sources.getFileHandle(file.name, { create: true });
        const writable = await sourceFileHandle.createWritable();
        await writable.write(file);
        await writable.close();
        await addSimpleWorldBoard({
          file,
          fileName: file.name,
          name: String(manifest.meta?.title ?? manifest.name ?? file.name.replace(/\.nbp$/i, "")),
          sourceFileHandle,
          sourceDirectoryHandle: root,
        });
        setSpaceBoardFiles((current) => new Set(current).add(file.name));
      }
      setMessage(`${files.length} board${files.length === 1 ? "" : "s"} added to the space.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add those boards to the space.");
    } finally {
      setAddingToSpace(null);
    }
  }, [addingToSpace]);

  return (
    <main style={{ minHeight: "100vh", background: "#fffdf5", color: "#2a2a2a", padding: "28px clamp(18px, 4vw, 56px)", fontFamily: "monospace" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 2, color: "#777" }}>NEURALBOARD</div>
          <h1 style={{ margin: "5px 0 0", fontFamily: "Georgia, serif", fontSize: 34 }}>Library</h1>
        </div>
        <MainSectionNav active="library" />
      </header>

      {message && <p role="alert" style={{ color: "#b42318" }}>{message}</p>}
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <button onClick={chooseFolder} style={{ ...buttonStyle, background: "#c8f135" }}>{directory ? "Change folder" : "Choose boards folder"}</button>
        <label style={{ ...buttonStyle, position: "relative", background: "#fffdf5" }}>
          {addingToSpace ? "Building composite…" : "Add .nbp to Space"}
          <input
            type="file"
            accept=".nbp,.zip"
            multiple
            aria-label="Add board files to space"
            disabled={addingToSpace !== null}
            onChange={(event) => { const files = [...event.target.files ?? []]; event.target.value = ""; void addFilesToSpace(files); }}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
          />
        </label>
        <button onClick={() => setTrainingOnly(false)} style={filterStyle}>All ({boards.length})</button>
        <button onClick={() => setTrainingOnly(true)} style={filterStyle}>⭐ Training ({boards.filter((board) => board.meta.trainingExample).length})</button>
      </div>

      {busy ? (
        <section style={emptyStyle}>Loading boards…</section>
      ) : !supportsBoardDirectory() || !directory ? (
        <section style={emptyStyle}>Choose a local boards folder to see `.nbp` projects.</section>
      ) : visibleBoards.length === 0 ? (
        <section style={emptyStyle}>No boards found in this folder.</section>
      ) : (
        <div style={gridStyle}>
          {visibleBoards.map((entry) => (
            <article key={entry.fileName} style={cardStyle}>
              <button
                type="button"
                aria-label={`Open ${entry.meta.title}`}
                onClick={() => {
                  sessionStorage.setItem(BOARD_LIBRARY_PENDING_FILE, entry.fileName);
                  location.assign("/board2");
                }}
                style={imageButtonStyle}
              >
                {entry.thumbnailDataUri ? <Image src={entry.thumbnailDataUri} alt="" fill unoptimized style={{ objectFit: "cover" }} /> : "▧"}
              </button>
              <div style={{ padding: 14 }}>
                <b style={{ fontFamily: "Georgia, serif" }}>{entry.meta.title}</b>
                <div style={{ color: "#777", fontSize: 11, margin: "7px 0" }}>{formatDuration(entry.meta.duration)}</div>
                <label><input type="checkbox" checked={entry.meta.trainingExample} onChange={async () => { await updateTrainingFlag(directory, entry, !entry.meta.trainingExample); await refreshBoards(directory); }} /> ⭐ Training example</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                  <button
                    type="button"
                    disabled={spaceBoardFiles.has(entry.fileName) || addingToSpace !== null}
                    onClick={() => void addToSpace(entry)}
                    style={{ ...buttonStyle, padding: "7px 9px", background: spaceBoardFiles.has(entry.fileName) ? "#eee" : "#c8f135", opacity: addingToSpace && addingToSpace !== entry.fileName ? .55 : 1 }}
                  >
                    {addingToSpace === entry.fileName ? "Building composite…" : spaceBoardFiles.has(entry.fileName) ? "✓ In Space" : "Add to Space"}
                  </button>
                  <button onClick={async () => { if (confirm(`Delete “${entry.meta.title}”?`)) { await directory.removeEntry(entry.fileName); await refreshBoards(directory); } }} style={{ ...deleteStyle, padding: 0 }}>Delete</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}

const buttonStyle: React.CSSProperties = { border: "1.5px solid #2a2a2a", padding: "10px 13px", background: "white", boxShadow: "2px 2px 0 #2a2a2a", cursor: "pointer", fontFamily: "monospace", fontWeight: 700 };
const filterStyle: React.CSSProperties = { ...buttonStyle, padding: "8px 11px", boxShadow: "none" };
const emptyStyle: React.CSSProperties = { border: "2px dashed #aaa", padding: 30, textAlign: "center", color: "#666" };
const gridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 18 };
const cardStyle: React.CSSProperties = { border: "2px solid #2a2a2a", background: "white", boxShadow: "4px 4px 0 #2a2a2a" };
const imageButtonStyle: React.CSSProperties = { position: "relative", width: "100%", aspectRatio: "16/9", border: 0, borderBottom: "1.5px solid #2a2a2a", background: "#ece7da", cursor: "pointer", fontSize: 32 };
const deleteStyle: React.CSSProperties = { border: 0, background: "transparent", color: "#a32916", textDecoration: "underline", cursor: "pointer", fontFamily: "monospace" };
