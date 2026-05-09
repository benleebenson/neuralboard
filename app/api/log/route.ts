import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logEvent } from "@/lib/supabase";

const ALLOWED_EVENTS = ["download", "transcribe"] as const;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ ok: true });
  }

  const body = await req.json().catch(() => ({}));
  const { event, durationSeconds } = body;

  if (ALLOWED_EVENTS.includes(event)) {
    await logEvent(session.user.email, event, durationSeconds ?? null).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
