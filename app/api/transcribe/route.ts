import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const audioBlob = await req.blob();

    if (audioBlob.size < 500) {
      return NextResponse.json(
        { error: "Audio file too small or empty" },
        { status: 400 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY not configured" },
        { status: 500 }
      );
    }

    const formData = new FormData();
    formData.append("file", audioBlob, "audio.webm");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");

    const whisperRes = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      }
    );

    if (!whisperRes.ok) {
      const err = await whisperRes.json().catch(() => ({}));
      return NextResponse.json(
        { error: err?.error?.message || `Whisper error ${whisperRes.status}` },
        { status: 500 }
      );
    }

    const data = await whisperRes.json();
    return NextResponse.json({
      ok: true,
      transcript: data.text || "",
      duration: data.duration || 0,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
