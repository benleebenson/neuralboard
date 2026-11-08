import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { ownedBoardSummary } from "@/lib/joinable-board";
import { joinableBoardError, unexpiredBoardFilter } from "@/lib/joinable-board-server";

// The signed-in account's own boards, newest first. The owner comes only from the session, never
// from the request. Boards that stopped sharing (DELETE) are inactive and can't be reopened, so
// they're left out. Only the fields the list needs are read out of the state JSONB.
export async function GET() {
  const email = (await getServerSession(authOptions))?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { data, error } = await getSupabase().from("joinable_boards")
      .select("code,updated_at,title:state->>title,boardType:state->>boardType")
      .eq("owner_email", email).eq("active", true).or(unexpiredBoardFilter())
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json((data ?? []).map(ownedBoardSummary), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return joinableBoardError(error); }
}
