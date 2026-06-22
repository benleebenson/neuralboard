import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

const YT_URL_RE = /^https:\/\/(www\.)?youtube\.com\/watch\?.*v=[\w-]{11}/;
const YT_SHORT_RE = /^https:\/\/youtu\.be\/[\w-]{11}/;

function isYouTubeUrl(url: string): boolean {
  return YT_URL_RE.test(url) || YT_SHORT_RE.test(url);
}

export async function POST(req: NextRequest) {
  try {
    const { youtubeId, url: ytUrlParam, start, end } = await req.json();
    if (!youtubeId && !ytUrlParam) {
      return NextResponse.json({ error: "Missing youtubeId or url" }, { status: 400 });
    }

    const railwayUrl = process.env.RAILWAY_URL ?? process.env.NEXT_PUBLIC_RAILWAY_URL;
    const password = process.env.NEURALBOARD_PASSWORD;

    if (!railwayUrl || !password) {
      return NextResponse.json({ error: "Railway backend not configured" }, { status: 500 });
    }

    const ytUrl = ytUrlParam ?? `https://www.youtube.com/watch?v=${youtubeId}`;

    if (!isYouTubeUrl(ytUrl)) {
      return NextResponse.json({ error: "Only YouTube URLs are supported" }, { status: 400 });
    }
    const body: { url: string; start?: number; end?: number } = { url: ytUrl };
    if (typeof start === "number") body.start = start;
    if (typeof end === "number") body.end = end;

    const ytdlRes = await fetch(`${railwayUrl}/ytdl`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-neuralboard-password": password,
      },
      body: JSON.stringify(body),
    });

    if (!ytdlRes.ok) {
      const errText = await ytdlRes.text().catch(() => "");
      return NextResponse.json({ error: `ytdl error: ${errText}` }, { status: 500 });
    }

    const { id } = await ytdlRes.json();

    const fileRes = await fetch(`${railwayUrl}/ytdl-file/${id}`, {
      headers: { "x-neuralboard-password": password },
    });

    if (!fileRes.ok) {
      return NextResponse.json(
        { error: `ytdl-file error ${fileRes.status}` },
        { status: 500 }
      );
    }

    return new Response(fileRes.body, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="beat-${id}.mp4"`,
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
