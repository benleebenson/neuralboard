import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import {
  PUBLISHED_BOARDS_BUCKET,
  PUBLISHED_KEY_MAX,
  PUBLISHED_PACKAGE_MAX_BYTES,
  PUBLISHED_PREVIEW_MAX_BYTES,
  PUBLISHED_STORAGE_BUDGET_BYTES,
  PUBLISHED_TITLE_MAX,
  formatMegabytes,
  type PublishedBoardCard,
  type PublishStart,
} from "@/lib/published-boards";
import { publishedBoardsError, sessionEmail } from "@/lib/published-boards-server";

const PER_USER_MAX = 25;
const noStore = { "Cache-Control": "no-store" };

/** Home feed: every published board, newest first. Open to everyone, signed in or not. */
export async function GET() {
  try {
    const { data, error } = await getSupabase()
      .from("published_boards")
      .select("id,title,published_at")
      .not("published_at", "is", null)
      .not("package_path", "is", null)
      .order("published_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    const boards: PublishedBoardCard[] = (data ?? []).map((row) => ({ id: row.id, title: row.title, publishedAt: row.published_at }));
    return NextResponse.json({ boards }, { headers: noStore });
  } catch (error) { return publishedBoardsError(error); }
}

/**
 * Starts publishing (or republishing) one of the signed-in user's boards: reserves the row and
 * returns signed upload URLs so the browser uploads straight to Storage with progress. Nothing
 * appears in the feed until PATCH /api/published-boards/[id] verifies the upload.
 */
export async function POST(request: Request) {
  try {
    const email = await sessionEmail();
    if (!email) return NextResponse.json({ error: "Sign in to publish a board." }, { status: 401 });
    const body = await request.json().catch(() => null) as { boardKey?: unknown; title?: unknown; packageBytes?: unknown; previewBytes?: unknown } | null;
    const boardKey = typeof body?.boardKey === "string" ? body.boardKey.trim() : "";
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, PUBLISHED_TITLE_MAX) : "";
    const packageBytes = Number(body?.packageBytes);
    const previewBytes = Number(body?.previewBytes);
    if (!boardKey || boardKey.length > PUBLISHED_KEY_MAX || !title || !Number.isFinite(packageBytes) || !Number.isFinite(previewBytes) || packageBytes <= 0 || previewBytes <= 0) {
      return NextResponse.json({ error: "Invalid board." }, { status: 400 });
    }
    if (packageBytes > PUBLISHED_PACKAGE_MAX_BYTES) {
      return NextResponse.json({ error: `This board is ${formatMegabytes(packageBytes)} after compression; published boards must be under ${formatMegabytes(PUBLISHED_PACKAGE_MAX_BYTES)}. Long narration is usually the cause.` }, { status: 413 });
    }
    if (previewBytes > PUBLISHED_PREVIEW_MAX_BYTES) return NextResponse.json({ error: "The board preview is too large." }, { status: 413 });

    const supabase = getSupabase();
    const { data: rows, error: rowsError } = await supabase.from("published_boards").select("owner_email,board_key,size_bytes,published_at");
    if (rowsError) throw rowsError;
    const others = (rows ?? []).filter((row) => !(row.owner_email === email && row.board_key === boardKey));
    if (others.filter((row) => row.owner_email === email && row.published_at).length >= PER_USER_MAX) {
      return NextResponse.json({ error: `You can publish up to ${PER_USER_MAX} boards. Turn one off to publish this one.` }, { status: 409 });
    }
    const used = others.reduce((sum, row) => sum + Number(row.size_bytes || 0), 0);
    if (used + packageBytes + previewBytes > PUBLISHED_STORAGE_BUDGET_BYTES) {
      return NextResponse.json({ error: "Published board storage is full. Please try again later." }, { status: 507 });
    }

    // Reserve the (owner, board) row without touching a live publication's title or files.
    const { error: insertError } = await supabase.from("published_boards").upsert({ owner_email: email, board_key: boardKey, title }, { onConflict: "owner_email,board_key", ignoreDuplicates: true });
    if (insertError) throw insertError;
    const { data: row, error: rowError } = await supabase.from("published_boards").select("id").eq("owner_email", email).eq("board_key", boardKey).single();
    if (rowError) throw rowError;

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
