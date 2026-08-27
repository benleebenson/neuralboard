import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { logApiCost } from "@/lib/supabase";
import { buildClipAnalysisWindows, buildClipSelectionPrompt, CLIP_FINDER_MODEL, dedupeClipSuggestions, parseClipSuggestions } from "@/lib/clip-finder/selection";
import type { TranscriptSegment } from "@/lib/audio/transcription";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!await isUserPro(session)) return NextResponse.json({ error: "Pro subscription required" }, { status: 403 });
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
    const body = await request.json() as { transcript?: unknown; durationSec?: unknown; segments?: unknown };
    const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
    const durationSec = Number(body.durationSec);
    const segments: TranscriptSegment[] = Array.isArray(body.segments) ? body.segments.flatMap((raw): TranscriptSegment[] => {
      if (!raw || typeof raw !== "object") return [];
      const row = raw as Record<string, unknown>; const start = Number(row.start); const end = Number(row.end);
      const text = typeof row.text === "string" ? row.text.replace(/\s+/g, " ").trim() : "";
      return Number.isFinite(start) && Number.isFinite(end) && end > start && text ? [{ start, end, text }] : [];
    }) : [];
    if (!transcript || !Number.isFinite(durationSec) || durationSec <= 0 || !segments.length) return NextResponse.json({ error: "A timestamped transcript is required" }, { status: 400 });

    const windows = buildClipAnalysisWindows(durationSec);
    let promptTokens = 0; let completionTokens = 0;
    const results = await Promise.all(windows.map(async (window) => {
      const prompt = buildClipSelectionPrompt({ transcript, segments, durationSec, ...(windows.length > 1 ? { window } : {}) });
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, cache: "no-store",
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ model: CLIP_FINDER_MODEL, reasoning_effort: "low", max_completion_tokens: 5000, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }] }),
      });
      const data = await response.json().catch(() => null) as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
      if (!response.ok) throw new Error(data?.error?.message || `Clip analysis failed (${response.status})`);
      promptTokens += data?.usage?.prompt_tokens ?? 0; completionTokens += data?.usage?.completion_tokens ?? 0;
      return parseClipSuggestions(data?.choices?.[0]?.message?.content ?? "", durationSec).filter((clip) => clip.startTime >= window.startTime && clip.startTime < window.endTime + 0.01);
    }));
    const clips = dedupeClipSuggestions(results.flat());
    const cost = +(promptTokens * 0.25 / 1_000_000 + completionTokens * 2 / 1_000_000).toFixed(6);
    logApiCost(session.user.email, "clip-finder", cost, { model: CLIP_FINDER_MODEL, units: promptTokens + completionTokens }).catch(() => {});
    if (!clips.length) return NextResponse.json({ error: "The clip selector found no strong standalone clips (or returned invalid JSON)." }, { status: 422 });
    return NextResponse.json({ ok: true, clips, model: CLIP_FINDER_MODEL, analysisChunks: windows.length });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json({ error: timeout ? "Clip analysis timed out" : error instanceof Error ? error.message : "Clip analysis failed" }, { status: timeout ? 504 : 500 });
  }
}
