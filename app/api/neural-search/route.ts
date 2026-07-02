import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 30;

const SYSTEM_PROMPT =
  "You help find YouTube videos matching a user's video concept. Given a description, generate 3 diverse search queries that would return videos useful for the concept. Return JSON: { queries: [string, string, string] }. Prefer terms YouTube creators actually use. Include 1-2 broader queries and 1 more specific query. Don't include quotes or special syntax.";

type RawSearchResult = {
  id?: string;
  videoId?: string;
  title?: string;
  channel?: string;
  channelTitle?: string;
  duration?: string | number;
  duration_seconds?: number;
  durationSec?: number;
  thumbnail?: string;
  thumbnailUrl?: string;
  viewCount?: number;
  view_count?: number;
  views?: number;
};

function parseDurationSec(d: string | number | undefined): number {
  if (typeof d === "number") return isFinite(d) ? d : 0;
  if (!d) return 0;
  const parts = d.split(":").map(Number);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  return parseFloat(d) || 0;
}

async function generateQueries(concept: string, openaiKey: string): Promise<string[]> {
  const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: concept },
      ],
    }),
  });
  if (!gptRes.ok) {
    const err = await gptRes.json().catch(() => ({}));
    const message = (err as { error?: { message?: string } })?.error?.message || `AI error ${gptRes.status}`;
    throw new Error(message);
  }
  const gptData = await gptRes.json();
  const gptText = gptData.choices?.[0]?.message?.content || "{}";
  let parsed: { queries?: unknown };
  try {
    parsed = JSON.parse(gptText);
  } catch {
    throw new Error("AI returned invalid JSON");
  }
  const queries = Array.isArray(parsed.queries)
    ? parsed.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, 3)
    : [];
  if (queries.length === 0) throw new Error("AI couldn't generate search queries");
  return queries;
}

async function searchYouTube(query: string, railwayUrl: string, password: string): Promise<RawSearchResult[]> {
  try {
    const res = await fetch(`${railwayUrl}/video-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-neuralboard-password": password },
      body: JSON.stringify({ query, limit: 8 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as RawSearchResult[]) : [];
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isUserPro(session))) {
    return NextResponse.json({ error: "Pro subscription required" }, { status: 403 });
  }

  const railwayUrl = process.env.RAILWAY_URL ?? process.env.NEXT_PUBLIC_RAILWAY_URL ?? "";
  const password = process.env.NEURALBOARD_PASSWORD ?? "";
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!railwayUrl) return NextResponse.json({ error: "Not configured" }, { status: 500 });
  if (!openaiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

  try {
    const raw = await req.json();
    const concept = typeof raw.concept === "string" ? raw.concept.trim().slice(0, 2000) : "";
    if (!concept) return NextResponse.json({ error: "Missing concept" }, { status: 400 });

    const queries = await generateQueries(concept, openaiKey);
    const searchResults = await Promise.all(queries.map((q) => searchYouTube(q, railwayUrl, password)));

    // Merge + dedupe by videoId, tracking how many queries surfaced each video and first-seen order
    const byId = new Map<string, { result: RawSearchResult; hitCount: number; firstIndex: number }>();
    let order = 0;
    for (const results of searchResults) {
      for (const r of results) {
        const videoId = r.id ?? r.videoId;
        if (!videoId) continue;
        const existing = byId.get(videoId);
        if (existing) existing.hitCount += 1;
        else byId.set(videoId, { result: r, hitCount: 1, firstIndex: order++ });
      }
    }

    const merged = Array.from(byId.values());
    // The Railway bridge doesn't reliably return view counts — rank by them if present,
    // otherwise fall back to how many of the 3 queries surfaced the video, then first-seen order.
    const hasViewCounts = merged.some((m) => typeof (m.result.viewCount ?? m.result.view_count ?? m.result.views) === "number");
    merged.sort((a, b) => {
      if (hasViewCounts) {
        const va = Number(a.result.viewCount ?? a.result.view_count ?? a.result.views ?? 0);
        const vb = Number(b.result.viewCount ?? b.result.view_count ?? b.result.views ?? 0);
        if (vb !== va) return vb - va;
      }
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      return a.firstIndex - b.firstIndex;
    });

    const videos = merged.slice(0, 5).map(({ result: r }) => ({
      videoId: (r.id ?? r.videoId)!,
      title: r.title ?? "YouTube clip",
      channel: r.channel ?? r.channelTitle ?? "",
      thumbnailUrl: r.thumbnail ?? r.thumbnailUrl ?? "",
      viewCount: Number(r.viewCount ?? r.view_count ?? r.views ?? 0),
      durationSec: r.duration_seconds ?? r.durationSec ?? parseDurationSec(r.duration),
    }));

    return NextResponse.json({ videos, queries });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
