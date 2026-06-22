import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const railwayUrl = process.env.RAILWAY_URL ?? process.env.NEXT_PUBLIC_RAILWAY_URL ?? "";
  const password = process.env.NEURALBOARD_PASSWORD ?? "";
  if (!railwayUrl) return NextResponse.json({ error: "Not configured" }, { status: 500 });

  try {
    const body = await req.json();
    const res = await fetch(`${railwayUrl}/video-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-neuralboard-password": password },
      body: JSON.stringify(body),
    });
    if (!res.ok) return NextResponse.json({ error: `Search failed (${res.status})` }, { status: res.status });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
