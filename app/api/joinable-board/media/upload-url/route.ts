import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { normalizeJoinCode, SHARED_AV_EXTENSIONS, SHARED_AV_MAX_BYTES } from "@/lib/joinable-board";
import { joinableBoardError, unexpiredBoardFilter } from "@/lib/joinable-board-server";

// A one-time signed upload URL for a video or narration file on a joinable board. The browser
// uploads the bytes directly to Storage; the bucket enforces the same size and type limits.
export async function POST(request: Request) {
  try {
    const body = await request.json() as { code?: string; mime?: string; size?: number };
    const code = normalizeJoinCode(body.code);
    const mime = String(body.mime ?? "").split(";")[0].trim().toLowerCase();
    const ext = SHARED_AV_EXTENSIONS[mime];
    const size = Number(body.size);
    if (code.length !== 6 || !ext || !Number.isFinite(size) || size <= 0) return NextResponse.json({ error: "This file type can't be shared." }, { status: 400 });
    if (size > SHARED_AV_MAX_BYTES) return NextResponse.json({ error: `Shared files must be ${SHARED_AV_MAX_BYTES / 1024 / 1024} MB or smaller.` }, { status: 413 });
    const supabase = getSupabase();
    const { data: board, error: boardError } = await supabase.from("joinable_boards").select("id").eq("code", code).eq("active", true).or(unexpiredBoardFilter()).maybeSingle();
    if (boardError) throw boardError;
    if (!board) return NextResponse.json({ error: "That board is no longer joinable." }, { status: 404 });
    const id = crypto.randomUUID();
    const signed = await supabase.storage.from("joinable-board-media").createSignedUploadUrl(`${board.id}/${id}.${ext}`);
    if (signed.error) throw signed.error;
    return NextResponse.json({ uploadUrl: signed.data.signedUrl, url: `/api/joinable-board/media/${code}/${id}.${ext}` }, { status: 201 });
  } catch (error) { return joinableBoardError(error); }
}
