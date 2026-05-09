import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    railwayUrl: process.env.RAILWAY_URL ?? "",
    railwayPassword: process.env.NEURALBOARD_PASSWORD ?? "",
  });
}
