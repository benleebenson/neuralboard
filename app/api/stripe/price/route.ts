import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export async function GET() {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    return NextResponse.json({ error: "Stripe price is not configured" }, { status: 503 });
  }

  try {
    const price = await getStripe().prices.retrieve(priceId);
    if (!price.active || price.unit_amount == null || !price.recurring) {
      return NextResponse.json({ error: "Stripe price is not an active recurring price" }, { status: 503 });
    }
    return NextResponse.json({
      unitAmount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring.interval,
    });
  } catch {
    return NextResponse.json({ error: "Stripe price is unavailable" }, { status: 503 });
  }
}
