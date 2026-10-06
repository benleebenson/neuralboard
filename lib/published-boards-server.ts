import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { PUBLISHED_BOARDS_BUCKET, PUBLISHED_BOARDS_UNAVAILABLE } from "@/lib/published-boards";

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
