import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { updateSubscriptionByEmail } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";

export async function POST(req: NextRequest) {
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

  // A stale local entitlement must never let a customer buy the same plan twice.
  const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
  const existingSubscription = subscriptions.data.find((subscription) =>
    !["canceled", "incomplete", "incomplete_expired"].includes(subscription.status),
  );
  const appUrl = process.env.NEXTAUTH_URL ?? req.nextUrl.origin;
  if (existingSubscription) {
    await updateSubscriptionByEmail(email, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: existingSubscription.id,
      subscriptionStatus: existingSubscription.status,
      subscriptionPeriodEnd: existingSubscription.items.data[0]?.current_period_end
        ? new Date(existingSubscription.items.data[0].current_period_end * 1000)
        : null,
    });
    if (["active", "trialing"].includes(existingSubscription.status)) {
      return NextResponse.json({ url: `${appUrl}/board2?upgraded=1` });
    }
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/upgrade`,
    });
    return NextResponse.json({ url: portalSession.url });
  }

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
    success_url: `${appUrl}/board2?upgraded=1`,
    cancel_url: `${appUrl}/upgrade?canceled=1`,
    metadata: { email },
  });

  return NextResponse.json({ url: checkoutSession.url });
}
