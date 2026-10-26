import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { normalizeJoinCode } from "@/lib/joinable-board";
import { joinTokenHash, unexpiredBoardFilter } from "@/lib/joinable-board-server";
import {
  PUBLISHED_BOARDS_BUCKET,
  PUBLISHED_PACKAGE_MAX_BYTES,
  PUBLISHED_PREVIEW_MAX_BYTES,
  PUBLISHED_STORAGE_BUDGET_BYTES,
  PUBLISHED_TITLE_MAX,
  formatMegabytes,
  validPublishedBoardId,
  type PublishStart,
} from "@/lib/published-boards";
import { completePublishedUpload, publishedBoardsError } from "@/lib/published-boards-server";

const noStore = { "Cache-Control": "no-store" };

// Publishing without an account: a joinable board's creator (proven by its owner token) publishes
// a snapshot to the Home feed, keyed by the join code, so they can find it from another device.
// One publication per code; it expires with the board (cleanup-expired) and is removed when the
// board stops being shared.

async function ownedJoinableBoard(code: string, token: unknown) {
  if (code.length !== 6 || typeof token !== "string" || !token) return null;
  const { data, error } = await getSupabase().from("joinable_boards")
    .select("code,expires_at").eq("code", code).eq("owner_token_hash", joinTokenHash(token))
    .eq("active", true).or(unexpiredBoardFilter()).maybeSingle();
  if (error) throw error;
  return data;
}

/** Starts (re)publishing: reserves the code's row and returns signed upload URLs. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as { joinCode?: unknown; ownerToken?: unknown; title?: unknown; packageBytes?: unknown; previewBytes?: unknown } | null;
    const code = normalizeJoinCode(body?.joinCode);
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, PUBLISHED_TITLE_MAX) : "";
    const packageBytes = Number(body?.packageBytes);
    const previewBytes = Number(body?.previewBytes);
    if (!title || !Number.isFinite(packageBytes) || !Number.isFinite(previewBytes) || packageBytes <= 0 || previewBytes <= 0) {
      return NextResponse.json({ error: "Invalid board." }, { status: 400 });
    }
    const board = await ownedJoinableBoard(code, body?.ownerToken);
    if (!board) return NextResponse.json({ error: "Only the board's creator can publish it." }, { status: 403 });
    if (packageBytes > PUBLISHED_PACKAGE_MAX_BYTES) {
      return NextResponse.json({ error: `This board is ${formatMegabytes(packageBytes)} after compression; published boards must be under ${formatMegabytes(PUBLISHED_PACKAGE_MAX_BYTES)}.` }, { status: 413 });
    }
    if (previewBytes > PUBLISHED_PREVIEW_MAX_BYTES) return NextResponse.json({ error: "The board preview is too large." }, { status: 413 });

    const supabase = getSupabase();
    const { data: rows, error: rowsError } = await supabase.from("published_boards").select("join_code,size_bytes");
    if (rowsError) throw rowsError;
    const used = (rows ?? []).filter((row) => row.join_code !== code).reduce((sum, row) => sum + Number(row.size_bytes || 0), 0);
    if (used + packageBytes + previewBytes > PUBLISHED_STORAGE_BUDGET_BYTES) {
      return NextResponse.json({ error: "Published board storage is full. Please try again later." }, { status: 507 });
    }

    const findRow = () => supabase.from("published_boards").select("id").eq("join_code", code).maybeSingle();
    let { data: row, error: rowError } = await findRow();
    if (rowError) throw rowError;
    if (!row) {
      const { error: insertError } = await supabase.from("published_boards").insert({ owner_email: null, board_key: `join:${code}`, title, join_code: code, expires_at: board.expires_at });
      // A concurrent save may have reserved it first; either way the row now exists.
      if (insertError && insertError.code !== "23505") throw insertError;
      ({ data: row, error: rowError } = await findRow());
      if (rowError) throw rowError;
      if (!row) throw new Error("Could not reserve the publication");
    }

    const version = crypto.randomUUID();
    const storage = supabase.storage.from(PUBLISHED_BOARDS_BUCKET);
    const [pkg, preview] = await Promise.all([
      storage.createSignedUploadUrl(`${row.id}/${version}/board.nbp`),
      storage.createSignedUploadUrl(`${row.id}/${version}/preview.webp`),
    ]);
    if (pkg.error) throw pkg.error;
    if (preview.error) throw preview.error;
    const start: PublishStart = { id: row.id, version, uploads: { package: pkg.data.signedUrl, preview: preview.data.signedUrl } };
    return NextResponse.json(start, { status: 201, headers: noStore });
  } catch (error) { return publishedBoardsError(error); }
}

/** Finishes a publish after the uploads: lists the board (with the board's current expiry). */
export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => null) as { id?: unknown; version?: unknown; title?: unknown; joinCode?: unknown; ownerToken?: unknown } | null;
    const id = typeof body?.id === "string" ? body.id : "";
    const version = typeof body?.version === "string" ? body.version : "";
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, PUBLISHED_TITLE_MAX) : "";
    const code = normalizeJoinCode(body?.joinCode);
    if (!validPublishedBoardId(id) || !validPublishedBoardId(version) || !title) return NextResponse.json({ error: "Invalid board." }, { status: 400 });
    const board = await ownedJoinableBoard(code, body?.ownerToken);
    if (!board) return NextResponse.json({ error: "Only the board's creator can publish it." }, { status: 403 });
    const { data: row, error } = await getSupabase().from("published_boards").select("id").eq("id", id).eq("join_code", code).maybeSingle();
    if (error) throw error;
    if (!row) return NextResponse.json({ error: "That publication no longer exists." }, { status: 404 });
    return await completePublishedUpload(id, version, title, { expires_at: board.expires_at });
  } catch (error) { return publishedBoardsError(error); }
}
