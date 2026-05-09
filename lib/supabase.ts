import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabase = createClient(url, key);

export async function upsertUser(
  email: string,
  name?: string | null,
  image?: string | null
) {
  await supabase.from("nb_users").upsert(
    { email, name, image, last_seen: new Date().toISOString() },
    { onConflict: "email" }
  );
}

export async function logEvent(
  email: string,
  event: "login" | "transcribe" | "render" | "download",
  durationSeconds?: number | null,
  meta: Record<string, unknown> = {}
) {
  await supabase.from("nb_events").insert({
    email,
    event,
    duration_seconds: durationSeconds ?? null,
    meta,
  });
}

export async function getRenderCount(email: string): Promise<number> {
  const { count } = await supabase
    .from("nb_events")
    .select("*", { count: "exact", head: true })
    .eq("email", email)
    .eq("event", "render");
  return count ?? 0;
}

export async function getAllUsers() {
  const { data } = await supabase
    .from("nb_users")
    .select("*")
    .order("last_seen", { ascending: false });
  return data ?? [];
}

export async function getRecentEvents(limit = 200) {
  const { data } = await supabase
    .from("nb_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}
