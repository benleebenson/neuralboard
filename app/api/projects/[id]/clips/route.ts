import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { cloudDeadline, cloudError, ownedProject, projectOwner } from "@/lib/project-api";

export async function POST(request: Request, context: RouteContext<"/api/projects/[id]/clips">) {
  const owner = await projectOwner();
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: projectId } = await context.params;
  try {
    const project = await ownedProject(projectId, owner);
    if (project.error) throw project.error;
    if (!project.data) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const form = await request.formData(); const audio = form.get("audio");
    if (!(audio instanceof File) || audio.type !== "audio/webm") return NextResponse.json({ error: "An Opus WebM audio file is required" }, { status: 400 });
    if (audio.size > 6 * 1024 * 1024) return NextResponse.json({ error: "Clip audio exceeds 6 MB" }, { status: 413 });
    const start = Number(form.get("startTime")); const end = Number(form.get("endTime"));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return NextResponse.json({ error: "Invalid clip time range" }, { status: 400 });
    const clipId = crypto.randomUUID(); const storagePath = `${projectId}/${clipId}.webm`; const supabase = getSupabase();
    const upload = await cloudDeadline(supabase.storage.from("project-clips").upload(storagePath, audio, { contentType: "audio/webm", upsert: false }));
    if (upload.error) throw upload.error;
    const inserted = await cloudDeadline(supabase.from("clips").insert({
      id: clipId, project_id: projectId, title: String(form.get("title") ?? "Clip").slice(0, 200), start_time: start, end_time: end,
      transcript: String(form.get("transcript") ?? ""), reason: String(form.get("reason") ?? ""), approved: true, audio_storage_path: storagePath,
    }).select("*").single());
    if (inserted.error) { await supabase.storage.from("project-clips").remove([storagePath]); throw inserted.error; }
    return NextResponse.json(inserted.data, { status: 201 });
  } catch (error) { return cloudError(error); }
}
