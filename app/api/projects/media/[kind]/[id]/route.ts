import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { cloudDeadline, cloudError, projectOwner } from "@/lib/project-api";

export async function GET(_request: Request, context: RouteContext<"/api/projects/media/[kind]/[id]">) {
  const owner = await projectOwner(); if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { kind, id } = await context.params;
  if (kind !== "clip" && kind !== "image") return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const supabase = getSupabase(); const table = kind === "clip" ? "clips" : "project_images"; const pathColumn = kind === "clip" ? "audio_storage_path" : "storage_path";
    const result = await cloudDeadline(supabase.from(table).select(`${pathColumn}, projects!inner(owner)`).eq("id", id).eq("projects.owner", owner).maybeSingle());
    if (result.error) throw result.error; if (!result.data) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const path = String((result.data as unknown as Record<string, unknown>)[pathColumn]);
    const signed = await cloudDeadline(supabase.storage.from(kind === "clip" ? "project-clips" : "project-images").createSignedUrl(path, 60));
    if (signed.error) throw signed.error;
    return NextResponse.redirect(signed.data.signedUrl, { status: 307, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return cloudError(error); }
}
