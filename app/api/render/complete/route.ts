import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logEvent } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ ok: true }); // silently ignore — don't break the UX
  }

  const body = await req.json().catch(() => ({}));
  const { durationSeconds } = body;

  await logEvent(session.user.email, "render", durationSeconds ?? null).catch(() => {});

  return NextResponse.json({ ok: true });
}
