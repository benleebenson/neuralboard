import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, isUserPro } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { AuthoredAnimation, PoseKeyframe, normalizeAnimation, starterAnimations } from "@/lib/characterAnimations";

type AnimationRow = { id: string; name: string; data: unknown; created_at: string };

const LEGACY_WALK_KEYFRAMES = normalizeLegacyKeyframes("walk", true, [
  { t: 0, pose: { leftLegA: 0.46, rightLegA: -0.46, leftArmA: -0.32, rightArmA: 0.32, leftForeA: -0.08, rightForeA: 0.08, bodyLean: 0.04 } },
  { t: 0.33, pose: { leftLegA: 0.05, rightLegA: -0.08, leftArmA: 0.02, rightArmA: -0.02, leftForeA: 0.08, rightForeA: -0.08, headBob: -2 } },
  { t: 0.66, pose: { leftLegA: -0.46, rightLegA: 0.46, leftArmA: 0.32, rightArmA: -0.32, leftForeA: 0.08, rightForeA: -0.08, bodyLean: -0.04 } },
  { t: 1, pose: { leftLegA: 0.46, rightLegA: -0.46, leftArmA: -0.32, rightArmA: 0.32, leftForeA: -0.08, rightForeA: 0.08, bodyLean: 0.04 } },
]);

const LEGACY_SKATE_PEDAL_KEYFRAMES = normalizeLegacyKeyframes("skate-pedal", true, [
  { t: 0, pose: { leftLegA: -0.2, rightLegA: 0.65, leftArmA: -0.15, rightArmA: 0.35, leftForeA: 0.15, rightForeA: 0.2, bodyLean: -0.15 } },
  { t: 0.18, pose: { leftLegA: -0.18, rightLegA: 1.15, leftArmA: 0.1, rightArmA: 0.25, leftForeA: 0.12, rightForeA: 0.3, bodyLean: -0.18 } },
  { t: 0.36, pose: { leftLegA: -0.18, rightLegA: 0.55, leftArmA: 0.22, rightArmA: 0.02, leftForeA: 0.1, rightForeA: 0.15, bodyLean: -0.14 } },
  { t: 0.54, pose: { leftLegA: -0.22, rightLegA: -0.08, leftArmA: 0.15, rightArmA: -0.1, leftForeA: 0.08, rightForeA: 0.08, bodyLean: -0.12 } },
  { t: 0.72, pose: { leftLegA: -0.18, rightLegA: 0.45, leftArmA: -0.05, rightArmA: 0.18, leftForeA: 0.12, rightForeA: 0.18, bodyLean: -0.16 } },
  { t: 1, pose: { leftLegA: -0.2, rightLegA: 0.65, leftArmA: -0.15, rightArmA: 0.35, leftForeA: 0.15, rightForeA: 0.2, bodyLean: -0.15 } },
]);

const LEGACY_SKATE_OLLY_KEYFRAMES = normalizeLegacyKeyframes("skate-olly", false, [
  { t: 0, pose: { leftLegA: -0.22, rightLegA: -0.08, leftArmA: 0.05, rightArmA: -0.05, leftForeA: 0.25, rightForeA: 0.18, bodyLean: -0.12 } },
  { t: 0.18, pose: { leftLegA: -0.95, rightLegA: -0.88, leftArmA: 0.35, rightArmA: 0.28, leftForeA: 1.0, rightForeA: 0.95, bodyLean: -0.28 } },
  { t: 0.34, pose: { leftLegA: -0.25, rightLegA: 0.9, leftArmA: -0.65, rightArmA: 0.55, leftForeA: 0.25, rightForeA: 0.4, bodyLean: -0.05, airborneY: -40 } },
  { t: 0.52, pose: { leftLegA: -0.7, rightLegA: 0.35, leftArmA: -0.95, rightArmA: 0.85, leftForeA: 0.65, rightForeA: 0.55, bodyLean: -0.08, airborneY: -95 } },
  { t: 0.68, pose: { leftLegA: -1.05, rightLegA: -0.95, leftArmA: -1.0, rightArmA: 1.0, leftForeA: 1.1, rightForeA: 1.05, bodyLean: -0.04, airborneY: -120 } },
  { t: 0.84, pose: { leftLegA: -0.35, rightLegA: -0.25, leftArmA: -0.9, rightArmA: 0.9, leftForeA: 0.35, rightForeA: 0.3, bodyLean: -0.08, airborneY: -35 } },
  { t: 1, pose: { leftLegA: -0.65, rightLegA: -0.55, leftArmA: 0.2, rightArmA: -0.15, leftForeA: 0.8, rightForeA: 0.75, bodyLean: -0.18, airborneY: 0 } },
]);

export async function GET() {
  const supabase = getSupabase();
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
    const seedTime = new Date().toISOString();
    const starters = starterAnimations(seedTime);
    const { data: seeded, error: seedError } = await supabase
      .from("character_animations")
      .insert(starters.map((anim) => ({
        email: session.user!.email,
        name: anim.name,
        data: { ...anim, id: undefined, updatedAt: anim.createdAt },
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

  const rows = await refreshPristineStarterSeeds(data ?? [], session.user.email);
  return NextResponse.json(rows.map(rowToAnimation));
}

export async function POST(req: NextRequest) {
  const supabase = getSupabase();
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isUserPro(session))) return NextResponse.json({ error: "Pro required" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const incoming = normalizeAnimation(body.animation);
  if (!incoming) return NextResponse.json({ error: "Invalid animation" }, { status: 400 });
  const now = new Date().toISOString();

  const isDbId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(incoming.id);
  const payload = {
    email: session.user.email,
    name: incoming.name,
    data: { ...incoming, id: undefined, updatedAt: now },
  };
  const query = isDbId
    ? supabase.from("character_animations").update(payload).eq("id", incoming.id).eq("email", session.user.email)
    : supabase.from("character_animations").insert(payload);
  const { data, error } = await query.select("id,name,data,created_at").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(rowToAnimation(data));
}

export async function DELETE(req: NextRequest) {
  const supabase = getSupabase();
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

function normalizeLegacyKeyframes(name: string, loop: boolean, keyframes: Array<{ t: number; pose: Record<string, number> }>): PoseKeyframe[] {
  return normalizeAnimation({ id: `legacy_${name}`, name, loop, createdAt: "legacy", keyframes })?.keyframes ?? [];
}

function keyframesEqual(a: PoseKeyframe[], b: PoseKeyframe[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const REFRESHABLE_STARTER_NAMES = new Set(["walk", "skate-pedal", "skate-olly", "emote-thinking", "pullups-rep", "mirror-flex"]);

function starterFor(name: string, createdAt: string): AuthoredAnimation | undefined {
  return starterAnimations(createdAt).find((anim) => anim.name === name);
}

function isPristineRefreshableSeed(row: AnimationRow): boolean {
  if (!REFRESHABLE_STARTER_NAMES.has(row.name)) return false;
  const data = (row.data ?? {}) as Record<string, unknown>;
  const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : undefined;
  const anim = normalizeAnimation({ ...data, id: row.id, name: row.name, createdAt: row.created_at });
  if (!anim) return false;
  if (updatedAt === row.created_at) return true;
  if (row.name === "walk") return keyframesEqual(anim.keyframes, LEGACY_WALK_KEYFRAMES);
  if (updatedAt) return false;
  if (row.name === "emote-thinking" || row.name === "pullups-rep" || row.name === "mirror-flex") return false;
  const legacy = row.name === "skate-pedal" ? LEGACY_SKATE_PEDAL_KEYFRAMES : LEGACY_SKATE_OLLY_KEYFRAMES;
  return keyframesEqual(anim.keyframes, legacy);
}

async function refreshPristineStarterSeeds(rows: AnimationRow[], email: string): Promise<AnimationRow[]> {
  const supabase = getSupabase();
  const refreshed: AnimationRow[] = [];
  const seen = new Set(rows.map((row) => row.name));
  for (const row of rows) {
    if (!isPristineRefreshableSeed(row)) {
      refreshed.push(row);
      continue;
    }
    const starter = starterFor(row.name, row.created_at);
    if (!starter) {
      refreshed.push(row);
      continue;
    }
    const { data, error } = await supabase
      .from("character_animations")
      .update({
        data: { ...starter, id: undefined, createdAt: row.created_at, updatedAt: row.created_at },
      })
      .eq("id", row.id)
      .eq("email", email)
      .select("id,name,data,created_at")
      .single();
    refreshed.push(!error && data ? data : row);
  }
  const seedTime = new Date().toISOString();
  for (const starter of starterAnimations(seedTime)) {
    if (!REFRESHABLE_STARTER_NAMES.has(starter.name) || seen.has(starter.name)) continue;
    const { data, error } = await supabase
      .from("character_animations")
      .insert({
        email,
        name: starter.name,
        data: { ...starter, id: undefined, updatedAt: starter.createdAt },
      })
      .select("id,name,data,created_at")
      .single();
    if (!error && data) refreshed.push(data);
  }
  return refreshed;
}

function rowToAnimation(row: AnimationRow) {
  const data = (row.data ?? {}) as Record<string, unknown>;
  return normalizeAnimation({
    ...data,
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : row.created_at,
  });
}
