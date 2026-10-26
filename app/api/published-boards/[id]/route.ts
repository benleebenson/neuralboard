import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { PUBLISHED_BOARDS_BUCKET, PUBLISHED_TITLE_MAX, validPublishedBoardId } from "@/lib/published-boards";
import { completePublishedUpload, publishedBoardObjects, publishedBoardsError, removePublishedObjects, sessionEmail } from "@/lib/published-boards-server";

const noStore = { "Cache-Control": "no-store" };
const notFound = () => NextResponse.json({ error: "That board is not published." }, { status: 404, headers: noStore });

/** Read-only view: the board's title and a short-lived signed URL for its package. Open to everyone. */
export async function GET(_request: Request, context: RouteContext<"/api/published-boards/[id]">) {
  try {
    const { id } = await context.params;
    if (!validPublishedBoardId(id)) return notFound();
    const supabase = getSupabase();
    const { data, error } = await supabase.from("published_boards").select("title,package_path,size_bytes,published_at").eq("id", id).not("published_at", "is", null).maybeSingle();
    if (error) throw error;
    if (!data?.package_path) return notFound();
    const signed = await supabase.storage.from(PUBLISHED_BOARDS_BUCKET).createSignedUrl(data.package_path, 600);
    if (signed.error) throw signed.error;
    return NextResponse.json({ title: data.title, sizeBytes: Number(data.size_bytes || 0), publishedAt: data.published_at, packageUrl: signed.data.signedUrl }, { headers: noStore });
  } catch (error) { return publishedBoardsError(error); }
}

/** Completes a publish once the browser's uploads finish. Only the board's owner may do this. */
export async function PATCH(request: Request, context: RouteContext<"/api/published-boards/[id]">) {
  try {
    const email = await sessionEmail();
    if (!email) return NextResponse.json({ error: "Sign in to publish a board." }, { status: 401 });
    const { id } = await context.params;
    const body = await request.json().catch(() => null) as { version?: unknown; title?: unknown } | null;
    const version = typeof body?.version === "string" ? body.version : "";
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, PUBLISHED_TITLE_MAX) : "";
    if (!validPublishedBoardId(id) || !validPublishedBoardId(version) || !title) return NextResponse.json({ error: "Invalid board." }, { status: 400 });

    const supabase = getSupabase();
    const versionPaths = [`${id}/${version}/board.nbp`, `${id}/${version}/preview.webp`];
    const { data: row, error: rowError } = await supabase.from("published_boards").select("id").eq("id", id).eq("owner_email", email).maybeSingle();
    if (rowError) throw rowError;
    if (!row) {
      // Turned off (row deleted) while uploading: the uploads now belong to no board, so discard them.
      const { data: anyRow } = await supabase.from("published_boards").select("id").eq("id", id).maybeSingle();
      if (!anyRow) await removePublishedObjects(versionPaths).catch(() => {});
      return NextResponse.json({ error: "Only the board's owner can publish it." }, { status: 404 });
    }

    return await completePublishedUpload(id, version, title);
  } catch (error) { return publishedBoardsError(error); }
}

/** Unpublishes: removes the board from the feed at once, then deletes its stored files. Owner only. */
export async function DELETE(_request: Request, context: RouteContext<"/api/published-boards/[id]">) {
  try {
    const email = await sessionEmail();
    if (!email) return NextResponse.json({ error: "Sign in to change a board." }, { status: 401 });
    const { id } = await context.params;
    if (!validPublishedBoardId(id)) return notFound();
    const { data, error } = await getSupabase().from("published_boards").delete().eq("id", id).eq("owner_email", email).select("id").maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Only the board's owner can unpublish it." }, { status: 404 });
    await removePublishedObjects(await publishedBoardObjects(id));
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (error) { return publishedBoardsError(error); }
}
