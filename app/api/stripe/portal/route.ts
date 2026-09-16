import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  const stripe = getStripe();
  const supabase = getSupabase();
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data } = await supabase
    .from("nb_users")
    .select("stripe_customer_id")
    .eq("email", session.user.email)
    .single();

  if (!data?.stripe_customer_id) {
    return NextResponse.json({ error: "No subscription found" }, { status: 404 });
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: data.stripe_customer_id,
    return_url: `${process.env.NEXTAUTH_URL ?? req.nextUrl.origin}/upgrade`,
  });

  return NextResponse.json({ url: portalSession.url });
}
