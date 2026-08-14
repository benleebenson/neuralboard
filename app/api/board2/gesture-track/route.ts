import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { logApiCost } from "@/lib/supabase";
import {
  GESTURE_NAMES,
  applyGestureDwellRules,
  parseGestureTrackResponse,
} from "@/lib/character/gestures";

export const runtime = "nodejs";
export const maxDuration = 60;

const GESTURE_MODEL = "gpt-4o-mini";
const INPUT_USD_PER_MILLION_TOKENS = 0.15;
const OUTPUT_USD_PER_MILLION_TOKENS = 0.60;

type TimedSegment = { start: number; end: number; text: string };

function cleanSegments(value: unknown, startTime: number, endTime: number): TimedSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): TimedSegment[] => {
    if (!raw || typeof raw !== "object") return [];
    const segment = raw as { start?: unknown; end?: unknown; text?: unknown };
    const start = Math.max(startTime, Number(segment.start));
    const end = Math.min(endTime, Number(segment.end));
    const text = typeof segment.text === "string" ? segment.text.replace(/\s+/g, " ").trim() : "";
    return Number.isFinite(start) && Number.isFinite(end) && end > start && text ? [{ start, end, text }] : [];
  }).sort((a, b) => a.start - b.start || a.end - b.end);
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!await isUserPro(session)) return NextResponse.json({ error: "Pro subscription required" }, { status: 403 });

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

    const raw: unknown = await req.json();
    const body = raw && typeof raw === "object"
      ? raw as { transcript?: unknown; segments?: unknown; transcriptStart?: unknown; transcriptEnd?: unknown }
      : {};
    const transcript = typeof body.transcript === "string" ? body.transcript.replace(/\s+/g, " ").trim() : "";
    const transcriptStart = Number(body.transcriptStart);
    const transcriptEnd = Number(body.transcriptEnd);
    if (!transcript) return NextResponse.json({ error: "transcript is required" }, { status: 400 });
    if (!Number.isFinite(transcriptStart) || !Number.isFinite(transcriptEnd) || transcriptEnd <= transcriptStart) {
      return NextResponse.json({ error: "valid transcript bounds are required" }, { status: 400 });
    }
    const segments = cleanSegments(body.segments, transcriptStart, transcriptEnd);
    const timedTranscript = segments.length
      ? segments.map((segment) => `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}`).join("\n")
      : `[${transcriptStart.toFixed(2)}-${transcriptEnd.toFixed(2)}] ${transcript}`;
    const system = `Tag restrained held-pose gestures for a narrated character. Return ONLY a valid JSON array with this exact item shape: [{"start":number,"end":number,"gesture":"neutral|open|pointUp|thinking|self|outward|shrug"}].

Use exactly these seven names: ${GESTURE_NAMES.join(", ")}.
- self for first-person language.
- thinking for questions or hedging.
- outward for contrast or pivots.
- pointUp for emphasis or a key takeaway.
- shrug for dismissal or uncertainty.
- open for enumeration or welcoming explanation.
- neutral for rests.

Use absolute seconds within ${transcriptStart.toFixed(2)}-${transcriptEnd.toFixed(2)}. Keep the performance calm and sparse. Do not return Markdown, a wrapper object, reasoning, or any keys besides start, end, gesture.`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: GESTURE_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `FULL TRANSCRIPT:\n${transcript}\n\nTIMED TRANSCRIPT:\n${timedTranscript}` },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(50_000),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const apiMessage = data && typeof data === "object" && "error" in data
        ? (data as { error?: { message?: unknown } }).error?.message
        : null;
      return NextResponse.json(
        { error: typeof apiMessage === "string" ? apiMessage : `Smart gesture generation failed (${response.status})` },
        { status: 502 },
      );
    }
    const completion = data && typeof data === "object"
      ? data as {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        }
      : {};
    const responseText = typeof completion.choices?.[0]?.message?.content === "string"
      ? completion.choices[0].message.content
      : "";
    const parsed = parseGestureTrackResponse(responseText, transcriptStart, transcriptEnd);
    if (!parsed.length) {
      return NextResponse.json({ error: "Smart gestures returned malformed JSON" }, { status: 502 });
    }
    const track = applyGestureDwellRules(parsed, transcriptStart, transcriptEnd);
    if (!track.some((point) => point.gesture !== "neutral")) {
      return NextResponse.json({ error: "Smart gestures returned no valid gesture spans" }, { status: 502 });
    }

    const usage = completion.usage ?? {};
    const costUsd = +(
      (usage.prompt_tokens ?? 0) * INPUT_USD_PER_MILLION_TOKENS / 1_000_000
      + (usage.completion_tokens ?? 0) * OUTPUT_USD_PER_MILLION_TOKENS / 1_000_000
    ).toFixed(6);
    logApiCost(session.user.email, "board2-smart-gestures", costUsd, {
      model: GESTURE_MODEL,
      units: usage.total_tokens ?? 0,
    }).catch(() => {});

    return NextResponse.json({ ok: true, model: GESTURE_MODEL, track });
  } catch (error: unknown) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const message = error instanceof Error ? error.message : "Smart gesture generation failed";
    return NextResponse.json({ error: timeout ? "Smart gesture generation timed out" : message }, { status: timeout ? 504 : 500 });
  }
}
