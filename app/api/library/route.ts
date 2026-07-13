import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export async function GET() {
  const supabase = getSupabase();
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data, error } = await supabase
    .from("library_videos")
    .select("*")
    .eq("email", session.user.email)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const supabase = getSupabase();
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const { youtube_url, youtube_video_id, title, thumbnail_url, duration_seconds } = body as {
    youtube_url?: string;
    youtube_video_id?: string;
    title?: string;
    thumbnail_url?: string;
    duration_seconds?: number;
  };
  if (!youtube_video_id) {
    return NextResponse.json({ error: "Missing youtube_video_id" }, { status: 400 });
  }
  const { error } = await supabase.from("library_videos").upsert({
    email: session.user.email,
    youtube_url: youtube_url ?? "",
    youtube_video_id,
    title: title ?? "",
    thumbnail_url: thumbnail_url ?? "",
    duration_seconds: duration_seconds ?? 0,
  }, { onConflict: "email,youtube_video_id", ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const supabase = getSupabase();
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const { error } = await supabase
    .from("library_videos")
    .delete()
    .eq("id", id)
    .eq("email", session.user.email);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
