import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logApiCost } from "@/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { beats, boardW, boardH } = await req.json();

  const beatList = beats
    .map((b: { i: number; query: string }) => `${b.i}: "${b.query}"`)
    .join("\n");

  const prompt = `You are laying out a detective-style evidence board. Arrange the beats and add visual annotations.

Board: ${Math.round(boardW)}×${Math.round(boardH)}px. Card size: ~130×170px.

Beats:
${beatList}

Return JSON only — no explanation, no markdown. Schema:
{
  "positions": [{"x": number, "y": number}, ...],  // one per beat, top-left corner, keep cards in-bounds
  "overlays": [
    {"id":"t1","type":"text","x":number,"y":number,"text":"CASE FILE: [short topic title]","color":"#cc2200","strokeWidth":2,"fontSize":26},
    {"id":"a1","type":"arrow","x":number,"y":number,"x2":number,"y2":number,"color":"#cc2200","strokeWidth":3},
    {"id":"c1","type":"circle","x":number,"y":number,"r":number,"color":"#cc2200","strokeWidth":3}
  ]
}

Rules:
- Scatter cards naturally — avoid grids, vary vertical spacing
- Keep cards at least 20px from board edges and 10px from each other
- Arrow coordinates should point to/from card centers (add ~65 to card x, ~85 to card y)
- Add exactly 1 text title near the top
- Add 2–4 arrows between thematically related beats
- Circle 1–2 of the most important beats (circle center = card center)
- Circle radius ~80px`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  // Claude claude-sonnet-4-6: $0.003/1K input, $0.015/1K output
  const claudeCost = +((message.usage.input_tokens / 1000) * 0.003 + (message.usage.output_tokens / 1000) * 0.015).toFixed(5);
  logApiCost(session.user.email, "claude-sonnet", claudeCost, {
    model: "claude-sonnet-4-6",
    units: message.usage.input_tokens + message.usage.output_tokens,
  }).catch(() => {});

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return NextResponse.json({ error: "Failed to parse layout" }, { status: 500 });
  }

  try {
    const layout = JSON.parse(jsonMatch[0]);
    return NextResponse.json(layout);
  } catch {
    return NextResponse.json({ error: "Invalid JSON from model" }, { status: 500 });
  }
}
