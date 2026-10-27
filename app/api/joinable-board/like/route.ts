import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { normalizeJoinCode } from "@/lib/joinable-board";
import { joinableBoardError, participantIdFromToken, unexpiredBoardFilter } from "@/lib/joinable-board-server";
import { hasBoardItem, readLikes, setLike } from "@/lib/joinable-board-likes";

// Enough for a burst of people liking at the same moment; each retry waits a little, at random,
// so racing requests spread out instead of colliding again.
const ATTEMPTS = 25;
const backoff = (attempt: number) => new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(200, 20 * (attempt + 1))));

// Likes or unlikes one item for whoever holds the participant token. Anyone on the board, the
// owner included, gets one like per item; liking isn't editing, so it works on anyone's item.
// The liker comes from the token, as for addedBy, never from anything else in the request.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as { code?: unknown; itemId?: unknown; liked?: unknown; participantToken?: unknown } | null;
    const code = normalizeJoinCode(body?.code);
    const itemId = typeof body?.itemId === "string" ? body.itemId : "";
    if (code.length !== 6 || !itemId || itemId.length > 200 || typeof body?.liked !== "boolean") return NextResponse.json({ error: "Invalid like." }, { status: 400 });
    const participantId = participantIdFromToken(body.participantToken);
    if (!participantId) return NextResponse.json({ error: "Missing participant identity.", forbidden: true }, { status: 403 });
    const supabase = getSupabase();
    // Compare-and-swap on the board's version: a like that races another save (or another like)
    // re-reads and applies on top, so simultaneous likes all count.
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await backoff(attempt);
      const { data: board, error: readError } = await supabase.from("joinable_boards").select("id,state,version").eq("code", code).eq("active", true).or(unexpiredBoardFilter()).maybeSingle();
      if (readError) throw readError;
      if (!board) return NextResponse.json({ error: "That board is no longer joinable." }, { status: 404 });
      const state = (board.state ?? {}) as Record<string, unknown>;
      if (!hasBoardItem(state, itemId)) return NextResponse.json({ error: "That item isn't on the board any more." }, { status: 404 });
      const likes = setLike(state, itemId, participantId, body.liked);
      if ((readLikes(state)[itemId] ?? []).includes(participantId) === body.liked) return NextResponse.json({ version: board.version, likes: likes[itemId] ?? [] });
      const { likes: _previous, ...rest } = state;
      const { data, error } = await supabase.from("joinable_boards")
        .update({ state: Object.keys(likes).length ? { ...rest, likes } : rest, version: board.version + 1, updated_at: new Date().toISOString() })
        .eq("id", board.id).eq("version", board.version).select("version").maybeSingle();
      if (error) throw error;
      if (data) return NextResponse.json({ version: data.version, likes: likes[itemId] ?? [] });
    }
    return NextResponse.json({ conflict: true, error: "The board is busy. Try again." }, { status: 409 });
  } catch (error) { return joinableBoardError(error); }
}
