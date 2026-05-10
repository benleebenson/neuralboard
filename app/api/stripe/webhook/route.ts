import { NextRequest, NextResponse } from "next/server";
import { findUserByStripeCustomerId, updateSubscriptionByEmail } from "@/lib/supabase";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export const config = { api: { bodyParser: false } };

export async function POST(req: NextRequest) {
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

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const email = await resolveEmail(sub.customer as string);
      if (email) {
        await updateSubscriptionByEmail(email, {
          stripeCustomerId: sub.customer as string,
          stripeSubscriptionId: sub.id,
          subscriptionStatus: sub.status,
          subscriptionPeriodEnd: new Date(sub.current_period_end * 1000),
        });
      }
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
