"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MainSectionNav } from "@/app/components/MainSectionNav";
import { normalizeJoinCode } from "@/lib/joinable-board";
import styles from "./public.module.css";

export default function JoinBoardPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    const normalized = normalizeJoinCode(code);
    if (normalized.length !== 6) { setError("Enter the six-character code shown on the other board."); return; }
    setChecking(true); setError("");
    try {
      const response = await fetch(`/api/joinable-board?code=${normalized}`, { cache: "no-store" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not join that board.");
      router.push(`/?join=${normalized}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not join that board."); }
    finally { setChecking(false); }
  }

  return <main className={styles.joinPage}>
    <div className={styles.joinNav}><MainSectionNav active="public" /></div>
    <form className={styles.joinCard} onSubmit={join}>
      <div className={styles.joinEyebrow}>Neural Board</div>
      <h1>Join a board</h1>
      <p>Enter the code shown on someone’s board to edit it together.</p>
      <input autoFocus inputMode="text" autoCapitalize="characters" autoComplete="off" maxLength={6} aria-label="Board code" value={code} onChange={(event) => setCode(normalizeJoinCode(event.target.value))} placeholder="ABC123" />
      {error && <div className={styles.joinError}>{error}</div>}
      <button disabled={checking || code.length !== 6}>{checking ? "Checking…" : "Join board →"}</button>
    </form>
  </main>;
}
