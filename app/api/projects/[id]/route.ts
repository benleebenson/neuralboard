import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { cloudDeadline, cloudError, projectOwner } from "@/lib/project-api";

export async function GET(_request: Request, context: RouteContext<"/api/projects/[id]">) {
  const owner = await projectOwner();
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const { data, error } = await cloudDeadline(getSupabase().from("projects")
      .select("*, clips(*), project_images(*)").eq("id", id).eq("owner", owner).maybeSingle());
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    data.clips?.sort((a: { start_time: number }, b: { start_time: number }) => a.start_time - b.start_time);
    data.project_images?.sort((a: { uploaded_at: string }, b: { uploaded_at: string }) => b.uploaded_at.localeCompare(a.uploaded_at));
    return NextResponse.json(data);
  } catch (error) { return cloudError(error); }
}
