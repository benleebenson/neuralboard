import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

const MEDIA_BUCKET = "joinable-board-media";
const BOARDS_PER_RUN = 200;
const LIST_PAGE = 1000;

function secretMatches(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Callers: an external cron sends `x-cleanup-secret: $CLEANUP_SECRET`; Vercel Cron (vercel.json)
// can't set custom headers and instead sends `Authorization: Bearer $CRON_SECRET`.
function authorized(request: Request): boolean {
  return secretMatches(request.headers.get("x-cleanup-secret"), process.env.CLEANUP_SECRET) ||
    secretMatches(request.headers.get("authorization"), process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : undefined);
}

// Deletes anonymous boards past their expiry: their shared images (stored under `{board id}/`)
// first, then the rows. Account-owned boards have no expiry and are never touched. Runs in
// batches; `more: true` means another call would find further expired boards.
async function cleanupExpired(request: Request) {
  if (!process.env.CLEANUP_SECRET && !process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Cleanup is not configured." }, { status: 503 });
  }
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const supabase = getSupabase();
    const { data: boards, error } = await supabase.from("joinable_boards")
      .select("id").is("owner_email", null).lt("expires_at", new Date().toISOString())
      .limit(BOARDS_PER_RUN);
    if (error) throw error;
    let deletedFiles = 0;
    const deletedBoardIds: string[] = [];
    for (const board of boards ?? []) {
      try {
        for (;;) {
          const { data: objects, error: listError } = await supabase.storage.from(MEDIA_BUCKET).list(board.id, { limit: LIST_PAGE });
          if (listError) throw listError;
          if (!objects?.length) break;
          const { error: removeError } = await supabase.storage.from(MEDIA_BUCKET).remove(objects.map((object) => `${board.id}/${object.name}`));
          if (removeError) throw removeError;
          deletedFiles += objects.length;
          if (objects.length < LIST_PAGE) break;
        }
        deletedBoardIds.push(board.id);
      } catch (mediaError) {
        // Keep the row so its media is retried next run instead of being orphaned.
        console.error("CLEANUP_EXPIRED_MEDIA_FAIL", board.id, mediaError);
      }
    }
    if (deletedBoardIds.length) {
      const { error: deleteError } = await supabase.from("joinable_boards").delete().in("id", deletedBoardIds).is("owner_email", null);
      if (deleteError) throw deleteError;
    }
    return NextResponse.json({
      deletedBoards: deletedBoardIds.length,
      deletedFiles,
      failedBoards: (boards?.length ?? 0) - deletedBoardIds.length,
      more: (boards?.length ?? 0) === BOARDS_PER_RUN,
    });
  } catch (error) {
    console.error("CLEANUP_EXPIRED_FAIL", error);
    return NextResponse.json({ error: "Cleanup failed." }, { status: 500 });
  }
}

export const GET = cleanupExpired;
export const POST = cleanupExpired;
