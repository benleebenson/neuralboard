import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const railwayUrl = process.env.RAILWAY_URL ?? process.env.NEXT_PUBLIC_RAILWAY_URL ?? "";
  const password = process.env.NEURALBOARD_PASSWORD ?? "";
  if (!railwayUrl) return NextResponse.json({ error: "Not configured" }, { status: 500 });

  try {
    const raw = await req.json();
    const query = typeof raw.query === "string" ? raw.query.slice(0, 200) : "";
    const limit = typeof raw.limit === "number" ? Math.min(raw.limit, 20) : 12;
    const shortsOnly = !!raw.shortsOnly;
    if (!query) return NextResponse.json({ error: "Missing query" }, { status: 400 });

    const res = await fetch(`${railwayUrl}/video-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-neuralboard-password": password },
      body: JSON.stringify({ query, limit, shortsOnly }),
    });
    if (!res.ok) return NextResponse.json({ error: `Search failed (${res.status})` }, { status: res.status });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
