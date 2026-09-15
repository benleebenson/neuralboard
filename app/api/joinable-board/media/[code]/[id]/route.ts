import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { normalizeJoinCode } from "@/lib/joinable-board";
import { joinableBoardError } from "@/lib/joinable-board-server";

export async function GET(_request: Request, context: RouteContext<"/api/joinable-board/media/[code]/[id]">) {
  try {
    const params = await context.params;
    const code = normalizeJoinCode(params.code);
    if (code.length !== 6 || !/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: "Image not found." }, { status: 404 });
    const supabase = getSupabase();
    const { data: board, error } = await supabase.from("joinable_boards").select("id").eq("code", code).eq("active", true).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (error) throw error;
    if (!board) return NextResponse.json({ error: "Image not found." }, { status: 404 });
    const signed = await supabase.storage.from("joinable-board-media").createSignedUrl(`${board.id}/${params.id}.webp`, 300);
    if (signed.error) throw signed.error;
    return NextResponse.redirect(signed.data.signedUrl, { status: 307, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return joinableBoardError(error); }
}
