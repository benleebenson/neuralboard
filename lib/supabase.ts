import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ── Tables ───────────────────────────────────────────────────────────
// nb_users      — one row per email; subscription/Stripe state, last_seen.
// nb_events     — event log: login | transcribe | render | download.
// nb_api_costs  — per-call API cost tracking (Whisper, GPT-4o-mini, Serper, Claude, ...).
// nb_assets     — images/YouTube clips a user has placed on a board, kept for reuse in the
//                 board2 Library panel. Schema (see supabase-schema.sql for the runnable SQL):
//                   id uuid primary key default gen_random_uuid()
//                   email text not null
//                   type text not null              -- 'image' | 'youtube'
//                   url text                        -- image src; null for youtube
//                   thumbnail_url text               -- image src, or youtube mqdefault thumbnail
//                   youtube_id text                  -- youtube only
//                   yt_start numeric                 -- youtube only, seconds
//                   yt_end numeric                   -- youtube only, seconds
//                   label text                        -- optional display name/caption
//                   source text                       -- 'auto-build' | 'manual' | 'top5' | ...
//                   created_at timestamptz default now()
//                 Deduped per email via a unique index on (email, url) for images and
//                 (email, youtube_id, yt_start, yt_end) for youtube — see saveAsset() below.

let supabaseClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    supabaseClient = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return supabaseClient;
}

export async function upsertUser(
  email: string,
  name?: string | null,
  image?: string | null,
  isAdmin?: boolean
) {
  const supabase = getSupabase();
  const row: Record<string, unknown> = { email, name, image, last_seen: new Date().toISOString() };
  if (isAdmin) row.is_admin = true;
  console.log("UPSERT: called with email =", email, "| isAdmin =", isAdmin, "| row =", JSON.stringify(row));
  console.log("UPSERT: SUPABASE_URL =", process.env.SUPABASE_URL ?? "(undefined)");
  console.log("UPSERT: SUPABASE_SERVICE_ROLE_KEY set =", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.from("nb_users").upsert(row, { onConflict: "email" }).select();
  console.log("UPSERT: response data =", JSON.stringify(data), "| error =", JSON.stringify(error));
  if (error) throw error;
}

export async function logEvent(
  email: string,
  eventType: "login" | "transcribe" | "render" | "download",
  durationSeconds?: number | null,
  meta: Record<string, unknown> = {}
) {
  const supabase = getSupabase();
  const { error } = await supabase.from("nb_events").insert({
    email,
    event: eventType,
    duration_seconds: durationSeconds ?? null,
    meta,
  });
  if (error) console.error("LOGEVENT_FAIL:", error.message, "for", email, "event", eventType);
}

export async function getRenderCount(email: string): Promise<number> {
  const supabase = getSupabase();
  const { count } = await supabase
    .from("nb_events")
    .select("*", { count: "exact", head: true })
    .eq("email", email)
    .eq("event", "render");
  console.log("RENDER_COUNT:", email, "→", count);
  return count ?? 0;
}

export async function getDownloadCount(email: string): Promise<number> {
  const supabase = getSupabase();
  const { count } = await supabase
    .from("nb_events")
    .select("*", { count: "exact", head: true })
    .eq("email", email)
    .eq("event", "download");
  return count ?? 0;
}

export async function getAllUsers() {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("nb_users")
    .select("*")
    .order("last_seen", { ascending: false });
  return data ?? [];
}

export async function getRecentEvents(limit = 200) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("nb_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

// ── Subscriptions ───────────────────────────────────────────────────

export async function getSubscriptionStatus(email: string) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("nb_users")
    .select("subscription_status, subscription_period_end")
    .eq("email", email)
    .single();
  const isActive =
    (data?.subscription_status === "active" || data?.subscription_status === "trialing") &&
    (!data.subscription_period_end || new Date(data.subscription_period_end) > new Date());
  return { isSubscribed: isActive, status: data?.subscription_status ?? null };
}

export async function updateSubscriptionByEmail(
  email: string,
  updates: {
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    subscriptionStatus?: string | null;
    subscriptionPeriodEnd?: Date | null;
  }
) {
  const supabase = getSupabase();
  const patch: Record<string, unknown> = {};
  if (updates.stripeCustomerId !== undefined) patch.stripe_customer_id = updates.stripeCustomerId;
  if (updates.stripeSubscriptionId !== undefined) patch.stripe_subscription_id = updates.stripeSubscriptionId;
  if (updates.subscriptionStatus !== undefined) patch.subscription_status = updates.subscriptionStatus;
  if (updates.subscriptionPeriodEnd !== undefined)
    patch.subscription_period_end = updates.subscriptionPeriodEnd?.toISOString() ?? null;
  const { error } = await supabase.from("nb_users").upsert({ email, ...patch }, { onConflict: "email" });
  if (error) throw new Error(`Failed to update subscription for ${email}: ${error.message}`);
}

export async function findUserByStripeCustomerId(customerId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("nb_users")
    .select("email")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (error) throw new Error(`Failed to find Stripe customer ${customerId}: ${error.message}`);
  return data ?? null;
}

// ── API cost tracking ───────────────────────────────────────────────

export async function logApiCost(
  email: string,
  api: string,
  costUsd: number,
  meta: { model?: string; units?: number } = {}
) {
  const supabase = getSupabase();
  await supabase.from("nb_api_costs").insert({
    email,
    api,
    cost_usd: costUsd,
    model: meta.model ?? null,
    units: meta.units ?? null,
  });
}

export async function getTotalCostPerUser(): Promise<Record<string, number>> {
  const supabase = getSupabase();
  const { data } = await supabase.from("nb_api_costs").select("email, cost_usd");
  const totals: Record<string, number> = {};
  for (const row of data ?? []) {
    totals[row.email] = +(((totals[row.email] ?? 0) + row.cost_usd).toFixed(5));
  }
  return totals;
}

export async function getRecentApiCosts(limit = 200) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("nb_api_costs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

// ── Asset library ───────────────────────────────────────────────────

export type AssetType = "image" | "youtube";

export type AssetInput = {
  type: AssetType;
  url?: string | null;
  thumbnailUrl?: string | null;
  youtubeId?: string | null;
  ytStart?: number | null;
  ytEnd?: number | null;
  label?: string | null;
  source?: string | null;
  description?: string | null;
  embedding?: number[] | null;
  storagePath?: string | null;
  isIntro?: boolean;
};

// Deduped per email: images on (email, url), YouTube clips on (email, youtube_id, yt_start,
// yt_end) — see the plain (non-partial) unique indexes in supabase-schema.sql. Postgres never
// treats NULL as equal to NULL in a unique index, so image rows (youtube_id/yt_start/yt_end all
// null) never collide under the youtube index and vice versa — one upsert call covers both types.
export async function saveAsset(email: string, asset: AssetInput) {
  const supabase = getSupabase();
  const row = {
    email,
    type: asset.type,
    url: asset.url ?? null,
    thumbnail_url: asset.thumbnailUrl ?? null,
    youtube_id: asset.youtubeId ?? null,
    yt_start: asset.ytStart ?? null,
    yt_end: asset.ytEnd ?? null,
    label: asset.label ?? null,
    source: asset.source ?? null,
    description: asset.description ?? null,
    embedding: asset.embedding ?? null,
    storage_path: asset.storagePath ?? null,
    is_intro: asset.isIntro ?? false,
  };
  const onConflict = asset.storagePath ? "email,storage_path" : asset.type === "image" ? "email,url" : "email,youtube_id,yt_start,yt_end";
  const { data, error } = await supabase.from("nb_assets").upsert(row, { onConflict }).select().single();
  if (error) throw error;
  return data;
}

export async function setIntroAsset(email: string, id: string) {
  const supabase = getSupabase();
  const { error: clearError } = await supabase.from("nb_assets").update({ is_intro: false }).eq("email", email).eq("type", "image");
  if (clearError) throw clearError;
  const { data, error } = await supabase.from("nb_assets").update({ is_intro: true }).eq("email", email).eq("id", id).eq("type", "image").select().single();
  if (error) throw error;
  return data;
}

export async function listAssets(email: string, type?: AssetType, limit = 200) {
  const supabase = getSupabase();
  let query = supabase.from("nb_assets").select("*").eq("email", email).order("created_at", { ascending: false }).limit(limit);
  if (type) query = query.eq("type", type);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}
