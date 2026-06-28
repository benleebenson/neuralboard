import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isAdmin, isUserPro } from "@/lib/auth";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;
  const isPro = await isUserPro(session);
  return NextResponse.json({ email, isPro, isAdmin: isAdmin(email) });
}
