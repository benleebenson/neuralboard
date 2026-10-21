import crypto from "node:crypto";
import sharp from "sharp";
import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { normalizeJoinCode } from "@/lib/joinable-board";
import { joinableBoardError, unexpiredBoardFilter } from "@/lib/joinable-board-server";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const code = normalizeJoinCode(form.get("code"));
    const file = form.get("file");
    if (code.length !== 6 || !(file instanceof File) || !file.type.startsWith("image/")) return NextResponse.json({ error: "Choose an image to share." }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "Shared images must be smaller than 15 MB." }, { status: 413 });
    const supabase = getSupabase();
    const { data: board, error: boardError } = await supabase.from("joinable_boards").select("id").eq("code", code).eq("active", true).or(unexpiredBoardFilter()).maybeSingle();
    if (boardError) throw boardError;
    if (!board) return NextResponse.json({ error: "That board is no longer joinable." }, { status: 404 });
    const id = crypto.randomUUID();
    const path = `${board.id}/${id}.webp`;
    // GIF/WebP keep every frame (as animated WebP) so animated board GIFs animate for everyone; the
    // pixel limit then covers all frames stacked, hence the larger allowance.
    const animated = file.type === "image/gif" || file.type === "image/webp";
    const bytes = await sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: animated ? 150_000_000 : 50_000_000, animated }).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
    const upload = await supabase.storage.from("joinable-board-media").upload(path, bytes, { contentType: "image/webp", upsert: false });
    if (upload.error) throw upload.error;
    return NextResponse.json({ url: `/api/joinable-board/media/${code}/${id}`, mime: "image/webp" }, { status: 201 });
  } catch (error) { return joinableBoardError(error); }
}
