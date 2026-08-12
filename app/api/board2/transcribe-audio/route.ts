import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { logApiCost } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

const WHISPER_FILE_LIMIT_BYTES = 25 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const isPro = await isUserPro(session);
    if (!isPro) {
      return NextResponse.json({ error: "Pro subscription required" }, { status: 403 });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
    }

    const formData = await req.formData();
    const audioFile = formData.get("audio") as File | null;
    if (!audioFile) {
      return NextResponse.json({ error: "No audio file provided" }, { status: 400 });
    }
    // Vercel enforces its non-configurable 4.5 MB Function payload limit before this handler.
    // Board 2 sends ~60 second mono 16 kHz chunks (~1.9 MB); this guard is Whisper's own limit.
    if (audioFile.size > WHISPER_FILE_LIMIT_BYTES) {
      return NextResponse.json({ error: "File too large for Whisper (max 25MB)" }, { status: 413 });
    }

    // Determine extension from MIME type
    const mime = audioFile.type || "";
    const ext =
      mime.includes("mp4") || mime.includes("m4a") ? ".m4a"
      : mime.includes("mp3") || mime.includes("mpeg") ? ".mp3"
      : mime.includes("wav") ? ".wav"
      : mime.includes("ogg") ? ".ogg"
      : ".webm";

    const whisperForm = new FormData();
    // Re-name the file with the correct extension so Whisper accepts it
    whisperForm.append("file", audioFile, `audio${ext}`);
    whisperForm.append("model", "whisper-1");
    whisperForm.append("response_format", "verbose_json");

    const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: whisperForm,
    });

    if (!whisperRes.ok) {
      const err = await whisperRes.json().catch(() => ({}));
      return NextResponse.json(
        { error: err?.error?.message || `Whisper error ${whisperRes.status}` },
        { status: 500 }
      );
    }

    const data = await whisperRes.json();
    const transcript: string = data.text ?? "";
    const durationSec: number = data.duration ?? 0;
    // verbose_json segments carry per-segment start/end timestamps — needed by callers (e.g.
    // character choreography) that time actions to moments in the narration. Trim to just the
    // fields callers need rather than passing through Whisper's full segment object.
    const segments: Array<{ start: number; end: number; text: string }> = Array.isArray(data.segments)
      ? data.segments.map((s: { start?: number; end?: number; text?: string }) => ({
          start: s.start ?? 0,
          end: s.end ?? 0,
          text: s.text ?? "",
        }))
      : [];

    // Whisper cost: ~$0.006/min
    logApiCost(session.user.email, "whisper-board2", +(durationSec * 0.0001).toFixed(5), {
      model: "whisper-1",
      units: durationSec,
    }).catch(() => {});

    return NextResponse.json({ transcript, durationSec, segments });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
