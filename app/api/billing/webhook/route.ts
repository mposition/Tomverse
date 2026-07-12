export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import { processStripeEvent } from "@/lib/stripeWebhookProcessing";

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) {
    return NextResponse.json(
      { error: "Stripe webhook is not configured." },
      { status: 503 }
    );
  }

  let event: Stripe.Event;
  let logId: string | null = null;
  try {
    const rawBody = await req.text();
    event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
    const log = await prisma.stripeWebhookEventLog.upsert({
      where: { stripeEventId: event.id },
      create: {
        stripeEventId: event.id,
        eventType: event.type,
        status: "received",
        payloadSummary: {
          object: event.data.object.object,
          livemode: event.livemode,
        },
      },
      update: {
        eventType: event.type,
        status: "received",
        error: null,
        receivedAt: new Date(),
        payloadSummary: {
          object: event.data.object.object,
          livemode: event.livemode,
        },
      },
    });
    logId = log.id;
  } catch (error) {
    console.error("Invalid Stripe webhook signature:", error);
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    await processStripeEvent(event);
    if (logId) {
      await prisma.stripeWebhookEventLog.update({
        where: { id: logId },
        data: { status: "processed", processedAt: new Date(), error: null },
      });
    }
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed:", error);
    if (logId) {
      await prisma.stripeWebhookEventLog
        .update({
          where: { id: logId },
          data: {
            status: "failed",
            error:
              error instanceof Error
                ? error.message.slice(0, 1_000)
                : "Unknown webhook processing error.",
          },
        })
        .catch((logError) => {
          console.error("Stripe webhook log update failed:", logError);
        });
    }
    return NextResponse.json(
      { error: "Webhook processing failed." },
      { status: 500 }
    );
  }
}
