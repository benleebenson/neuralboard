import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { updateSubscriptionByEmail } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";

const APP_URL = process.env.NEXTAUTH_URL ?? "https://neuralboard-zeta.vercel.app";

export async function POST() {
  const stripe = getStripe();
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const email = session.user.email;

  // Find or create Stripe customer
  const existing = await stripe.customers.list({ email, limit: 1 });
  let customerId = existing.data[0]?.id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email });
    customerId = customer.id;
  }
  await updateSubscriptionByEmail(email, { stripeCustomerId: customerId });

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
    success_url: `${APP_URL}/board2?upgraded=1`,
    cancel_url: `${APP_URL}/upgrade`,
    metadata: { email },
  });

  return NextResponse.json({ url: checkoutSession.url });
}
