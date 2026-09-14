import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { logApiCost } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "gpt-4o";
const MIN_CLIP_SECONDS = 20;
const MAX_CLIP_SECONDS = 90;
const DEFAULT_COUNT = 5;

type IdentifiedClip = { id: string; title: string; startSec: number; endSec: number; hook: string };

function jsonCandidate(text: string): unknown {
  const clean = text.replace(/^﻿/, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(clean); } catch { return null; }
}

function dedupeOverlapping(clips: IdentifiedClip[]): IdentifiedClip[] {
  return clips.filter((clip, index, sorted) => !sorted.slice(0, index).some((prior) => {
    const overlap = Math.max(0, Math.min(prior.endSec, clip.endSec) - Math.max(prior.startSec, clip.startSec));
    return overlap / Math.min(prior.endSec - prior.startSec, clip.endSec - clip.startSec) >= 0.6;
  }));
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!await isUserPro(session)) return NextResponse.json({ error: "Pro subscription required" }, { status: 403 });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

    const body = await req.json().catch(() => null) as { transcript?: unknown; durationSeconds?: unknown; count?: unknown } | null;
    const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
    const durationSeconds = Number(body?.durationSeconds);
    const count = Number.isFinite(Number(body?.count)) ? Math.min(10, Math.max(1, Math.round(Number(body?.count)))) : DEFAULT_COUNT;
    if (!transcript) return NextResponse.json({ error: "A narration transcript is required" }, { status: 400 });
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return NextResponse.json({ error: "A valid durationSeconds is required" }, { status: 400 });

    const systemPrompt = `You are selecting the best highlight clips from a video's narration transcript to repurpose as standalone short-form vertical (9:16) clips. Each transcript line is timestamped in seconds from the start of the video. Find moments that work as complete, standalone thoughts — a strong hook, a punchy claim, a story with a payoff, a surprising fact. Each clip's spoken content must run from ${MIN_CLIP_SECONDS} to ${MAX_CLIP_SECONDS} seconds. Start and end every clip at a natural speech boundary — never mid-sentence or mid-thought. The video is ${durationSeconds.toFixed(1)} seconds long; every startSec/endSec must fall within that range. Return up to ${count} of the strongest, non-overlapping clips — fewer is fine if there aren't ${count} genuinely good candidates. Return STRICT JSON ONLY, no Markdown or prose: {"clips":[{"title":"short punchy title","startSec":12.3,"endSec":54.1,"hook":"one sentence on why this works as a standalone clip"}]}`;
    const userPrompt = `TIMESTAMPED NARRATION TRANSCRIPT:\n${transcript}`;

    const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(50_000),
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    const gptData = await gptRes.json().catch(() => null) as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    if (!gptRes.ok) {
      return NextResponse.json({ error: gptData?.error?.message || `AI error ${gptRes.status}` }, { status: 500 });
    }

    const promptTokens = gptData?.usage?.prompt_tokens ?? 0;
    const completionTokens = gptData?.usage?.completion_tokens ?? 0;
    const cost = +(promptTokens * 2.5 / 1_000_000 + completionTokens * 10 / 1_000_000).toFixed(6);
    logApiCost(session.user.email, "identify-clips", cost, { model: MODEL, units: promptTokens + completionTokens }).catch(() => {});

    const parsed = jsonCandidate(gptData?.choices?.[0]?.message?.content ?? "");
    const rows = parsed && typeof parsed === "object" && Array.isArray((parsed as { clips?: unknown }).clips)
      ? (parsed as { clips: unknown[] }).clips
      : [];

    let clips: IdentifiedClip[] = rows.flatMap((raw, index): IdentifiedClip[] => {
      if (!raw || typeof raw !== "object") return [];
      const row = raw as Record<string, unknown>;
      const startSec = Number(row.startSec);
      const endSec = Number(row.endSec);
      const title = typeof row.title === "string" ? row.title.trim().slice(0, 100) : "";
      const hook = typeof row.hook === "string" ? row.hook.trim().slice(0, 300) : "";
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !title) return [];
      if (startSec < 0 || endSec > durationSeconds + 0.5 || endSec <= startSec) return [];
      const dur = endSec - startSec;
      if (dur < MIN_CLIP_SECONDS - 5 || dur > MAX_CLIP_SECONDS + 15) return [];
      return [{
        id: `clip_${Date.now()}_${index}`,
        title,
        startSec,
        endSec: Math.min(durationSeconds, endSec),
        hook: hook || title,
      }];
    }).sort((a, b) => a.startSec - b.startSec);

    clips = dedupeOverlapping(clips).slice(0, count);

    return NextResponse.json({ clips });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json({ error: timeout ? "Clip identification timed out" : error instanceof Error ? error.message : "Clip identification failed" }, { status: timeout ? 504 : 500 });
  }
}
