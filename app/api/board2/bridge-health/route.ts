import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 15;

const BRIDGE_HEALTH_TIMEOUT_MS = 6_000;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bridgeUrl = (process.env.RAILWAY_URL ?? process.env.NEXT_PUBLIC_RAILWAY_URL ?? "").replace(/\/$/, "");
  const password = process.env.NEURALBOARD_PASSWORD ?? "";
  if (!bridgeUrl || !password) {
    return NextResponse.json({ ok: false, error: "Image finder bridge is not configured", code: "not_configured" }, { status: 500 });
  }

  try {
    const bridgeResponse = await fetch(`${bridgeUrl}/health`, {
      method: "GET",
      headers: { "x-neuralboard-password": password },
      cache: "no-store",
      signal: AbortSignal.timeout(BRIDGE_HEALTH_TIMEOUT_MS),
    });
    if (!bridgeResponse.ok) {
      return NextResponse.json(
        { ok: false, error: `Bridge health check failed (${bridgeResponse.status})`, code: "bridge_unreachable" },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json({
      ok: false,
      error: timeout
        ? `Bridge health check timed out after ${Math.round(BRIDGE_HEALTH_TIMEOUT_MS / 1_000)} seconds`
        : "Could not reach the image finder bridge",
      code: timeout ? "timeout" : "bridge_unreachable",
    }, { status: timeout ? 504 : 502 });
  }
}
