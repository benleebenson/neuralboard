import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";

export const runtime = "nodejs";
// The linked Vercel project allows 300-second Fluid Compute invocations. Leave
// 20 seconds for auth, response parsing, and serialization around the bridge.
export const maxDuration = 300;

const BRIDGE_REQUEST_TIMEOUT_MS = 280_000;

type BridgeImage = {
  dataUrl: string;
  sourceUrl: string;
  width: number;
  height: number;
  source: "google" | "bing" | "openverse";
};

type BridgeFailure = {
  source: "google" | "bing" | "openverse";
  code: string;
  message: string;
};

function isBridgeImage(value: unknown): value is BridgeImage {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<BridgeImage>;
  return typeof image.dataUrl === "string" && image.dataUrl.startsWith("data:image/") &&
    typeof image.sourceUrl === "string" && /^https?:\/\//.test(image.sourceUrl) &&
    Number.isFinite(image.width) && Number.isFinite(image.height) &&
    (image.source === "google" || image.source === "bing" || image.source === "openverse");
}

function isBridgeFailure(value: unknown): value is BridgeFailure {
  if (!value || typeof value !== "object") return false;
  const failure = value as Partial<BridgeFailure>;
  return (failure.source === "google" || failure.source === "bing" || failure.source === "openverse") &&
    typeof failure.code === "string" && typeof failure.message === "string";
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

    const bridgeUrl = (process.env.RAILWAY_URL ?? process.env.NEXT_PUBLIC_RAILWAY_URL ?? "").replace(/\/$/, "");
    const password = process.env.NEURALBOARD_PASSWORD ?? "";
    if (!bridgeUrl || !password) {
      return NextResponse.json({ error: "Image finder bridge is not configured" }, { status: 500 });
    }

    const raw: unknown = await req.json();
    const body = raw && typeof raw === "object" ? raw as { query?: unknown; count?: unknown } : {};
    const query = typeof body.query === "string" ? body.query.trim().slice(0, 200) : "";
    const count = typeof body.count === "number" && Number.isInteger(body.count)
      ? Math.min(3, Math.max(1, body.count))
      : 1;
    if (!query) return NextResponse.json({ error: "query is required" }, { status: 400 });

    const bridgeResponse = await fetch(`${bridgeUrl}/find-images`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-neuralboard-password": password,
      },
      body: JSON.stringify({ query, count }),
      cache: "no-store",
      signal: AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS),
    });
    const data: unknown = await bridgeResponse.json().catch(() => null);
    if (!bridgeResponse.ok) {
      const bridgeError = data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `Image finder bridge failed (${bridgeResponse.status})`;
      const code = data && typeof data === "object" && "code" in data
        ? String((data as { code: unknown }).code)
        : undefined;
      return NextResponse.json({ error: bridgeError, code }, { status: bridgeResponse.status });
    }
    const images = data && typeof data === "object" && "images" in data && Array.isArray((data as { images: unknown }).images)
      ? (data as { images: unknown[] }).images.filter(isBridgeImage).slice(0, count)
      : [];
    const failures = data && typeof data === "object" && "failures" in data && Array.isArray((data as { failures: unknown }).failures)
      ? (data as { failures: unknown[] }).failures.filter(isBridgeFailure)
      : [];
    return NextResponse.json({ ok: true, query, images, failures });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Image finder request failed";
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json({
      error: timeout
        ? `Image finder bridge timed out after ${Math.round(BRIDGE_REQUEST_TIMEOUT_MS / 1_000)} seconds`
        : `Image finder bridge request failed: ${message}`,
      code: timeout ? "timeout" : "bridge_unreachable",
    }, { status: timeout ? 504 : 502 });
  }
}
