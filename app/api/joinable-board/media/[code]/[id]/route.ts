import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { normalizeJoinCode, SHARED_MEDIA_EXTENSIONS } from "@/lib/joinable-board";
import { joinableBoardError, unexpiredBoardFilter } from "@/lib/joinable-board-server";

// `id` is `{uuid}.{ext}` for video and narration; images predate extensions and are `{uuid}` (webp).
export async function GET(_request: Request, context: RouteContext<"/api/joinable-board/media/[code]/[id]">) {
  try {
    const params = await context.params;
    const code = normalizeJoinCode(params.code);
    const match = /^([0-9a-f-]{36})(?:\.([a-z0-9]+))?$/i.exec(params.id);
    const ext = (match?.[2] ?? "webp").toLowerCase();
    if (code.length !== 6 || !match || !SHARED_MEDIA_EXTENSIONS.has(ext)) return NextResponse.json({ error: "Media not found." }, { status: 404 });
    const supabase = getSupabase();
    const { data: board, error } = await supabase.from("joinable_boards").select("id").eq("code", code).eq("active", true).or(unexpiredBoardFilter()).maybeSingle();
    if (error) throw error;
    if (!board) return NextResponse.json({ error: "Media not found." }, { status: 404 });
    // Video keeps issuing range requests to the redirected URL while it plays, so it gets longer.
    const signed = await supabase.storage.from("joinable-board-media").createSignedUrl(`${board.id}/${match[1]}.${ext}`, ext === "webp" ? 300 : 3600);
    if (signed.error) throw signed.error;
    return NextResponse.redirect(signed.data.signedUrl, { status: 307, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return joinableBoardError(error); }
}
