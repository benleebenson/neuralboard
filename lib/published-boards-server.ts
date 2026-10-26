import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import {
  PUBLISHED_BOARDS_BUCKET,
  PUBLISHED_BOARDS_UNAVAILABLE,
  PUBLISHED_PACKAGE_MAX_BYTES,
  PUBLISHED_PREVIEW_MAX_BYTES,
  PUBLISHED_STORAGE_BUDGET_BYTES,
} from "@/lib/published-boards";

export function publishedBoardsError(error: unknown) {
  console.error("PUBLISHED_BOARDS_FAIL", error);
  return NextResponse.json({ error: PUBLISHED_BOARDS_UNAVAILABLE }, { status: 503 });
}

/** The signed-in user's email from the server session; the client never supplies the owner. */
export async function sessionEmail(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.email ?? null;
}

/** Every object stored for a publication lives under `<id>/<version>/`. */
export async function publishedBoardObjects(id: string): Promise<string[]> {
  const storage = getSupabase().storage.from(PUBLISHED_BOARDS_BUCKET);
  const { data: versions, error } = await storage.list(id, { limit: 100 });
  if (error) throw error;
  const paths: string[] = [];
  for (const version of versions ?? []) {
    const { data: files, error: filesError } = await storage.list(`${id}/${version.name}`, { limit: 100 });
    if (filesError) throw filesError;
    for (const file of files ?? []) paths.push(`${id}/${version.name}/${file.name}`);
  }
  return paths;
}

export async function removePublishedObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await getSupabase().storage.from(PUBLISHED_BOARDS_BUCKET).remove(paths);
  if (error) throw error;
}

const noStore = { "Cache-Control": "no-store" };

/**
 * Makes an uploaded version (`<id>/<version>/board.nbp` + `preview.webp`) the live publication once
 * the caller has checked who may publish row `id`: verifies both files exist and fit the limits and
 * the storage budget, lists the board, and drops earlier versions. `extra` adds columns to set.
 */
export async function completePublishedUpload(id: string, version: string, title: string, extra: Record<string, unknown> = {}): Promise<NextResponse> {
  const supabase = getSupabase();
  const storage = supabase.storage.from(PUBLISHED_BOARDS_BUCKET);
  const versionPaths = [`${id}/${version}/board.nbp`, `${id}/${version}/preview.webp`];
  const { data: files, error: listError } = await storage.list(`${id}/${version}`, { limit: 10 });
  if (listError) throw listError;
  const sizeOf = (name: string) => Number((files ?? []).find((file) => file.name === name)?.metadata?.size ?? -1);
  const packageSize = sizeOf("board.nbp");
  const previewSize = sizeOf("preview.webp");
  if (packageSize <= 0 || previewSize <= 0) return NextResponse.json({ error: "The upload did not finish. Please try again." }, { status: 409 });
  if (packageSize > PUBLISHED_PACKAGE_MAX_BYTES || previewSize > PUBLISHED_PREVIEW_MAX_BYTES) {
    await removePublishedObjects(versionPaths);
    return NextResponse.json({ error: "This board is too large to publish." }, { status: 413 });
  }
  const { data: others, error: othersError } = await supabase.from("published_boards").select("size_bytes").neq("id", id);
  if (othersError) throw othersError;
  const used = (others ?? []).reduce((sum, other) => sum + Number(other.size_bytes || 0), 0);
  if (used + packageSize + previewSize > PUBLISHED_STORAGE_BUDGET_BYTES) {
    await removePublishedObjects(versionPaths);
    return NextResponse.json({ error: "Published board storage is full. Please try again later." }, { status: 507 });
  }
  const { data: current, error: currentError } = await supabase.from("published_boards").select("published_at").eq("id", id).maybeSingle();
  if (currentError) throw currentError;
  const now = new Date().toISOString();
  const { error: updateError } = await supabase.from("published_boards").update({
    title,
    package_path: versionPaths[0],
    preview_path: versionPaths[1],
    size_bytes: packageSize + previewSize,
    published_at: current?.published_at ?? now,
    updated_at: now,
    ...extra,
  }).eq("id", id);
  if (updateError) throw updateError;
  // Drop earlier versions of this board, and uploads abandoned before completing.
  const stale = (await publishedBoardObjects(id)).filter((path) => !versionPaths.includes(path));
  await removePublishedObjects(stale).catch((error) => console.error("PUBLISHED_BOARDS_CLEANUP_FAIL", error));
  return NextResponse.json({ ok: true, sizeBytes: packageSize + previewSize }, { headers: noStore });
}

/** Takes an anonymous board's publication (keyed by its join code) off the feed and deletes its files. */
export async function unpublishJoinCodes(codes: string[]): Promise<void> {
  if (codes.length === 0) return;
  const { data, error } = await getSupabase().from("published_boards").delete().in("join_code", codes).select("id");
  // Before 20261026_anonymous_published_boards.sql there is no join_code column and nothing to remove.
  if (error?.code === "42703") return;
  if (error) throw error;
  for (const row of data ?? []) await removePublishedObjects(await publishedBoardObjects(row.id));
}
