import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { logApiCost } from "@/lib/supabase";
import {
  buildEditorialImagePlanPrompt,
  buildEditorialPlanningChunks,
  buildEditorialTopicOutlinePrompt,
  EDITORIAL_IMAGE_PLAN_MODEL,
  editorialImageTargetCount,
  IMPLICIT_EDITORIAL_TOPIC_TITLE,
  MAX_EDITORIAL_IMAGES_PER_CALL,
  type EditorialTopicOutline,
  type EditorialTranscriptSegment,
  parseEditorialTopicOutline,
  parseEditorialTopicPlan,
} from "@/lib/board2/editorial-image-plan";
import {
  describeAppliedStyle,
  MAX_STYLE_EXEMPLARS_PER_REQUEST,
  selectStyleExemplars,
  STYLE_EXEMPLAR_TOKEN_BUDGET,
  stylePacingSeconds,
  type BoardStyleSummary,
} from "@/lib/board2/style-exemplars";

export const runtime = "nodejs";
export const maxDuration = 300;

const INPUT_USD_PER_MILLION_TOKENS = 0.25;
const OUTPUT_USD_PER_MILLION_TOKENS = 2.00;

type PlanRequestBody = {
  transcript?: unknown;
  segments?: unknown;
  durationSec?: unknown;
  secondsPerImage?: unknown;
  styleConditioning?: unknown;
  styleExemplars?: unknown;
};

function cleanStyleExemplars(value: unknown): BoardStyleSummary[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_STYLE_EXEMPLARS_PER_REQUEST).flatMap((candidate): BoardStyleSummary[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const summary = candidate as Partial<BoardStyleSummary>;
    if (summary.schemaVersion !== 1 || !summary.board || !summary.pacing || !summary.imagery || !summary.topics || !summary.camera || !summary.characters || !summary.annotations) return [];
    const serialized = JSON.stringify(candidate);
    if (serialized.length > 12_000) return [];
    return [JSON.parse(serialized) as BoardStyleSummary];
  });
}

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
    if (!Number.isFinite(secondsPerImage) || secondsPerImage < 3 || secondsPerImage > 12) {
      return NextResponse.json({ error: "secondsPerImage must be between 3 and 12" }, { status: 400 });
    }

    const segments = cleanTranscriptSegments(body.segments, durationSec);
    const styleConditioningRequested = body.styleConditioning !== false;
    const availableStyleExemplars = styleConditioningRequested ? cleanStyleExemplars(body.styleExemplars) : [];
    const styleSelection = selectStyleExemplars(availableStyleExemplars, STYLE_EXEMPLAR_TOKEN_BUDGET);
    const styleExemplars = styleSelection.selected;
    const styleConditioningApplied = styleConditioningRequested && styleExemplars.length > 0;
    const effectiveSecondsPerImage = styleConditioningApplied
      ? stylePacingSeconds(styleExemplars, secondsPerImage)
      : secondsPerImage;
    const targetCount = editorialImageTargetCount(durationSec, effectiveSecondsPerImage);
    const styleNote = styleConditioningApplied ? describeAppliedStyle(styleExemplars, effectiveSecondsPerImage) : null;
    type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    const aggregateUsage: Required<Usage> = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const callPlanner = async (prompt: { system: string; user: string }, maxCompletionTokens: number) => {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: EDITORIAL_IMAGE_PLAN_MODEL,
          reasoning_effort: "low",
          max_completion_tokens: maxCompletionTokens,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(90_000),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const apiError = data && typeof data === "object" && "error" in data
          ? (data as { error?: { message?: unknown } }).error?.message
          : null;
        throw new Error(typeof apiError === "string" ? apiError : `Image planner failed (${response.status})`);
      }
      const completion = data && typeof data === "object"
        ? data as { choices?: Array<{ message?: { content?: unknown } }>; usage?: Usage }
        : {};
      const usage = completion.usage ?? {};
      aggregateUsage.prompt_tokens += usage.prompt_tokens ?? 0;
      aggregateUsage.completion_tokens += usage.completion_tokens ?? 0;
      aggregateUsage.total_tokens += usage.total_tokens ?? 0;
      return typeof completion.choices?.[0]?.message?.content === "string" ? completion.choices[0].message.content : "";
    };

    const chunks = buildEditorialPlanningChunks(durationSec, targetCount);
    let topicOutline: EditorialTopicOutline[] = [];
    let plannerCallCount = 0;
    if (chunks.length > 1) {
      const outlinePrompt = buildEditorialTopicOutlinePrompt({ transcript, segments, durationSec, styleExemplars });
      const outlineText = await callPlanner(outlinePrompt, 2400);
      plannerCallCount += 1;
      topicOutline = parseEditorialTopicOutline(outlineText, durationSec);
    }
    if (!topicOutline.length) {
      topicOutline = [{ topicTitle: IMPLICIT_EDITORIAL_TOPIC_TITLE, startTime: 0, endTime: durationSec }];
    }

    const planChunk = async (chunk: (typeof chunks)[number]) => {
      const windowSegments = segments.filter((segment) => segment.end > chunk.startTime && segment.start < chunk.endTime);
      const prompt = buildEditorialImagePlanPrompt({
        transcript,
        segments: windowSegments,
        durationSec,
        secondsPerImage: effectiveSecondsPerImage,
        targetCount: chunk.targetCount,
        styleExemplars,
        ...(chunks.length > 1 ? { planningWindow: { ...chunk, topicOutline } } : {}),
      });
      const responseText = await callPlanner(prompt, Math.min(12_000, Math.max(1200, chunk.targetCount * 240)));
      plannerCallCount += 1;
      const parsed = parseEditorialTopicPlan(responseText, durationSec, chunk.targetCount, {
        normalizeFirstTimestamp: chunks.length === 1,
        normalizeLastTopicEnd: chunks.length === 1,
      });
      const isLastChunk = chunk.index === chunks.length - 1;
      const images = parsed.flatMap((topic) => topic.images).filter((image) =>
        image.startTime >= chunk.startTime - 0.01 && (isLastChunk ? image.startTime <= chunk.endTime : image.startTime < chunk.endTime)
      ).slice(0, chunk.targetCount);
      return { images, topics: parsed };
    };

    const chunkResults: Awaited<ReturnType<typeof planChunk>>[] = new Array(chunks.length);
    let nextChunkIndex = 0;
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, async () => {
      while (nextChunkIndex < chunks.length) {
        const index = nextChunkIndex++;
        chunkResults[index] = await planChunk(chunks[index]);
      }
    }));

    const seenQueries = new Set<string>();
    const plan = chunkResults.flatMap((result) => result.images).sort((a, b) => a.startTime - b.startTime).filter((image) => {
      const key = image.query.toLowerCase();
      if (seenQueries.has(key)) return false;
      seenQueries.add(key);
      return true;
    }).slice(0, targetCount);
    if (plan.length) plan[0] = { ...plan[0], startTime: 0 };
    const topics = chunks.length === 1
      ? chunkResults[0].topics
      : topicOutline.flatMap((outline, index) => {
          const isLast = index === topicOutline.length - 1;
          const images = plan.filter((image) => image.startTime >= outline.startTime && (isLast ? image.startTime <= outline.endTime : image.startTime < outline.endTime));
          return images.length ? [{ ...outline, images }] : [];
        });

    const usage = aggregateUsage;
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
      chunkCount: chunks.length,
      plannerCallCount,
      maxImagesPerCall: MAX_EDITORIAL_IMAGES_PER_CALL,
      style: {
        requested: styleConditioningRequested,
        applied: styleConditioningApplied,
        availableCount: availableStyleExemplars.length,
        exemplarCount: styleExemplars.length,
        exemplarTokenBudget: STYLE_EXEMPLAR_TOKEN_BUDGET,
        approximateExemplarTokens: styleSelection.approximateTokens,
        selection: "most-recent-first",
        effectiveSecondsPerImage,
        note: styleNote,
        fallback: styleConditioningRequested && !styleConditioningApplied ? "zero-starred" : null,
      },
      topics,
      plan,
    });
  } catch (error: unknown) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const message = error instanceof Error ? error.message : "Image planning failed";
    return NextResponse.json({ error: timeout ? "Image planner timed out" : message }, { status: timeout ? 504 : 500 });
  }
}
