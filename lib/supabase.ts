import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabase = createClient(url, key);

export async function upsertUser(
  email: string,
  name?: string | null,
  image?: string | null,
  isAdmin?: boolean
) {
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

// ── Subscriptions ───────────────────────────────────────────────────

export async function getSubscriptionStatus(email: string) {
  const { data } = await supabase
    .from("nb_users")
    .select("subscription_status, subscription_period_end")
    .eq("email", email)
    .single();
  const isActive =
    data?.subscription_status === "active" &&
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
  const patch: Record<string, unknown> = {};
  if (updates.stripeCustomerId !== undefined) patch.stripe_customer_id = updates.stripeCustomerId;
  if (updates.stripeSubscriptionId !== undefined) patch.stripe_subscription_id = updates.stripeSubscriptionId;
  if (updates.subscriptionStatus !== undefined) patch.subscription_status = updates.subscriptionStatus;
  if (updates.subscriptionPeriodEnd !== undefined)
    patch.subscription_period_end = updates.subscriptionPeriodEnd?.toISOString() ?? null;
  await supabase.from("nb_users").upsert({ email, ...patch }, { onConflict: "email" });
}

export async function findUserByStripeCustomerId(customerId: string) {
  const { data } = await supabase
    .from("nb_users")
    .select("email")
    .eq("stripe_customer_id", customerId)
    .single();
  return data ?? null;
}

// ── API cost tracking ───────────────────────────────────────────────

export async function logApiCost(
  email: string,
  api: string,
  costUsd: number,
  meta: { model?: string; units?: number } = {}
) {
  await supabase.from("nb_api_costs").insert({
    email,
    api,
    cost_usd: costUsd,
    model: meta.model ?? null,
    units: meta.units ?? null,
  });
}

export async function getTotalCostPerUser(): Promise<Record<string, number>> {
  const { data } = await supabase.from("nb_api_costs").select("email, cost_usd");
  const totals: Record<string, number> = {};
  for (const row of data ?? []) {
    totals[row.email] = +(((totals[row.email] ?? 0) + row.cost_usd).toFixed(5));
  }
  return totals;
}

export async function getRecentApiCosts(limit = 200) {
  const { data } = await supabase
    .from("nb_api_costs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}
