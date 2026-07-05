import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { normalizeAnimation, starterAnimations } from "@/lib/characterAnimations";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isUserPro(session))) return NextResponse.json({ error: "Pro required" }, { status: 403 });

  const { data, error } = await supabase
    .from("character_animations")
    .select("id,name,data,created_at")
    .eq("email", session.user.email)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if ((data ?? []).length === 0) {
    const starters = starterAnimations();
    const { data: seeded, error: seedError } = await supabase
      .from("character_animations")
      .insert(starters.map((anim) => ({
        email: session.user!.email,
        name: anim.name,
        data: { ...anim, id: undefined },
      })))
      .select("id,name,data,created_at")
      .order("created_at", { ascending: true });

    if (!seedError && seeded) {
      return NextResponse.json(seeded.map(rowToAnimation));
    }

    return NextResponse.json({
      animations: starters,
      seedWarning: seedError?.message ?? "Starter animations are in-memory only.",
    });
  }

  return NextResponse.json((data ?? []).map(rowToAnimation));
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isUserPro(session))) return NextResponse.json({ error: "Pro required" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const incoming = normalizeAnimation(body.animation);
  if (!incoming) return NextResponse.json({ error: "Invalid animation" }, { status: 400 });

  const isDbId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(incoming.id);
  const payload = {
    email: session.user.email,
    name: incoming.name,
    data: { ...incoming, id: undefined },
  };
  const query = isDbId
    ? supabase.from("character_animations").update(payload).eq("id", incoming.id).eq("email", session.user.email)
    : supabase.from("character_animations").insert(payload);
  const { data, error } = await query.select("id,name,data,created_at").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(rowToAnimation(data));
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isUserPro(session))) return NextResponse.json({ error: "Pro required" }, { status: 403 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const { error } = await supabase
    .from("character_animations")
    .delete()
    .eq("id", id)
    .eq("email", session.user.email);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

function rowToAnimation(row: { id: string; name: string; data: unknown; created_at: string }) {
  const data = (row.data ?? {}) as Record<string, unknown>;
  return normalizeAnimation({
    ...data,
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  });
}
