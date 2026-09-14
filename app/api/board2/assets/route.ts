import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { saveAsset, listAssets, type AssetType } from "@/lib/supabase";

export const runtime = "nodejs";

function isAssetType(value: unknown): value is AssetType {
  return value === "image" || value === "youtube";
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const typeParam = req.nextUrl.searchParams.get("type");
  const type = isAssetType(typeParam) ? typeParam : undefined;
  try {
    const assets = await listAssets(session.user.email, type);
    return NextResponse.json({ assets });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load assets" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const type = body?.type;
  if (!isAssetType(type)) return NextResponse.json({ error: "type must be 'image' or 'youtube'" }, { status: 400 });

  const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim().slice(0, 2000) : null;
  const youtubeId = typeof body?.youtubeId === "string" && body.youtubeId.trim() ? body.youtubeId.trim().slice(0, 64) : null;
  const rawThumbnail = typeof body?.thumbnailUrl === "string" && body.thumbnailUrl.trim() ? body.thumbnailUrl.trim().slice(0, 2000) : null;
  const thumbnailUrl = rawThumbnail ?? (type === "image" ? url : youtubeId ? `https://img.youtube.com/vi/${youtubeId}/mqdefault.jpg` : null);
  const ytStartNum = Number(body?.ytStart);
  const ytEndNum = Number(body?.ytEnd);
  const ytStart = Number.isFinite(ytStartNum) ? ytStartNum : null;
  const ytEnd = Number.isFinite(ytEndNum) ? ytEndNum : null;
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 200) || null : null;
  const source = typeof body?.source === "string" ? body.source.trim().slice(0, 40) || null : null;

  if (type === "image" && !url) return NextResponse.json({ error: "url is required for image assets" }, { status: 400 });
  if (type === "youtube" && !youtubeId) return NextResponse.json({ error: "youtubeId is required for youtube assets" }, { status: 400 });

  try {
    const asset = await saveAsset(session.user.email, { type, url, thumbnailUrl, youtubeId, ytStart, ytEnd, label, source });
    return NextResponse.json({ asset });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save asset" }, { status: 500 });
  }
}
