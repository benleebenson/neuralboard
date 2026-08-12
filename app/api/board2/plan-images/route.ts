import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { logApiCost } from "@/lib/supabase";
import {
  buildEditorialImagePlanPrompt,
  EDITORIAL_IMAGE_PLAN_MODEL,
  editorialImageTargetCount,
  type EditorialTranscriptSegment,
  parseEditorialImagePlan,
} from "@/lib/board2/editorial-image-plan";

export const runtime = "nodejs";
export const maxDuration = 60;

const INPUT_USD_PER_MILLION_TOKENS = 0.25;
const OUTPUT_USD_PER_MILLION_TOKENS = 2.00;

type PlanRequestBody = {
  transcript?: unknown;
  segments?: unknown;
  durationSec?: unknown;
  secondsPerImage?: unknown;
};

function cleanTranscriptSegments(value: unknown, durationSec: number): EditorialTranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): EditorialTranscriptSegment[] => {
    if (!raw || typeof raw !== "object") return [];
    const segment = raw as { start?: unknown; end?: unknown; text?: unknown };
    const start = Number(segment.start);
    const end = Number(segment.end);
    const text = typeof segment.text === "string" ? segment.text.replace(/\s+/g, " ").trim() : "";
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) return [];
    return [{ start: Math.max(0, start), end: Math.min(durationSec, end), text }];
  }).filter((segment) => segment.end > segment.start).sort((a, b) => a.start - b.start);
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!await isUserPro(session)) {
      return NextResponse.json({ error: "Pro subscription required" }, { status: 403 });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
    }

    const raw: unknown = await req.json();
    const body: PlanRequestBody = raw && typeof raw === "object" ? raw as PlanRequestBody : {};
    const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
    const durationSec = Number(body.durationSec);
    const secondsPerImage = Number(body.secondsPerImage);
    if (!transcript) return NextResponse.json({ error: "transcript is required" }, { status: 400 });
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return NextResponse.json({ error: "durationSec must be positive" }, { status: 400 });
    }
    if (!Number.isFinite(secondsPerImage) || secondsPerImage < 2 || secondsPerImage > 12) {
      return NextResponse.json({ error: "secondsPerImage must be between 2 and 12" }, { status: 400 });
    }

    const segments = cleanTranscriptSegments(body.segments, durationSec);
    const targetCount = editorialImageTargetCount(durationSec, secondsPerImage);
    const prompt = buildEditorialImagePlanPrompt({
      transcript,
      segments,
      durationSec,
      secondsPerImage,
      targetCount,
    });

    const planResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: EDITORIAL_IMAGE_PLAN_MODEL,
        reasoning_effort: "low",
        max_completion_tokens: Math.min(4000, Math.max(800, targetCount * 180)),
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(50_000),
    });
    const responseData: unknown = await planResponse.json().catch(() => null);
    if (!planResponse.ok) {
      const apiError = responseData && typeof responseData === "object" && "error" in responseData
        ? (responseData as { error?: { message?: unknown } }).error?.message
        : null;
      return NextResponse.json(
        { error: typeof apiError === "string" ? apiError : `Image planner failed (${planResponse.status})` },
        { status: 502 },
      );
    }

    const completion = responseData && typeof responseData === "object"
      ? responseData as {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        }
      : {};
    const responseText = typeof completion.choices?.[0]?.message?.content === "string"
      ? completion.choices[0].message.content
      : "";
    const plan = parseEditorialImagePlan(responseText, durationSec, targetCount);

    const usage = completion.usage ?? {};
    const costUsd = +(
      (usage.prompt_tokens ?? 0) * INPUT_USD_PER_MILLION_TOKENS / 1_000_000
      + (usage.completion_tokens ?? 0) * OUTPUT_USD_PER_MILLION_TOKENS / 1_000_000
    ).toFixed(6);
    logApiCost(session.user.email, "board2-editorial-image-plan", costUsd, {
      model: EDITORIAL_IMAGE_PLAN_MODEL,
      units: usage.total_tokens ?? 0,
    }).catch(() => {});

    if (!plan.length) {
      return NextResponse.json({ error: "Image planner returned invalid JSON" }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      model: EDITORIAL_IMAGE_PLAN_MODEL,
      targetCount,
      plan,
    });
  } catch (error: unknown) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const message = error instanceof Error ? error.message : "Image planning failed";
    return NextResponse.json({ error: timeout ? "Image planner timed out" : message }, { status: timeout ? 504 : 500 });
  }
}
