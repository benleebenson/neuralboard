import { NextRequest, NextResponse } from "next/server";
import { findUserByStripeCustomerId, updateSubscriptionByEmail } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import Stripe from "stripe";

export async function POST(req: NextRequest) {
  const stripe = getStripe();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "No signature" }, { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  async function resolveEmail(customerId: string): Promise<string | null> {
    const user = await findUserByStripeCustomerId(customerId);
    if (user) return user.email;
    // Fall back to Stripe customer email
    const customer = await stripe.customers.retrieve(customerId);
    return (customer as Stripe.Customer).email ?? null;
  }

  async function syncSubscription(sub: Stripe.Subscription, knownEmail?: string | null) {
    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const email = knownEmail ?? await resolveEmail(customerId);
    if (!email) throw new Error(`No user email found for Stripe customer ${customerId}`);
    await updateSubscriptionByEmail(email, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      subscriptionPeriodEnd: sub.items.data[0]?.current_period_end
        ? new Date(sub.items.data[0].current_period_end * 1000)
        : null,
    });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const checkout = event.data.object as Stripe.Checkout.Session;
      const subscriptionId = typeof checkout.subscription === "string"
        ? checkout.subscription
        : checkout.subscription?.id;
      if (checkout.mode === "subscription" && subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        await syncSubscription(sub, checkout.metadata?.email ?? checkout.customer_details?.email);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscription(sub);
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const email = await resolveEmail(sub.customer as string);
      if (email) {
        await updateSubscriptionByEmail(email, {
          subscriptionStatus: "canceled",
          subscriptionPeriodEnd: null,
        });
      }
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const email = await resolveEmail(inv.customer as string);
      if (email) {
        await updateSubscriptionByEmail(email, { subscriptionStatus: "past_due" });
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}
