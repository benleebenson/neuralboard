import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { cloudDeadline, cloudError, projectOwner } from "@/lib/project-api";

export async function GET() {
  const owner = await projectOwner();
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { data, error } = await cloudDeadline(getSupabase().from("projects").select("*").eq("owner", owner).order("updated_at", { ascending: false }));
    if (error) throw error;
    return NextResponse.json(data ?? []);
  } catch (error) { return cloudError(error); }
}

export async function POST(request: Request) {
  const owner = await projectOwner();
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const name = String(body?.name ?? "").trim().slice(0, 160);
  if (!name) return NextResponse.json({ error: "Project name is required" }, { status: 400 });
  try {
    const { data, error } = await cloudDeadline(getSupabase().from("projects").insert({
      name, owner,
      source_audio_name: body?.sourceAudioName ? String(body.sourceAudioName).slice(0, 255) : null,
      source_audio_type: body?.sourceAudioType ? String(body.sourceAudioType).slice(0, 100) : null,
      source_audio_size: Number.isFinite(body?.sourceAudioSize) ? body.sourceAudioSize : null,
      source_audio_duration: Number.isFinite(body?.sourceAudioDuration) ? body.sourceAudioDuration : null,
    }).select("*").single());
    if (error) throw error;
    return NextResponse.json(data, { status: 201 });
  } catch (error) { return cloudError(error); }
}
