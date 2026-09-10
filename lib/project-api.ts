import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { CLOUD_UNAVAILABLE } from "@/lib/projects";

export function cloudDeadline<T>(operation: PromiseLike<T>): Promise<T> {
  return Promise.race([
    Promise.resolve(operation),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(CLOUD_UNAVAILABLE)), 8_000)),
  ]);
}

export async function projectOwner() {
  const session = await getServerSession(authOptions);
  return session?.user?.email?.trim().toLowerCase() ?? null;
}
export function cloudError(error: unknown) {
  console.error("PROJECT_CLOUD_FAIL", error);
  return NextResponse.json({ error: CLOUD_UNAVAILABLE }, { status: 503 });
}
export async function ownedProject(id: string, owner: string) {
  return cloudDeadline(getSupabase().from("projects").select("id").eq("id", id).eq("owner", owner).maybeSingle());
}
