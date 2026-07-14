import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { AI_FEATURES_ENABLED } from "@/app/board2/config";
import { authOptions, isUserPro } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 30;

const SYSTEM_PROMPT =
  "You help find YouTube videos AND Google images matching a user's video concept. Given a description, generate:\n" +
  "- 3 diverse YouTube search queries (broad + specific)\n" +
  "- 2 image search queries (more visual/concrete, since images need concrete subjects)\n" +
  "Return JSON: { videoQueries: [3 strings], imageQueries: [2 strings] }.\n" +
  "Do not include quotes or special syntax.";

const IMAGE_EXT_RE = /\.(jpe?g|png|webp)(?:[?#].*)?$/i;

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

type RawImageResult = {
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  link?: string;
  source?: string;
  domain?: string;
};

function parseDurationSec(d: string | number | undefined): number {
  if (typeof d === "number") return isFinite(d) ? d : 0;
  if (!d) return 0;
  const parts = d.split(":").map(Number);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  return parseFloat(d) || 0;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function generateSearchQueries(concept: string, openaiKey: string): Promise<{ videoQueries: string[]; imageQueries: string[] }> {
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
  let parsed: { videoQueries?: unknown; imageQueries?: unknown };
  try {
    parsed = JSON.parse(gptText);
  } catch {
    throw new Error("AI returned invalid JSON");
  }
  const videoQueries = Array.isArray(parsed.videoQueries)
    ? parsed.videoQueries.filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, 3)
    : [];
  const imageQueries = Array.isArray(parsed.imageQueries)
    ? parsed.imageQueries.filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, 2)
    : [];
  if (videoQueries.length === 0) throw new Error("AI couldn't generate search queries");
  return { videoQueries, imageQueries };
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

async function searchImages(query: string, apiKey: string): Promise<RawImageResult[]> {
  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({ q: query, num: 10 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.images) ? (data.images as RawImageResult[]) : [];
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  if (!AI_FEATURES_ENABLED) {
    return NextResponse.json({ error: "AI features disabled" }, { status: 404 });
  }

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
  const serperKey = process.env.SERPER_API_KEY;
  if (!railwayUrl) return NextResponse.json({ error: "Not configured" }, { status: 500 });
  if (!openaiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

  try {
    const raw = await req.json();
    const concept = typeof raw.concept === "string" ? raw.concept.trim().slice(0, 2000) : "";
    if (!concept) return NextResponse.json({ error: "Missing concept" }, { status: 400 });

    const { videoQueries, imageQueries } = await generateSearchQueries(concept, openaiKey);

    const [videoSearchResults, imageSearchResults] = await Promise.all([
      Promise.all(videoQueries.map((q) => searchYouTube(q, railwayUrl, password))),
      serperKey ? Promise.all(imageQueries.map((q) => searchImages(q, serperKey))) : Promise.resolve([]),
    ]);

    // ── Videos: merge + dedupe by videoId, tracking how many queries surfaced each and first-seen order
    const byId = new Map<string, { result: RawSearchResult; hitCount: number; firstIndex: number }>();
    let order = 0;
    for (const results of videoSearchResults) {
      for (const r of results) {
        const videoId = r.id ?? r.videoId;
        if (!videoId) continue;
        const existing = byId.get(videoId);
        if (existing) existing.hitCount += 1;
        else byId.set(videoId, { result: r, hitCount: 1, firstIndex: order++ });
      }
    }
    const mergedVideos = Array.from(byId.values());
    // The Railway bridge doesn't reliably return view counts — rank by them if present,
    // otherwise fall back to how many of the queries surfaced the video, then first-seen order.
    const hasViewCounts = mergedVideos.some((m) => typeof (m.result.viewCount ?? m.result.view_count ?? m.result.views) === "number");
    mergedVideos.sort((a, b) => {
      if (hasViewCounts) {
        const va = Number(a.result.viewCount ?? a.result.view_count ?? a.result.views ?? 0);
        const vb = Number(b.result.viewCount ?? b.result.view_count ?? b.result.views ?? 0);
        if (vb !== va) return vb - va;
      }
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      return a.firstIndex - b.firstIndex;
    });
    const videos = mergedVideos.slice(0, 5).map(({ result: r }) => ({
      videoId: (r.id ?? r.videoId)!,
      title: r.title ?? "YouTube clip",
      channel: r.channel ?? r.channelTitle ?? "",
      thumbnailUrl: r.thumbnail ?? r.thumbnailUrl ?? "",
      viewCount: Number(r.viewCount ?? r.view_count ?? r.views ?? 0),
      durationSec: r.duration_seconds ?? r.durationSec ?? parseDurationSec(r.duration),
    }));

    // ── Images: filter, dedupe by exact URL, rank, then cap results per source domain
    const byImageUrl = new Map<string, { result: RawImageResult; hitCount: number; firstIndex: number }>();
    let imgOrder = 0;
    for (const results of imageSearchResults) {
      for (const r of results) {
        if (!r.imageUrl || !IMAGE_EXT_RE.test(r.imageUrl)) continue;
        if (!r.title || !r.title.trim()) continue;
        const existing = byImageUrl.get(r.imageUrl);
        if (existing) existing.hitCount += 1;
        else byImageUrl.set(r.imageUrl, { result: r, hitCount: 1, firstIndex: imgOrder++ });
      }
    }
    const mergedImages = Array.from(byImageUrl.values()).sort((a, b) => {
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      const aLandscape = (a.result.imageWidth ?? 0) >= (a.result.imageHeight ?? 0) ? 1 : 0;
      const bLandscape = (b.result.imageWidth ?? 0) >= (b.result.imageHeight ?? 0) ? 1 : 0;
      if (bLandscape !== aLandscape) return bLandscape - aLandscape;
      return a.firstIndex - b.firstIndex;
    });
    const MAX_PER_DOMAIN = 2;
    const domainCounts = new Map<string, number>();
    const images: Array<{ imageUrl: string; title: string; sourceUrl: string; width?: number; height?: number }> = [];
    for (const { result: r } of mergedImages) {
      if (images.length >= 5) break;
      const domain = hostnameOf(r.link ?? r.source ?? r.domain ?? r.imageUrl!);
      const count = domainCounts.get(domain) ?? 0;
      if (count >= MAX_PER_DOMAIN) continue;
      domainCounts.set(domain, count + 1);
      images.push({
        imageUrl: r.imageUrl!,
        title: r.title!.slice(0, 120),
        sourceUrl: r.link ?? r.source ?? "",
        width: r.imageWidth,
        height: r.imageHeight,
      });
    }

    return NextResponse.json({ videos, images, videoQueries, imageQueries });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
