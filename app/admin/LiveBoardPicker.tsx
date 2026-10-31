"use client";

import { useEffect, useState } from "react";

// Which board neuralboard.org/live sends people to. The API (/api/live-board) checks it's the site
// owner; this only shows their boards and sets one.

type Board = { code: string; created_at: string; updated_at: string; expires_at: string | null };

const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const button: React.CSSProperties = { padding: "4px 10px", fontSize: 11, fontFamily: "inherit", fontWeight: 700, background: "white", color: "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: "pointer" };

export default function LiveBoardPicker() {
  const [live, setLive] = useState<string | null>(null);
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/live-board", { cache: "no-store" })
      .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) }))
      .catch(() => ({ ok: false, body: {} }))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) { setMessage(body.error ?? "Couldn't load your boards."); return; }
        setLive(body.live);
        setBoards(body.boards);
      });
    return () => { cancelled = true; };
  }, []);

  async function setLiveBoard(code: string | null) {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/live-board", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) { setMessage(body.error ?? "Couldn't change the live board."); return; }
    setLive(body.live);
    setMessage(body.live ? `/live now opens ${body.live}.` : "/live now shows “Nothing live right now”.");
  }

  return (
    <section style={{ marginBottom: 48 }}>
      <h2 style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1, marginBottom: 4, color: "#2a2a2a" }}>LIVE BOARD</h2>
      <p style={{ fontSize: 11, color: "#6a6a6a", margin: "0 0 12px" }}>
        <a href="/live" style={{ color: "#2a2a2a" }}>neuralboard.org/live</a> opens{" "}
        <strong>{live ?? "nothing"}</strong>.{" "}
        {live && <button type="button" style={button} disabled={busy} onClick={() => void setLiveBoard(null)}>Clear</button>}
      </p>
      {message && <p role="status" style={{ fontSize: 11, margin: "0 0 12px" }}>{message}</p>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", background: "white", border: "1.5px solid #2a2a2a" }}>
          <thead>
            <tr style={{ background: "#2a2a2a", color: "white" }}>
              {["Board", "Created", "Last changed", ""].map((label) => (
                <th key={label} style={{ padding: "8px 12px", textAlign: "left", fontSize: 11, letterSpacing: 0.5 }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(boards ?? []).map((board) => (
              <tr key={board.code} style={{ borderBottom: "1px solid #eee", background: board.code === live ? "#fff6c9" : undefined }}>
                <td style={{ padding: "8px 12px", fontSize: 12 }}><a href={`/board2?join=${board.code}`} style={{ color: "#2a2a2a", fontWeight: 700 }}>{board.code}</a></td>
                <td style={{ padding: "8px 12px", fontSize: 12 }}>{fmt(board.created_at)}</td>
                <td style={{ padding: "8px 12px", fontSize: 12 }}>{fmt(board.updated_at)}</td>
                <td style={{ padding: "8px 12px", fontSize: 12, textAlign: "right" }}>
                  {board.code === live
                    ? <strong style={{ letterSpacing: 1 }}>● LIVE</strong>
                    : <button type="button" style={button} disabled={busy} onClick={() => void setLiveBoard(board.code)}>Make this the live board</button>}
                </td>
              </tr>
            ))}
            {boards && boards.length === 0 && (
              <tr><td colSpan={4} style={{ padding: "8px 12px", fontSize: 12 }}>No shared boards on your account. Make one while signed in, then set it here.</td></tr>
            )}
            {!boards && !message && (
              <tr><td colSpan={4} style={{ padding: "8px 12px", fontSize: 12 }}>Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
