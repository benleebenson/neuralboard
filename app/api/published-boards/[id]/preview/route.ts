import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { PUBLISHED_BOARDS_BUCKET, validPublishedBoardId } from "@/lib/published-boards";
import { publishedBoardsError } from "@/lib/published-boards-server";

/** A published board's feed preview, via a short-lived signed URL; 404 once the board is unpublished. */
export async function GET(_request: Request, context: RouteContext<"/api/published-boards/[id]/preview">) {
  try {
    const { id } = await context.params;
    const missing = () => NextResponse.json({ error: "Preview not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
    if (!validPublishedBoardId(id)) return missing();
    const supabase = getSupabase();
    const { data, error } = await supabase.from("published_boards").select("preview_path").eq("id", id).not("published_at", "is", null).maybeSingle();
    if (error) throw error;
    if (!data?.preview_path) return missing();
    const signed = await supabase.storage.from(PUBLISHED_BOARDS_BUCKET).createSignedUrl(data.preview_path, 3600);
    if (signed.error) throw signed.error;
    return NextResponse.redirect(signed.data.signedUrl, { status: 307, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return publishedBoardsError(error); }
}
