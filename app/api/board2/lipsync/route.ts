import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { lipSyncBridgeHttpError, lipSyncBridgeRequestError } from "@/lib/board2/generation-feedback";

export const runtime = "nodejs";
export const maxDuration = 180;

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
      return NextResponse.json({ error: "Lip sync bridge is not configured" }, { status: 500 });
    }

    const formData = await req.formData();
    const audioFile = formData.get("audio");
    if (!(audioFile instanceof File) || audioFile.size === 0) {
      return NextResponse.json({ error: "No audio file provided" }, { status: 400 });
    }
    if (audioFile.size > 100 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large (max 100MB)" }, { status: 413 });
    }

    const bridgeResponse = await fetch(`${bridgeUrl}/lipsync`, {
      method: "POST",
      headers: {
        "Content-Type": audioFile.type || "application/octet-stream",
        "x-neuralboard-password": password,
        "x-audio-filename": audioFile.name || "narration",
      },
      body: await audioFile.arrayBuffer(),
      cache: "no-store",
    });
    const data: unknown = await bridgeResponse.json().catch(() => null);
    if (!bridgeResponse.ok) {
      return NextResponse.json(
        { error: lipSyncBridgeHttpError(bridgeResponse.status, bridgeResponse.statusText, data) },
        { status: bridgeResponse.status },
      );
    }
    if (!Array.isArray(data)) {
      return NextResponse.json({ error: "Bridge returned an invalid lip sync response" }, { status: 502 });
    }
    return NextResponse.json(data);
  } catch (error: unknown) {
    const failure = lipSyncBridgeRequestError(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}
