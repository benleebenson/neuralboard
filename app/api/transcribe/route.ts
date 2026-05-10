import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isAdmin } from "@/lib/auth";
import { getRenderCount, getSubscriptionStatus, upsertUser, logEvent, logApiCost } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

type Beat = {
  startTime: number;
  endTime: number;
  searchQuery: string;
  reasoning: string;
  images?: string[];
};

async function searchImages(query: string, apiKey: string): Promise<string[]> {
  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: query, num: 10 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.images || [])
      .map((img: { imageUrl?: string; thumbnailUrl?: string }) => img.imageUrl || img.thumbnailUrl || "")
      .filter((url: string) => url && url.startsWith("http"))
      .slice(0, 8);
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    // Auth check — must be signed in with Google
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const email = session.user.email;

    // Usage check — non-admin users get one free render unless subscribed
    if (!isAdmin(email)) {
      const [{ isSubscribed }, renderCount] = await Promise.all([
        getSubscriptionStatus(email),
        getRenderCount(email).catch(() => 0),
      ]);
      if (!isSubscribed && renderCount > 0) {
        return NextResponse.json(
          { error: "Free credit used. Upgrade to generate more videos." },
          { status: 403 }
        );
      }
    }

    // Ensure user exists in DB
    await upsertUser(email, session.user.name, session.user.image).catch(() => {});

    const audioBlob = await req.blob();

    if (audioBlob.size < 500) {
      return NextResponse.json(
        { error: "Audio file too small or empty" },
        { status: 400 }
      );
    }

    const openaiKey = process.env.OPENAI_API_KEY;
const serperKey = process.env.SERPER_API_KEY;
if (!openaiKey) {
  return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
}
if (!serperKey) {
  return NextResponse.json({ error: "SERPER_API_KEY not configured" }, { status: 500 });
}

    // ── Step 1: Whisper transcription with word timings ─────────────
    const formData = new FormData();
    formData.append("file", audioBlob, "audio.webm");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");
    formData.append("timestamp_granularities[]", "word");

    const whisperRes = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}` },
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

    const whisperData = await whisperRes.json();
    const transcript: string = whisperData.text || "";
    const words = whisperData.words || [];
    const duration: number =
      whisperData.duration ||
      (words.length ? words[words.length - 1].end + 0.3 : 10);

    // Whisper: $0.006/min
    logApiCost(email, "whisper", +(duration * 0.0001).toFixed(5), { model: "whisper-1", units: duration }).catch(() => {});

    if (!transcript.trim()) {
      return NextResponse.json({
        ok: true,
        transcript: "",
        duration,
        beats: [],
        message: "No speech detected",
      });
    }

    // ── Step 2: GPT-4o-mini plans the beats ─────────────────────────
    const targetBeats = Math.max(2, Math.round(duration / 2));

    const timedTranscript = words.length
      ? words
          .map((w: { word: string; start: number }) => `[${w.start.toFixed(1)}s] ${w.word}`)
          .join(" ")
      : transcript;

    const systemPrompt = `You are a video director AI. Given a narration transcript with word-level timestamps, plan a sequence of visual beats — moments where a new image should appear.

RULES:
- Aim for one beat every ~2 seconds. A ${duration.toFixed(1)}s narration should have ~${targetBeats} beats.
- Important moments (specific names, key claims, big topics) get longer holds: 2.5–4s.
- Quick mentions get shorter holds: 1–1.5s.
- Each beat's startTime must align with when its topic is FIRST mentioned.
- Beats are sequential and non-overlapping. beat[i].endTime must equal beat[i+1].startTime.
- First beat starts at 0. Last beat ends at ${duration.toFixed(1)}.
- Each beat's searchQuery must be 3–6 specific words suitable for Google Images. NOT generic.
  BAD: "business", "cars", "people"
  GOOD: "Tesla factory assembly line", "Austin Texas skyline aerial", "Elon Musk press conference"

Return ONLY JSON in this exact structure:
{"beats": [{"startTime": number, "endTime": number, "searchQuery": string, "reasoning": string}]}`;

    const planRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `NARRATION (${duration.toFixed(1)}s total):\n\n${timedTranscript}\n\nPlain transcript: "${transcript}"\n\nReturn approximately ${targetBeats} beats.`,
          },
        ],
      }),
    });

    if (!planRes.ok) {
      const err = await planRes.json().catch(() => ({}));
      return NextResponse.json(
        { error: err?.error?.message || `Planner error ${planRes.status}` },
        { status: 500 }
      );
    }

    const planData = await planRes.json();
    const planText = planData.choices?.[0]?.message?.content || "{}";

    // GPT-4o-mini: $0.00015/1K input, $0.0006/1K output
    const gptUsage = planData.usage ?? {};
    const gptCost = +((gptUsage.prompt_tokens ?? 0) / 1000 * 0.00015 + (gptUsage.completion_tokens ?? 0) / 1000 * 0.0006).toFixed(5);
    logApiCost(email, "gpt-4o-mini", gptCost, { model: "gpt-4o-mini", units: gptUsage.total_tokens ?? 0 }).catch(() => {});

    let beats: Beat[] = [];
    try {
      const parsed = JSON.parse(planText);
      beats = Array.isArray(parsed.beats) ? parsed.beats : [];
    } catch {
      beats = [];
    }

    // Normalize and clamp
    beats = beats
      .map((b, i) => ({
        startTime: Number(b.startTime) || i * (duration / Math.max(1, beats.length)),
        endTime: Number(b.endTime) || (i + 1) * (duration / Math.max(1, beats.length)),
        searchQuery: String(b.searchQuery || "").trim() || "generic image",
        reasoning: String(b.reasoning || ""),
      }))
      .sort((a, b) => a.startTime - b.startTime);

    for (let i = 0; i < beats.length; i++) {
      beats[i].startTime = Math.max(0, beats[i].startTime);
      if (i === 0) beats[i].startTime = 0;
      else beats[i].startTime = Math.max(beats[i - 1].endTime, beats[i].startTime);
      beats[i].endTime = Math.max(beats[i].startTime + 1, beats[i].endTime);
    }
    if (beats.length) beats[beats.length - 1].endTime = duration;

    // ── Step 3: Fetch images for every beat in parallel ─────────────
    const imageResults = await Promise.all(
      beats.map((b) => searchImages(b.searchQuery, serperKey))
    );
    beats.forEach((b, i) => {
      b.images = imageResults[i];
    });

    // Serper: ~$0.001/search
    logApiCost(email, "serper", +(beats.length * 0.001).toFixed(5), { units: beats.length }).catch(() => {});

    // Log the transcription usage
    await logEvent(email, "transcribe", duration).catch(() => {});

    return NextResponse.json({
      ok: true,
      transcript,
      duration,
      beats,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}