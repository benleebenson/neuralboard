import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logApiCost } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "gpt-4o-mini";

export type ExtractedCharacter = {
  name: string;
  description: string;
  mentions: number;
  firstMentionTime: number | null;
};

function jsonCandidate(text: string): unknown {
  const clean = text.replace(/^﻿/, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(clean); } catch { return null; }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

    const body = await req.json().catch(() => null) as { transcript?: unknown } | null;
    const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
    if (!transcript) return NextResponse.json({ error: "A transcript is required" }, { status: 400 });

    const systemPrompt = `You are analyzing a narration transcript to identify named characters.

Extract every named person, character, or public figure mentioned. For each:
- name: their name as used in the transcript
- description: 1-sentence description based on how they're portrayed (tone, role, relationship to narrator)
- mentions: approximate count of how often they appear
- firstMentionTime: the timestamp (seconds) of their first mention if the transcript has timestamps, else null

Return STRICT JSON: { "characters": [{ "name": string, "description": string, "mentions": number, "firstMentionTime": number | null }] }
Only include actual named people/characters, not unnamed groups or abstract references.`;

    const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(50_000),
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: transcript },
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
    const cost = +(promptTokens * 0.15 / 1_000_000 + completionTokens * 0.6 / 1_000_000).toFixed(6);
    logApiCost(session.user.email, "extract-characters", cost, { model: MODEL, units: promptTokens + completionTokens }).catch(() => {});

    const parsed = jsonCandidate(gptData?.choices?.[0]?.message?.content ?? "");
    const rows = parsed && typeof parsed === "object" && Array.isArray((parsed as { characters?: unknown }).characters)
      ? (parsed as { characters: unknown[] }).characters
      : [];

    const characters: ExtractedCharacter[] = rows.flatMap((raw): ExtractedCharacter[] => {
      if (!raw || typeof raw !== "object") return [];
      const row = raw as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name.trim().slice(0, 80) : "";
      const description = typeof row.description === "string" ? row.description.trim().slice(0, 300) : "";
      if (!name || !description) return [];
      const mentionsNum = Number(row.mentions);
      const firstMentionNum = Number(row.firstMentionTime);
      return [{
        name,
        description,
        mentions: Number.isFinite(mentionsNum) && mentionsNum > 0 ? Math.round(mentionsNum) : 1,
        firstMentionTime: Number.isFinite(firstMentionNum) ? firstMentionNum : null,
      }];
    });

    return NextResponse.json({ characters });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json({ error: timeout ? "Character extraction timed out" : error instanceof Error ? error.message : "Character extraction failed" }, { status: timeout ? 504 : 500 });
  }
}
