import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { logApiCost } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

type TranscriptSegment = { start: number; end: number; text: string };
type TimelineClip = {
  id: string;
  type: string;
  startTime: number;
  duration: number;
  boardX?: number;
  boardY?: number;
  boardW?: number;
  boardH?: number;
  label?: string;
};
type CameraFocusEntry = { clipId: string; holdStart: number; holdEnd: number; transitionEnd: number };

const VALID_TYPES = new Set([
  "walkTo", "jumpTo", "flip", "grapple", "zipline", "wallClimb",
  "sitAndWatch", "pointAt", "emote", "explainGesture",
]);
const TRAVEL_TYPES = new Set(["walkTo", "jumpTo", "flip", "grapple", "zipline", "wallClimb"]);

const SYSTEM_PROMPT = `You choreograph a stick-figure explainer character in a video. The character stands on media clips placed on a board while a camera pans between them.

VOCABULARY — output ONLY these action types: walkTo, jumpTo, flip, grapple, zipline, wallClimb, sitAndWatch, pointAt, emote, explainGesture.
- walkTo, jumpTo, flip, grapple, zipline, wallClimb: travel moves. Each MUST include targetClipId — the clip the character moves to. Choose the move by distance/drama: walkTo for short hops, jumpTo for medium gaps, flip for a dramatic entrance/exit or big beat, grapple or zipline for long or dramatic traversals across the board, wallClimb only when the target clip sits well above the current position.
- sitAndWatch: sit and watch a video clip play. targetClipId = that video clip.
- pointAt: point at a clip to draw attention to it. targetClipId is REQUIRED.
- explainGesture: talk with the hands while standing near a clip. targetClipId is optional — omit it to just continue gesturing wherever the character currently is.
- emote: a single emoji reaction held briefly. Requires an "emoji" field. Never include targetClipId on an emote.

RULES:
- Every action has startTime and duration in seconds, on the ABSOLUTE video timeline (not relative to any clip).
- Respect the camera schedule given in cameraFocusOrder: during a clip's holdStart–holdEnd window the character should be on or near that clip. Travel actions belong in the TRANSITION window — after one clip's holdEnd and before the next clip's transitionEnd — never in the middle of a hold.
- Stay within totalDurationSec. It's fine to leave a hold with no explicit action — the renderer fills gaps with idle/gesture poses automatically, so only add actions where they add something.
- If direction text is provided, treat it as the primary source for WHICH moves happen and roughly when. Map it onto the real clip order — e.g. "flips in onto image 1" means the flip should target the first clip in cameraFocusOrder, "the video" means the nearest clip of type video, "the last image" means the last image-type clip. If the direction conflicts with the camera schedule, keep the user's intended move CHOICE but retime it to the nearest matching clip's actual hold/transition windows.
- If a transcript with segment timestamps is provided, add emote actions timed to emotionally salient moments in the narration: a surprising fact → ❗ or 🤯, a question → 🤔, a funny/light moment → 😂, a key insight → 💡. Max roughly one emote per 6 seconds of narration, and only where something genuinely fits — do not force one into every segment.
- Never invent a clipId that isn't in the provided clip list.

Return ONLY valid JSON, no markdown, no commentary, in this exact schema:
{
  "actions": [
    {
      "type": "walkTo" | "jumpTo" | "flip" | "grapple" | "zipline" | "wallClimb" | "sitAndWatch" | "pointAt" | "emote" | "explainGesture",
      "startTime": number,
      "duration": number,
      "targetClipId": "string (omit for emote)",
      "emoji": "string (emote only)"
    }
  ]
}`;

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

    const body = await req.json();
    const { direction, transcript, timeline } = body as {
      direction?: string;
      transcript?: { text: string; segments: TranscriptSegment[] };
      timeline: { totalDurationSec: number; clips: TimelineClip[]; cameraFocusOrder: CameraFocusEntry[] };
    };

    const directionText = (direction ?? "").trim();
    const hasTranscript = !!transcript?.text?.trim();
    if (!directionText && !hasTranscript) {
      return NextResponse.json({ error: "Provide a direction, or enable narration sync" }, { status: 400 });
    }
    if (!timeline?.clips?.length) {
      return NextResponse.json({ error: "No clips on the board yet" }, { status: 400 });
    }

    const totalDurationSec = Number(timeline.totalDurationSec) || 0;

    const clipDescription = timeline.clips
      .map((c) =>
        `- id=${c.id} type=${c.type} label="${c.label ?? ""}" start=${c.startTime.toFixed(2)} duration=${c.duration.toFixed(2)}` +
        (c.boardX !== undefined ? ` board=(${Math.round(c.boardX)},${Math.round(c.boardY ?? 0)}) size=${Math.round(c.boardW ?? 0)}x${Math.round(c.boardH ?? 0)}` : "")
      )
      .join("\n");

    const scheduleDescription = timeline.cameraFocusOrder
      .map((f) => `- clipId=${f.clipId} holdStart=${f.holdStart.toFixed(2)} holdEnd=${f.holdEnd.toFixed(2)} transitionEnd=${f.transitionEnd.toFixed(2)}`)
      .join("\n");

    const transcriptDescription = hasTranscript
      ? `NARRATION TRANSCRIPT (with segment timestamps, absolute timeline seconds):\n` +
        (transcript!.segments ?? []).map((s) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`).join("\n")
      : "No narration transcript provided.";

    const userContent = `TOTAL VIDEO DURATION: ${totalDurationSec.toFixed(2)}s

CLIPS ON THE BOARD (in board order, id is what you must target):
${clipDescription}

CAMERA SCHEDULE (when the camera holds on each clip vs. transitions between clips):
${scheduleDescription}

USER'S DIRECTION FOR THE CHARACTER:
"${directionText || "(none — base the choreography on the narration transcript below)"}"

${transcriptDescription}

Generate the timed action list for this character now.`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `GPT-4o error ${res.status}`;
      console.error("[character-choreography] GPT-4o error:", msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? "{}";

    // Log cost: GPT-4o $2.50/1M input, $10/1M output
    const usage = data.usage ?? {};
    const cost = +((usage.prompt_tokens ?? 0) / 1_000_000 * 2.5 + (usage.completion_tokens ?? 0) / 1_000_000 * 10).toFixed(5);
    logApiCost(session.user.email, "gpt-4o-board2-choreography", cost, {
      model: "gpt-4o",
      units: usage.total_tokens ?? 0,
    }).catch(() => {});

    let parsed: { actions?: unknown[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("[character-choreography] Failed to parse GPT-4o response:", raw.slice(0, 500));
      return NextResponse.json({ error: "Couldn't generate choreography. Try again." }, { status: 500 });
    }

    const clipIds = new Set(timeline.clips.map((c) => c.id));
    const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];

    // Server-side sanity pass — clamp times/durations, drop unknown types and dangling clip
    // refs — before this ever reaches the client. The client does the fuller pass (overlap
    // truncation against existing manual actions, id generation) since it owns that state.
    type ValidatedAction = { type: string; startTime: number; duration: number; targetClipId?: string; emoji?: string };
    const actions: ValidatedAction[] = rawActions
      .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
      .map((a) => {
        const type = typeof a.type === "string" ? a.type : "";
        const startTime = Math.max(0, Math.min(totalDurationSec, Number(a.startTime) || 0));
        const rawDuration = Number(a.duration) > 0 ? Number(a.duration) : 1.5;
        const duration = Math.max(0.1, Math.min(rawDuration, Math.max(0.1, totalDurationSec - startTime)));
        const targetClipId = typeof a.targetClipId === "string" ? a.targetClipId : undefined;
        const emoji = typeof a.emoji === "string" ? a.emoji.slice(0, 8) : undefined;
        return { type, startTime, duration, targetClipId, emoji };
      })
      .filter((a) => {
        if (!VALID_TYPES.has(a.type)) return false;
        if (a.type === "emote") return !!a.emoji;
        if (a.type === "pointAt") return !!a.targetClipId && clipIds.has(a.targetClipId);
        if (TRAVEL_TYPES.has(a.type)) return !!a.targetClipId && clipIds.has(a.targetClipId);
        // sitAndWatch / explainGesture: targetClipId optional, but must be valid if present
        return !a.targetClipId || clipIds.has(a.targetClipId);
      });

    console.log(`[character-choreography] user=${session.user.email} clips=${timeline.clips.length} direction_len=${directionText.length} has_transcript=${hasTranscript} actions=${actions.length} cost=$${cost}`);

    return NextResponse.json({ actions });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
