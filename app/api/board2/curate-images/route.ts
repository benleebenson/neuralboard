import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { buildCurationExpansionPrompt, interleaveQueryResults, parseCurationQueries } from "@/lib/board2/curation-query-plan";

export const runtime = "nodejs";
export const maxDuration = 300;

type BridgeImage = { dataUrl: string; sourceUrl: string; width: number; height: number; source: "google" | "bing" | "openverse" };
type CuratedImage = BridgeImage & { query: string; category: string };

function isBridgeImage(value: unknown): value is BridgeImage {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<BridgeImage>;
  return typeof image.dataUrl === "string" && image.dataUrl.startsWith("data:image/") &&
    typeof image.sourceUrl === "string" && /^https?:\/\//.test(image.sourceUrl) &&
    Number.isFinite(image.width) && Number.isFinite(image.height) &&
    (image.source === "google" || image.source === "bing" || image.source === "openverse");
}

async function bridgeSearch(bridgeUrl: string, password: string, query: string): Promise<BridgeImage[]> {
  const response = await fetch(`${bridgeUrl}/find-images`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-neuralboard-password": password },
    body: JSON.stringify({ query, count: 2 }),
    cache: "no-store",
    signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json().catch(() => null) as { images?: unknown[]; error?: string } | null;
  if (!response.ok) throw new Error(data?.error || `Image search failed (${response.status})`);
  return Array.isArray(data?.images) ? data.images.filter(isBridgeImage).slice(0, 2) : [];
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!await isUserPro(session)) return NextResponse.json({ error: "Pro subscription required" }, { status: 403 });

  try {
    const body = await req.json().catch(() => null) as { topic?: unknown } | null;
    const topic = typeof body?.topic === "string" ? body.topic.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    if (!topic) return NextResponse.json({ error: "topic is required" }, { status: 400 });
    const key = process.env.OPENAI_API_KEY;
    if (!key) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
    const bridgeUrl = (process.env.RAILWAY_URL ?? process.env.NEXT_PUBLIC_RAILWAY_URL ?? "").replace(/\/$/, "");
    const password = process.env.NEURALBOARD_PASSWORD ?? "";
    if (!bridgeUrl || !password) return NextResponse.json({ error: "Image finder bridge is not configured" }, { status: 500 });

    const prompt = buildCurationExpansionPrompt(topic);
    const llmResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-5-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const llmData = await llmResponse.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } } | null;
    if (!llmResponse.ok) throw new Error(llmData?.error?.message || `Topic expansion failed (${llmResponse.status})`);
    const content = llmData?.choices?.[0]?.message?.content;
    const queries = parseCurationQueries(typeof content === "string" ? JSON.parse(content) : null);
    if (queries.length < 5) throw new Error("Topic expansion did not produce enough varied searches");

    const groups: CuratedImage[][] = new Array(queries.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, queries.length) }, async () => {
      while (next < queries.length) {
        const index = next++;
        const plan = queries[index];
        try {
          groups[index] = (await bridgeSearch(bridgeUrl, password, plan.query)).map((image) => ({ ...image, ...plan }));
        } catch (error) {
          console.warn("[asset-curation] search failed", { query: plan.query, error: error instanceof Error ? error.message : String(error) });
          groups[index] = [];
        }
      }
    }));
    const images = interleaveQueryResults(groups).slice(0, 24);
    if (!images.length) throw new Error("No images were found for the expanded searches");
    return NextResponse.json({ ok: true, topic, queries, images });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not expand this topic" }, { status: 502 });
  }
}
