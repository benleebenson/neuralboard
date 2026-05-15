import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isAdmin } from "@/lib/auth";
import { getRenderCount, getSubscriptionStatus } from "@/lib/supabase";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ canGenerate: false, reason: "not_logged_in" }, { status: 401 });
  }

  const email = session.user.email;

  if (isAdmin(email)) {
    return NextResponse.json({ canGenerate: true, isAdmin: true, isSubscribed: true });
  }

  const [{ isSubscribed, status }, renderCount] = await Promise.all([
    getSubscriptionStatus(email),
    getRenderCount(email),
  ]);

  if (isSubscribed) {
    return NextResponse.json({ canGenerate: true, isSubscribed: true, subscriptionStatus: status, renderCount });
  }

  return NextResponse.json({
    canGenerate: renderCount === 0,
    isAdmin: false,
    isSubscribed: false,
    subscriptionStatus: status,
    renderCount,
  });
}
