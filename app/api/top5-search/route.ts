import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 45;

const SYSTEM_PROMPT =
  "You are helping create a 'Top 5' YouTube video. Given a concept, generate a specific ranked list from #5 (least significant) to #1 (most significant/interesting). For each item, provide:\n" +
  "- rank (5 to 1)\n" +
  "- label: a short punchy name for the item (2-6 words)\n" +
  "- blurb: one sentence describing why this is on the list\n" +
  "- searchQueries: 2 different YouTube search queries that would find compelling videos about this specific item\n\n" +
  "Guidelines:\n" +
  "- Order from LEAST to MOST — save the best for #1\n" +
  "- Label should be specific and memorable\n" +
  "- Search queries should differ from each other (one broad, one specific) to get variety\n\n" +
  'Return valid JSON: { "title": string, "items": [{ "rank": number, "label": string, "blurb": string, "searchQueries": [string, string] }, ...] }';

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

type Top5Item = {
  rank: number;
  label: string;
  blurb: string;
  searchQueries: string[];
};

type Top5Response = {
  title: string;
  items: Top5Item[];
};

function parseDurationSec(d: string | number | undefined): number {
  if (typeof d === "number") return isFinite(d) ? d : 0;
  if (!d) return 0;
  const parts = d.split(":").map(Number);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  return parseFloat(d) || 0;
}

async function generateTop5List(concept: string, openaiKey: string): Promise<Top5Response> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: concept },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = (err as { error?: { message?: string } })?.error?.message || `AI error ${res.status}`;
    throw new Error(message);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("AI returned invalid JSON");
  }
  const p = parsed as Record<string, unknown>;
  if (!p.title || !Array.isArray(p.items) || p.items.length === 0) {
    throw new Error("AI returned unexpected structure");
  }
  const items: Top5Item[] = (p.items as Array<Record<string, unknown>>).map((item) => ({
    rank: Number(item.rank),
    label: String(item.label ?? "").slice(0, 60),
    blurb: String(item.blurb ?? "").slice(0, 200),
    searchQueries: Array.isArray(item.searchQueries)
      ? (item.searchQueries as string[]).filter((q): q is string => typeof q === "string").slice(0, 2)
      : [],
  })).filter((item) => item.rank >= 1 && item.rank <= 5 && item.label);
  if (items.length === 0) throw new Error("AI couldn't generate list items");
  return { title: String(p.title).slice(0, 120), items };
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

function mergeAndRankVideos(results: RawSearchResult[][], maxVideos: number) {
  const byId = new Map<string, { result: RawSearchResult; hitCount: number; firstIndex: number }>();
  let order = 0;
  for (const list of results) {
    for (const r of list) {
      const videoId = r.id ?? r.videoId;
      if (!videoId) continue;
      const existing = byId.get(videoId);
      if (existing) existing.hitCount += 1;
      else byId.set(videoId, { result: r, hitCount: 1, firstIndex: order++ });
    }
  }
  const merged = Array.from(byId.values());
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
  return merged.slice(0, maxVideos).map(({ result: r }) => ({
    videoId: (r.id ?? r.videoId)!,
    title: r.title ?? "YouTube clip",
    channel: r.channel ?? r.channelTitle ?? "",
    thumbnailUrl: r.thumbnail ?? r.thumbnailUrl ?? "",
    viewCount: Number(r.viewCount ?? r.view_count ?? r.views ?? 0),
    durationSec: r.duration_seconds ?? r.durationSec ?? parseDurationSec(r.duration),
  }));
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

    const top5 = await generateTop5List(concept, openaiKey);

    // For each item, run both search queries in parallel, then merge per item
    const itemVideoResults = await Promise.all(
      top5.items.map(async (item) => {
        const queryResults = await Promise.all(
          item.searchQueries.map((q) => searchYouTube(q, railwayUrl, password))
        );
        const videos = mergeAndRankVideos(queryResults, 3);
        return { rank: item.rank, label: item.label, blurb: item.blurb, videos };
      })
    );

    // Sort by rank descending (5 → 1) for consistent ordering
    itemVideoResults.sort((a, b) => b.rank - a.rank);

    return NextResponse.json({ title: top5.title, items: itemVideoResults });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
