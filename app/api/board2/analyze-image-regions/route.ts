import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { logApiCost } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "gpt-4o";

export type ImageRegion = { label: string; x: number; y: number; width: number; height: number; note: string };

function jsonCandidate(text: string): unknown {
  const clean = text.replace(/^﻿/, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(clean); } catch { return null; }
}

function clampFraction(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!await isUserPro(session)) return NextResponse.json({ error: "Pro subscription required" }, { status: 403 });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

    const body = await req.json().catch(() => null) as { imageUrl?: unknown; narrativeContext?: unknown } | null;
    const imageUrl = typeof body?.imageUrl === "string" ? body.imageUrl.trim() : "";
    const narrativeContext = typeof body?.narrativeContext === "string" ? body.narrativeContext.trim().slice(0, 500) : "";
    if (!imageUrl) return NextResponse.json({ error: "imageUrl is required" }, { status: 400 });
    if (!/^(https?:\/\/|data:image\/)/i.test(imageUrl)) {
      return NextResponse.json({ error: "imageUrl must be an http(s) URL or a data: image URL" }, { status: 400 });
    }

    const systemPrompt = `You are analyzing an image to identify its semantically distinct regions for cinematic camera panning.

Identify 2-4 of the most meaningful spatial regions in this image. For each region:
- A short descriptive label (2-4 words, e.g. "old cabin", "dense forest", "person's face", "city skyline")
- Approximate bounding box as fractions of image dimensions: { x, y, width, height } from top-left (0,0) to bottom-right (1,1)
- A brief note on why this region is visually/narratively interesting

${narrativeContext ? `Narrative context for this image: "${narrativeContext}" — prioritize regions most relevant to this context.` : ""}

Return STRICT JSON only:
{
  "regions": [
    { "label": string, "x": number, "y": number, "width": number, "height": number, "note": string }
  ]
}

Rules:
- x, y, width, height must all be between 0 and 1
- Regions can overlap
- Order regions by narrative/visual importance
- Return 2-4 regions only`;

    const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(50_000),
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: "Identify the semantic regions of this image." },
              { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
            ],
          },
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
    logApiCost(session.user.email, "analyze-image-regions", cost, { model: MODEL, units: promptTokens + completionTokens }).catch(() => {});

    const parsed = jsonCandidate(gptData?.choices?.[0]?.message?.content ?? "");
    const rows = parsed && typeof parsed === "object" && Array.isArray((parsed as { regions?: unknown }).regions)
      ? (parsed as { regions: unknown[] }).regions
      : [];

    const regions: ImageRegion[] = rows.flatMap((raw): ImageRegion[] => {
      if (!raw || typeof raw !== "object") return [];
      const row = raw as Record<string, unknown>;
      const label = typeof row.label === "string" ? row.label.trim().slice(0, 60) : "";
      const note = typeof row.note === "string" ? row.note.trim().slice(0, 200) : "";
      const x = clampFraction(row.x);
      const y = clampFraction(row.y);
      const width = clampFraction(row.width);
      const height = clampFraction(row.height);
      if (!label || x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return [];
      return [{ label, x, y, width, height, note }];
    }).slice(0, 4);

    return NextResponse.json({ regions });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json({ error: timeout ? "Image analysis timed out" : error instanceof Error ? error.message : "Image analysis failed" }, { status: timeout ? 504 : 500 });
  }
}
