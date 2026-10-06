import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import type { MyPublishedBoard } from "@/lib/published-boards";
import { publishedBoardsError, sessionEmail } from "@/lib/published-boards-server";

/** The signed-in user's live publications, for the Profile tab's Public toggles. */
export async function GET() {
  try {
    const email = await sessionEmail();
    if (!email) return NextResponse.json({ boards: [] }, { headers: { "Cache-Control": "no-store" } });
    const { data, error } = await getSupabase()
      .from("published_boards")
      .select("id,board_key,title,size_bytes,published_at")
      .eq("owner_email", email)
      .not("published_at", "is", null)
      .not("package_path", "is", null);
    if (error) throw error;
    const boards: MyPublishedBoard[] = (data ?? []).map((row) => ({ id: row.id, boardKey: row.board_key, title: row.title, sizeBytes: Number(row.size_bytes || 0), publishedAt: row.published_at }));
    return NextResponse.json({ boards }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return publishedBoardsError(error); }
}
