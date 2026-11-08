"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { MainSectionNav } from "@/app/components/MainSectionNav";
import type { OwnedBoardSummary } from "@/lib/joinable-board";
import styles from "./boards.module.css";

type Load = { status: "loading" } | { status: "signedOut" } | { status: "error"; message: string } | { status: "ready"; boards: OwnedBoardSummary[] };

export default function MyBoardsPage() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [deleting, setDeleting] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let current = true;
    void fetch("/api/joinable-board/mine", { cache: "no-store" }).then(async (response) => {
      if (!current) return;
      if (response.status === 401) { setLoad({ status: "signedOut" }); return; }
      const result = await response.json().catch(() => null);
      if (!current) return;
      if (!response.ok || !Array.isArray(result)) setLoad({ status: "error", message: result?.error || "Could not load your boards." });
      else setLoad({ status: "ready", boards: result as OwnedBoardSummary[] });
    }).catch(() => { if (current) setLoad({ status: "error", message: "Could not load your boards." }); });
    return () => { current = false; };
  }, []);

  // The joinable-board DELETE route checks ownership against the session; afterwards the code no
  // longer opens the board for anyone.
  async function remove(board: OwnedBoardSummary) {
    if (!window.confirm(`Delete board ${board.title}? Its code ${board.code} will stop working for everyone.`)) return;
    setDeleting(board.code); setMessage("");
    try {
      const response = await fetch("/api/joinable-board", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: board.code }) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not delete that board.");
      setLoad((state) => state.status === "ready" ? { status: "ready", boards: state.boards.filter((item) => item.code !== board.code) } : state);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not delete that board."); }
    finally { setDeleting(null); }
  }

  return <main className={styles.page}><div className={styles.shell}>
    <header className={`${styles.header} main-section-page-header`}>
      <div><div className={styles.eyebrow}>Neuralboard</div><h1>My boards</h1></div>
      <MainSectionNav active="boards" />
    </header>
    {message && <p className={styles.error}>{message}</p>}
    {load.status === "loading" && <p className={styles.muted}>Loading your boards…</p>}
    {load.status === "error" && <p className={styles.error}>{load.message}</p>}
    {load.status === "signedOut" && <div className={styles.empty}><b>Sign in to see your boards.</b><p className={styles.muted}><Link href="/signin?callbackUrl=%2Fboards">Sign in</Link> and the boards you create will be listed here.</p></div>}
    {load.status === "ready" && (load.boards.length ? <div className={styles.list}>{load.boards.map((board) => <article className={styles.board} key={board.code}>
      <Link className={styles.open} href={`/board2?join=${encodeURIComponent(board.code)}`}>
        <h2>{board.title}</h2>
        <div className={styles.muted}>{board.boardType === "simple" ? "Old-school board" : "Neural board"} · Code {board.code}<br />Updated {new Date(board.updatedAt).toLocaleString()}</div>
      </Link>
      <button className={`${styles.button} ${styles.secondary}`} disabled={deleting === board.code} onClick={() => void remove(board)}>{deleting === board.code ? "Deleting…" : "Delete"}</button>
    </article>)}</div> : <div className={styles.empty}><b>No boards yet.</b><p className={styles.muted}>Boards you create while signed in, or save to your account, show up here.</p></div>)}
  </div></main>;
}
