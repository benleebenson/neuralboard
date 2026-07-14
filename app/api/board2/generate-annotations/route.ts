import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { AI_FEATURES_ENABLED } from "@/app/board2/config";
import { authOptions, isUserPro } from "@/lib/auth";
import { logApiCost } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

type ClipInfo = {
  id: string;
  type: "image" | "video" | "pan";
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  sourceUrl?: string;
};

const SYSTEM_PROMPT = `You are an art director creating annotations for a video mood board. The user has placed images and videos on a 4000×3000 canvas and recorded a narration. Your job is to generate sketch-style annotations that visually emphasize key ideas from the narration relative to the board layout.

BOARD: 4000×3000px. All coordinates must stay within these bounds (boardX: 0–4000, boardY: 0–3000).

ANNOTATION TYPES AND HOW TO USE THEM:
- "text": Handwritten labels overlaid on the board.
  - Major theme titles: fontFamily "Permanent Marker", fontSize 100–150, fontWeight "bold", bold colors (red/orange).
  - Image-specific labels: fontFamily "Caveat" or "Architects Daughter", fontSize 35–60.
  - boardX/Y = where the text starts (top-left). boardW = approximate text width in board units. boardH = approximate line height.
- "arrow": Connects or points to elements. Use arrowStartX/Y and arrowEndX/Y for endpoints. Set boardX=min(startX,endX), boardY=min(startY,endY), boardW=|endX-startX|+10, boardH=|endY-startY|+10.
- "circle": Circles an image or region. boardX/Y = top-left of the bounding ellipse, boardW/H = ellipse dimensions (add ~60px padding around the clip on each side).
- "highlight": Highlights a rectangular region. highlightStyle "rect" (translucent fill), "underline" (line under), "curlyBrace" (right-side brace).
- "emoji": A single large emoji placed on the board for visual emphasis. Use SPARINGLY — at most 1–2 per board. Best for flagging a single key insight or emotional beat.
  - boardX/Y = top-left of the emoji bounding box. boardW/H = 200 (the emoji renders centered in this box). fontSize = 160–200.
  - emoji field: choose from this set only: 🤔 ⭐ 🎯 ❗ 💡 🔥 ✨ 📈 📉 ⚠️ ❓ 💬 👀 🚀 ❤️ ✅ ❌ 🌍 🧠 🎨 🏆 💎 🔑 📌 🎬 📊 💰 🔍 🤝 🌟 💥 🎤 📣 🌈 ⏰ 🎁

ANNOTATION STRATEGY:
1. Analyze the narration for: key claims, named entities, statistics, comparisons, emphasis.
2. Generate 5–10 annotations total — scale to narration length.
3. Use a MIX of types. A good board has 1–2 bold title texts, 2–3 arrows connecting related clips, 1–2 circles around important clips, 0–1 highlights, and optionally 0–2 emojis for the single most striking idea.
4. Dramatic titles (Permanent Marker, 100–140px, red or orange) for the board's main theme.
5. Smaller Caveat/Architects Daughter labels for individual clips.
6. Arrows should connect clips whose topics are mentioned together in the narration.
7. Circles should surround the 1–2 clips most central to the narration.
8. Place labels slightly above or beside images — avoid fully covering them.
9. Spread annotations across the board; don't cluster everything in one corner.
10. Only use emojis when they add clear visual meaning — a 💡 near a key insight, 🔥 near something exciting, ⚠️ near a risk. Do NOT emoji-spam.

AVAILABLE COLORS: "#cc2200" (red), "#1a6fd4" (blue), "#e8a800" (gold), "#228b22" (green), "#e06020" (orange), "#1a1a1a" (black)

AVAILABLE FONT FAMILIES (text only): "Caveat", "Permanent Marker", "Architects Daughter", "Patrick Hand"

OUTPUT: Return ONLY valid JSON with this exact schema — no markdown, no explanation:
{
  "reasoning": "1–2 sentence explanation of the visual strategy",
  "annotations": [
    {
      "type": "text" | "arrow" | "circle" | "highlight" | "emoji",
      "boardX": number,
      "boardY": number,
      "boardW": number,
      "boardH": number,
      "color": "#rrggbb",
      "text": "string (text type only)",
      "fontFamily": "string (text type only)",
      "fontSize": number,
      "fontWeight": "normal" | "bold",
      "arrowStartX": number,
      "arrowStartY": number,
      "arrowEndX": number,
      "arrowEndY": number,
      "highlightStyle": "rect" | "underline" | "curlyBrace",
      "emoji": "single emoji character (emoji type only)"
    }
  ]
}`;

export async function POST(req: NextRequest) {
  try {
    if (!AI_FEATURES_ENABLED) {
      return NextResponse.json({ error: "AI features disabled" }, { status: 404 });
    }

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
    const { transcript, board, clips } = body as {
      transcript: string;
      board: { width: number; height: number; backgroundColor: string };
      clips: ClipInfo[];
    };

    if (!transcript?.trim()) {
      return NextResponse.json({ error: "Transcript is empty" }, { status: 400 });
    }

    // Build the clip layout description
    const clipDescription = clips.length > 0
      ? clips.map((c, i) =>
          `Clip ${i + 1}: type=${c.type}, position=(${Math.round(c.boardX)}, ${Math.round(c.boardY)}), size=${Math.round(c.boardW)}×${Math.round(c.boardH)}, center=(${Math.round(c.boardX + c.boardW / 2)}, ${Math.round(c.boardY + c.boardH / 2)})`
        ).join("\n")
      : "No clips placed yet.";

    // Collect accessible image URLs for vision (http/https only, up to 6)
    const imageUrls = clips
      .filter((c) => c.type === "image" && c.sourceUrl?.startsWith("http"))
      .slice(0, 6)
      .map((c) => c.sourceUrl as string);

    // Build user message content
    type ContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail: "low" } };

    const userContent: ContentPart[] = [
      {
        type: "text",
        text: `BOARD: ${board.width}×${board.height}px

CLIPS ON BOARD:
${clipDescription}

NARRATION TRANSCRIPT:
"${transcript.trim()}"

Generate annotations that visually emphasize the key ideas from this narration relative to the clip positions above.`,
      },
    ];

    // Include board images for vision context if available
    for (const url of imageUrls) {
      userContent.push({ type: "image_url", image_url: { url, detail: "low" } });
    }

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
      console.error("[generate-annotations] GPT-4o error:", msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? "{}";

    // Log cost: GPT-4o $2.50/1M input, $10/1M output
    const usage = data.usage ?? {};
    const cost = +((usage.prompt_tokens ?? 0) / 1_000_000 * 2.5 + (usage.completion_tokens ?? 0) / 1_000_000 * 10).toFixed(5);
    logApiCost(session.user.email, "gpt-4o-board2-annotations", cost, {
      model: "gpt-4o",
      units: usage.total_tokens ?? 0,
    }).catch(() => {});

    let parsed: { reasoning?: string; annotations?: unknown[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("[generate-annotations] Failed to parse GPT-4o response:", raw.slice(0, 500));
      return NextResponse.json({ error: "Couldn't generate annotations. Try again." }, { status: 500 });
    }

    const annotations = Array.isArray(parsed.annotations) ? parsed.annotations : [];
    console.log(`[generate-annotations] user=${session.user.email} clips=${clips.length} transcript_len=${transcript.length} annotations=${annotations.length} cost=$${cost}`);

    return NextResponse.json({
      annotations,
      reasoning: parsed.reasoning ?? "",
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
