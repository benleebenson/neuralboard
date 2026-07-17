import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { STREAM_OWNER_USER_ID } from "@/app/board2/config";
import { authOptions } from "@/lib/auth";
import type { StreamSnapshotMessage } from "@/lib/stream";

const STREAM_OWNER_EMAIL = process.env.STREAM_OWNER_EMAIL ?? process.env.NEXT_PUBLIC_STREAM_OWNER_EMAIL ?? "";

type StreamStore = {
  live: boolean;
  snapshot: StreamSnapshotMessage | null;
  updatedAt: number;
};

const globalStore = globalThis as typeof globalThis & { __nbStreamSnapshots?: Map<string, StreamStore> };
const stores = globalStore.__nbStreamSnapshots ?? new Map<string, StreamStore>();
globalStore.__nbStreamSnapshots = stores;

function canPublish(email?: string | null): boolean {
  if (!email) return false;
  return STREAM_OWNER_USER_ID === "owner" || email === STREAM_OWNER_USER_ID || (!!STREAM_OWNER_EMAIL && email === STREAM_OWNER_EMAIL);
}

export async function GET(req: NextRequest) {
  const streamId = req.nextUrl.searchParams.get("streamId") || STREAM_OWNER_USER_ID;
  const store = stores.get(streamId);
  return NextResponse.json({
    live: !!store?.live,
    snapshot: store?.live ? store.snapshot : null,
    updatedAt: store?.updatedAt ?? 0,
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!canPublish(session?.user?.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const streamId = String(body.streamId || STREAM_OWNER_USER_ID);
  if (body.kind === "session-end") {
    const existing = stores.get(streamId);
    stores.set(streamId, { live: false, snapshot: existing?.snapshot ?? null, updatedAt: Date.now() });
    return NextResponse.json({ ok: true });
  }

  if (body.kind !== "snapshot") {
    return NextResponse.json({ error: "Expected snapshot" }, { status: 400 });
  }

  stores.set(streamId, { live: true, snapshot: body as StreamSnapshotMessage, updatedAt: Date.now() });
  return NextResponse.json({ ok: true });
}
