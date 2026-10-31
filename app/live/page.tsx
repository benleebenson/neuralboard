import Link from "next/link";
import { redirect } from "next/navigation";
import { ADMIN_EMAIL } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { liveBoardDestination } from "@/lib/live-board";

// neuralboard.org/live: straight into whichever board the site owner has set as live (see
// lib/live-board), joining it. With none set, or that board stopped or expired, a short page says
// so instead of an error.
export const dynamic = "force-dynamic";

async function liveDestination(): Promise<string | null> {
  try {
    const supabase = getSupabase();
    const { data: live, error } = await supabase.from("live_board").select("code").eq("id", true).maybeSingle();
    if (error) throw error;
    if (!live?.code) return null;
    const { data: board, error: boardError } = await supabase.from("joinable_boards").select("code,active,expires_at,owner_email").eq("code", live.code).maybeSingle();
    if (boardError) throw boardError;
    return liveBoardDestination(board, ADMIN_EMAIL);
  } catch (error) {
    console.error("LIVE_BOARD_FAIL", error);
    return null;
  }
}

export default async function LivePage() {
  const destination = await liveDestination();
  // Outside the try: redirect() works by throwing.
  if (destination) redirect(destination);
  return (
    <main style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, background: "#f5f1e8", color: "#2a2a2a", fontFamily: "'Courier New', monospace", textAlign: "center" }}>
      <h1 style={{ fontFamily: "'Caveat', cursive", fontSize: 44, margin: 0 }}>Nothing live right now</h1>
      <p style={{ fontSize: 14, margin: 0, maxWidth: 360 }}>There&apos;s no board open to join at the moment. Check back soon.</p>
      <Link href="/" style={{ marginTop: 8, fontSize: 14, color: "#2a2a2a", fontWeight: 700 }}>Go to Neural Board</Link>
    </main>
  );
}
